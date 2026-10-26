// 測試用：記憶體裡的假鏈（CopyTracker 自動同步版＋StrategyRegistry 的最小模型），
// 外面包一層 ethers.AbstractProvider，讓 chain.ts、guard.ts、keeper 的 LocalNonceSigner
// 都走真正的 ethers 編碼／簽章／廣播路徑——只有 JSON-RPC 傳輸是假的。完全離線。
//
// resyncFor 的規則照 ADR-024 規格逐條實作（存在且 active、陌生人需開啟自動同步、指定執行者、必須有新版、
// 交易者資格、冷卻、油箱、KYC／市場模式原子 revert、付小費），這樣執行者的行為是對著
// 「合約會怎麼回應」測的，而不是對著自己的假設測。
import { ethers } from "ethers";
import { COPY_TRACKER_ABI, PERPETUAL_EXCHANGE_ERRORS_ABI, STRATEGY_REGISTRY_ABI } from "./abi.ts";

export const TRACKER_ADDR = ethers.getAddress("0x" + "7c".repeat(20));
export const REGISTRY_ADDR = ethers.getAddress("0x" + "9e".repeat(20));
export const FAKE_CHAIN_ID = 31337;

const T = new ethers.Interface([...COPY_TRACKER_ABI, ...PERPETUAL_EXCHANGE_ERRORS_ABI] as unknown as string[]);
const R = new ethers.Interface(STRATEGY_REGISTRY_ABI as unknown as string[]);

export interface Alloc {
  asset: string;
  weight: bigint;
  isLong: boolean;
  leverage: bigint;
}

interface Rec {
  trader: string;
  versionId: bigint;
  initialAmount: bigint;
  positionIds: bigint[];
  copiedAt: bigint;
  active: boolean;
  deployedAmount: bigint;
}

interface StoredLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  index: number;
  transactionHash: string;
  transactionIndex: number;
}

class Revert extends Error {
  constructor(public readonly data: string) {
    super("execution reverted");
  }
}

const low = (a: string) => a.toLowerCase();
const k = (f: string, i: bigint | number) => `${low(f)}:${String(i)}`;

export class FakeChain {
  block = 100;
  time = 1_700_000_000;
  executionFee = 10n ** 14n;
  strategies = new Map<string, Alloc[][]>();
  records = new Map<string, Rec[]>();
  followersByTrader = new Map<string, string[]>();
  syncConfig = new Map<string, { autoSync: boolean; maxLeverage: number; minSyncInterval: number; tipWei: bigint }>();
  syncState = new Map<string, { lastSyncedAt: bigint; syncCount: bigint }>();
  /**
   * 合約的 syncExecFeeCap：跟隨者開啟自動同步時同意的每腿執行費。合約只接受「簽名帶入的上限 ≥ 現行費率」、
   * 記下的是現行費率；這裡假設跟隨者帶入的就是畫面上的現行費率，所以直接記開啟當下的 executionFee。
   */
  syncExecFeeCap = new Map<string, bigint>();
  /** 合約的 syncExecutor：跟隨者指定的唯一第三方執行者（小寫）；沒有就是任何人。 */
  syncExecutor = new Map<string, string>();
  gas = new Map<string, bigint>();
  eth = new Map<string, bigint>();
  kyc = new Set<string>();
  rwa = new Set<string>();
  halted = new Set<string>();
  ineligible = new Set<string>();
  logs: StoredLog[] = [];
  receipts = new Map<string, { status: number; logs: StoredLog[]; from: string; to: string; blockNumber: number; gasUsed: bigint }>();
  nonces = new Map<string, number>();
  nextPositionId = 1n;
  /** 呼叫紀錄（測試斷言用）。 */
  calls: string[] = [];
  /** 送出的交易先不上鏈（模擬等確認逾時）。 */
  holdTxs = false;
  held: Array<() => void> = [];
  /** 這段區塊範圍內的 getLogs 一律失敗（模擬節點故障）。 */
  failLogsAt: number | null = null;
  logsRangeLimit = 200;

  mine(seconds = 2): void {
    this.block += 1;
    this.time += seconds;
  }

  private emit(address: string, iface: ethers.Interface, name: string, args: unknown[], tx: string, txIndex = 0): StoredLog {
    const ev = iface.encodeEventLog(name, args);
    const log: StoredLog = {
      address,
      topics: ev.topics,
      data: ev.data,
      blockNumber: this.block,
      index: this.logs.filter((l) => l.blockNumber === this.block).length,
      transactionHash: tx,
      transactionIndex: txIndex,
    };
    this.logs.push(log);
    return log;
  }

  private fakeTx(): string {
    return ethers.keccak256(ethers.toUtf8Bytes(`tx:${this.block}:${this.logs.length}:${Math.random()}`));
  }

  // ── 使用者動作（測試直接呼叫；各自出一個新區塊）─────────────────────────
  publish(trader: string, allocs: Alloc[]): number {
    this.mine();
    const list = this.strategies.get(low(trader)) ?? [];
    list.push(allocs);
    this.strategies.set(low(trader), list);
    this.emit(REGISTRY_ADDR, R, "StrategyPublished", [trader, list.length - 1, this.time], this.fakeTx());
    return list.length - 1;
  }

  follow(follower: string, trader: string, margin = 1000n * 10n ** 18n): number {
    this.mine();
    const versions = this.strategies.get(low(trader));
    if (!versions?.length) throw new Error("no strategy");
    const recs = this.records.get(low(follower)) ?? [];
    const ids = versions[versions.length - 1].map(() => this.nextPositionId++);
    recs.push({
      trader: ethers.getAddress(trader), versionId: BigInt(versions.length - 1), initialAmount: margin, positionIds: ids,
      copiedAt: BigInt(this.time), active: true, deployedAmount: (margin * 9n) / 10n,
    });
    this.records.set(low(follower), recs);
    const fl = this.followersByTrader.get(low(trader)) ?? [];
    fl.push(ethers.getAddress(follower)); // 既有合約會重複 push
    this.followersByTrader.set(low(trader), fl);
    this.emit(TRACKER_ADDR, T, "TraderFollowed", [follower, trader, versions.length - 1, margin], this.fakeTx());
    return recs.length - 1;
  }

  setAutoSync(follower: string, idx: number, enabled: boolean, opts: { maxLeverage?: number; minSyncInterval?: number; tipWei?: bigint } = {}): void {
    this.mine();
    const c = { autoSync: enabled, maxLeverage: opts.maxLeverage ?? 5, minSyncInterval: opts.minSyncInterval ?? 0, tipWei: opts.tipWei ?? 0n };
    this.syncConfig.set(k(follower, idx), c);
    this.syncExecFeeCap.set(k(follower, idx), enabled ? this.executionFee : 0n);
    this.emit(TRACKER_ADDR, T, "AutoSyncSet", [follower, idx, enabled, c.maxLeverage, c.minSyncInterval, c.tipWei], this.fakeTx());
  }

  /** 合約的 setSyncExecutor：`executor` 為 null／零位址時解除限制。 */
  setSyncExecutor(follower: string, idx: number, executor: string | null): void {
    this.mine();
    const ex = executor && low(executor) !== low(ethers.ZeroAddress) ? low(executor) : null;
    if (ex) this.syncExecutor.set(k(follower, idx), ex);
    else this.syncExecutor.delete(k(follower, idx));
    this.emit(TRACKER_ADDR, T, "SyncExecutorSet", [follower, idx, ex ?? ethers.ZeroAddress], this.fakeTx());
  }

  deposit(follower: string, amount: bigint): void {
    this.mine();
    this.gas.set(low(follower), (this.gas.get(low(follower)) ?? 0n) + amount);
    this.emit(TRACKER_ADDR, T, "SyncGasDeposited", [follower, amount], this.fakeTx());
  }

  withdraw(follower: string, amount: bigint): void {
    this.mine();
    const bal = this.gas.get(low(follower)) ?? 0n;
    if (amount > bal) throw new Error("fake withdraw: insufficient");
    this.gas.set(low(follower), bal - amount);
    this.emit(TRACKER_ADDR, T, "SyncGasWithdrawn", [follower, amount], this.fakeTx());
  }

  unfollow(follower: string, idx: number): void {
    this.mine();
    const rec = this.records.get(low(follower))![idx];
    rec.active = false;
    if (this.syncExecutor.delete(k(follower, idx))) {
      this.emit(TRACKER_ADDR, T, "SyncExecutorSet", [follower, idx, ethers.ZeroAddress], this.fakeTx());
    }
    this.emit(TRACKER_ADDR, T, "TraderUnfollowed", [follower, rec.trader, idx], this.fakeTx());
  }

  // ── 合約邏輯 ───────────────────────────────────────────────────────────
  private rec(follower: string, idx: bigint): Rec {
    const r = this.records.get(low(follower))?.[Number(idx)];
    if (!r) throw new Revert(T.encodeErrorResult("InvalidRecordIndex", []));
    return r;
  }

  /** 合約的 _syncReadyAt：上次同步（從未同步則為跟單當下）＋ minSyncInterval。 */
  readyAt(follower: string, idx: bigint | number): bigint {
    const rec = this.records.get(low(follower))![Number(idx)];
    const st = this.syncState.get(k(follower, idx)) ?? { lastSyncedAt: 0n, syncCount: 0n };
    const cfg = this.syncConfig.get(k(follower, idx));
    return (st.lastSyncedAt !== 0n ? st.lastSyncedAt : rec.copiedAt) + BigInt(cfg?.minSyncInterval ?? 0);
  }

  /** resyncFor 的檢查與效果；`apply=false` 時只檢查（eth_call／estimateGas）。 */
  resyncFor(sender: string, follower: string, idx: bigint, apply: boolean, txHash = ""): void {
    const rec = this.rec(follower, idx);
    if (!rec.active) throw new Revert(T.encodeErrorResult("RecordAlreadyInactive", []));
    const self = low(sender) === low(follower);
    const cfg = this.syncConfig.get(k(follower, idx)) ?? { autoSync: false, maxLeverage: 0, minSyncInterval: 0, tipWei: 0n };
    if (!self && !cfg.autoSync) throw new Revert(T.encodeErrorResult("AutoSyncDisabled", []));
    const designated = this.syncExecutor.get(k(follower, idx));
    if (!self && designated && designated !== low(sender)) {
      throw new Revert(T.encodeErrorResult("NotSyncExecutor", [designated]));
    }
    const versions = this.strategies.get(low(rec.trader))!;
    const latest = BigInt(versions.length - 1);
    if (latest <= rec.versionId) throw new Revert(T.encodeErrorResult("AlreadySynced", [rec.versionId, latest]));
    if (this.ineligible.has(low(rec.trader))) throw new Revert(T.encodeErrorResult("TraderNotEligible", [rec.trader]));
    const st = this.syncState.get(k(follower, idx)) ?? { lastSyncedAt: 0n, syncCount: 0n };
    const readyAt = this.readyAt(follower, idx);
    if (!self && BigInt(this.time) < readyAt) throw new Revert(T.encodeErrorResult("SyncCooldown", [readyAt]));
    // 合約：從油箱扣款時現行費率不得高於跟隨者同意的 syncExecFeeCap（本人也一樣；本人附帶的 ETH
    // 付得清全部成本才例外——這裡的呼叫一律不附 ETH）。
    const feeCap = this.syncExecFeeCap.get(k(follower, idx)) ?? 0n;
    if (this.executionFee > feeCap) {
      throw new Revert(T.encodeErrorResult("ExecutionFeeAboveCap", [this.executionFee, feeCap]));
    }
    const allocs = versions[Number(latest)];
    const tip = self ? 0n : cfg.tipWei;
    const cost = this.executionFee * BigInt(allocs.length) + tip;
    const bal = this.gas.get(low(follower)) ?? 0n;
    if (bal < cost) throw new Revert(T.encodeErrorResult("InsufficientSyncGas", [cost, bal]));
    // 原子性：任何一條新腿開不起來就整筆 revert。
    for (const a of allocs) {
      if (this.halted.has(a.asset)) throw new Revert(T.encodeErrorResult("AssetNotActive", [a.asset, 2]));
      if (this.rwa.has(a.asset) && !this.kyc.has(low(follower))) throw new Revert(T.encodeErrorResult("NotKycVerified", [follower]));
    }
    if (!apply) return;
    const from = rec.versionId;
    rec.versionId = latest;
    rec.positionIds = allocs.map(() => this.nextPositionId++);
    this.syncState.set(k(follower, idx), { lastSyncedAt: BigInt(this.time), syncCount: st.syncCount + 1n });
    this.gas.set(low(follower), bal - cost);
    this.eth.set(low(sender), (this.eth.get(low(sender)) ?? 0n) + tip);
    this.emit(TRACKER_ADDR, T, "Resynced", [follower, idx, rec.trader, from, latest, sender, rec.deployedAmount, allocs.length], txHash);
  }

  /** eth_call。 */
  call(to: string, data: string, from: string): string {
    if (low(to) === low(REGISTRY_ADDR)) {
      const d = R.parseTransaction({ data })!;
      const trader = d.args[0] as string;
      const versions = this.strategies.get(low(trader)) ?? [];
      if (d.name === "getStrategyCount") return R.encodeFunctionResult(d.name, [versions.length]);
      if (d.name === "isEligibleTrader") return R.encodeFunctionResult(d.name, [!this.ineligible.has(low(trader))]);
      throw new Error(`fake registry: ${d.name}`);
    }
    if (low(to) !== low(TRACKER_ADDR)) return "0x";
    const d = T.parseTransaction({ data })!;
    this.calls.push(d.name);
    const a = d.args;
    switch (d.name) {
      case "registry":
        return T.encodeFunctionResult(d.name, [REGISTRY_ADDR]);
      case "totalSyncGas":
        return T.encodeFunctionResult(d.name, [[...this.gas.values()].reduce((x, y) => x + y, 0n)]);
      case "syncGasBalance":
        return T.encodeFunctionResult(d.name, [this.gas.get(low(a[0])) ?? 0n]);
      case "getCopyRecords":
        return T.encodeFunctionResult(d.name, [
          (this.records.get(low(a[0])) ?? []).map((r) => [r.trader, r.versionId, r.initialAmount, r.positionIds, r.copiedAt, r.active, r.deployedAmount]),
        ]);
      case "getFollowerCount":
        return T.encodeFunctionResult(d.name, [(this.followersByTrader.get(low(a[0])) ?? []).length]);
      case "followersByTrader":
        return T.encodeFunctionResult(d.name, [this.followersByTrader.get(low(a[0]))![Number(a[1])]]);
      case "syncConfig": {
        const c = this.syncConfig.get(k(a[0], a[1])) ?? { autoSync: false, maxLeverage: 0, minSyncInterval: 0, tipWei: 0n };
        return T.encodeFunctionResult(d.name, [c.autoSync, c.maxLeverage, c.minSyncInterval, c.tipWei]);
      }
      case "syncExecutor":
        return T.encodeFunctionResult(d.name, [this.syncExecutor.get(k(a[0], a[1])) ?? ethers.ZeroAddress]);
      case "syncReadyAt":
        return T.encodeFunctionResult(d.name, [Number(a[1]) < (this.records.get(low(a[0]))?.length ?? 0) ? this.readyAt(a[0], a[1]) : 0n]);
      case "getSyncState": {
        const s = this.syncState.get(k(a[0], a[1])) ?? { lastSyncedAt: 0n, syncCount: 0n };
        return T.encodeFunctionResult(d.name, [[s.lastSyncedAt, s.syncCount, false, 0n, 0n]]);
      }
      case "resyncFor":
        this.resyncFor(from, a[0], a[1], false);
        return "0x";
      default:
        throw new Error(`fake tracker: ${d.name}`);
    }
  }

  /** 廣播：解出已簽交易、執行、出塊、記收據。 */
  broadcast(raw: string): string {
    const tx = ethers.Transaction.from(raw);
    const from = tx.from!;
    const expected = this.nonces.get(low(from)) ?? 0;
    if (tx.nonce !== expected) throw new Error(`nonce too low: expected ${expected}, got ${tx.nonce}`);
    this.nonces.set(low(from), expected + 1);
    const run = () => {
      this.mine();
      const before = this.logs.length;
      let status = 1;
      try {
        const d = T.parseTransaction({ data: tx.data })!;
        if (low(tx.to!) !== low(TRACKER_ADDR) || d.name !== "resyncFor") throw new Error("unexpected tx");
        this.resyncFor(from, d.args[0], d.args[1], true, tx.hash!);
      } catch (e) {
        if (!(e instanceof Revert)) throw e;
        status = 0;
      }
      this.receipts.set(tx.hash!, { status, logs: this.logs.slice(before), from, to: tx.to!, blockNumber: this.block, gasUsed: 150_000n });
    };
    if (this.holdTxs) {
      this.held.push(run);
      this.heldMeta.push({ from: low(from), nonce: tx.nonce });
    } else run();
    return tx.hash!;
  }

  releaseHeld(): void {
    this.heldMeta.splice(0);
    for (const f of this.held.splice(0)) f();
  }

  /** 被擋住的交易從 mempool 消失（nonce 退回去，像沒送過一樣）。 */
  dropHeld(): void {
    for (const h of this.heldMeta.splice(0)) this.nonces.set(h.from, h.nonce);
    this.held.splice(0);
  }

  heldMeta: Array<{ from: string; nonce: number }> = [];
}

const hex = (n: number | bigint) => ethers.toQuantity(n);
const ZERO32 = ethers.ZeroHash;

/** 假鏈外面的 ethers Provider：只實作執行者用得到的 JSON-RPC 方法。 */
export class FakeProvider extends ethers.AbstractProvider {
  constructor(readonly chain: FakeChain) {
    super(FAKE_CHAIN_ID, { pollingInterval: 10, cacheTimeout: -1 });
  }

  override async _detectNetwork(): Promise<ethers.Network> {
    return ethers.Network.from(FAKE_CHAIN_ID);
  }

  private blockJson() {
    const c = this.chain;
    return {
      hash: ethers.keccak256(ethers.toBeHex(c.block, 32)),
      parentHash: ZERO32,
      number: hex(c.block),
      timestamp: hex(c.time),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: hex(30_000_000),
      gasUsed: "0x0",
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: hex(1_000_000_000),
      transactions: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _perform(req: any): Promise<any> {
    const c = this.chain;
    switch (req.method) {
      case "chainId":
        return hex(FAKE_CHAIN_ID);
      case "getBlockNumber":
        return hex(c.block);
      case "getBlock":
        return this.blockJson();
      case "getGasPrice":
        return hex(1_000_000_000);
      case "getPriorityFee":
        return hex(1_000_000);
      case "getBalance":
        return hex(c.eth.get(low(req.address)) ?? 10n ** 18n);
      case "getTransactionCount":
        return hex(c.nonces.get(low(req.address)) ?? 0);
      case "call":
      case "estimateGas": {
        const t = req.transaction;
        try {
          const out = c.call(t.to, t.data ?? "0x", t.from ?? ethers.ZeroAddress);
          return req.method === "call" ? out : hex(150_000);
        } catch (e) {
          if (e instanceof Revert) {
            throw ethers.makeError("execution reverted", "CALL_EXCEPTION", {
              action: req.method === "call" ? "call" : "estimateGas",
              data: e.data,
              reason: null,
              transaction: { to: t.to, data: t.data, from: t.from },
              invocation: null,
              revert: null,
            });
          }
          throw e;
        }
      }
      case "broadcastTransaction":
        return c.broadcast(req.signedTransaction);
      case "getTransactionReceipt": {
        const r = c.receipts.get(req.hash);
        if (!r) return null;
        const blockHash = ethers.keccak256(ethers.toBeHex(r.blockNumber, 32));
        return {
          to: r.to, from: r.from, contractAddress: null, transactionIndex: "0x0", root: null, gasUsed: hex(r.gasUsed),
          logsBloom: "0x" + "00".repeat(256), blockHash, transactionHash: req.hash, blockNumber: hex(r.blockNumber),
          cumulativeGasUsed: hex(r.gasUsed), effectiveGasPrice: hex(1_001_000_000), status: hex(r.status), type: "0x2",
          logs: r.logs.map((l) => ({
            address: l.address, topics: l.topics, data: l.data, logIndex: hex(l.index), blockHash,
            blockNumber: hex(l.blockNumber), transactionHash: req.hash, transactionIndex: "0x0", removed: false,
          })),
        };
      }
      case "getTransaction":
        return null;
      case "getLogs": {
        const f = req.filter;
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        if (to - from > c.logsRangeLimit) {
          throw Object.assign(new Error("range"), { error: { code: -32614, message: `eth_getLogs is limited to a ${c.logsRangeLimit} range` } });
        }
        if (c.failLogsAt !== null && from <= c.failLogsAt && c.failLogsAt <= to) throw new Error("ECONNRESET");
        const addrs: string[] = (Array.isArray(f.address) ? f.address : [f.address]).filter(Boolean).map(low);
        const match = (want: unknown, have: string | undefined) =>
          want === null || want === undefined || (Array.isArray(want) ? want.map(low).includes(low(have ?? "")) : low(String(want)) === low(have ?? ""));
        return c.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
          .filter((l) => addrs.length === 0 || addrs.includes(low(l.address)))
          .filter((l) => (f.topics ?? []).every((t: unknown, i: number) => match(t, l.topics[i])))
          .map((l) => ({
            address: l.address, topics: l.topics, data: l.data, logIndex: hex(l.index), blockNumber: hex(l.blockNumber),
            blockHash: ethers.keccak256(ethers.toBeHex(l.blockNumber, 32)), transactionHash: l.transactionHash,
            transactionIndex: hex(l.transactionIndex), removed: false,
          }));
      }
      default:
        throw new Error(`FakeProvider: ${req.method} not implemented`);
    }
  }
}
