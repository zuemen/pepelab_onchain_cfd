// ChainReads／Executor 的 ethers v6 實作。
import { ethers } from "ethers";
import { COPY_TRACKER_ABI, STRATEGY_REGISTRY_ABI } from "./abi.ts";
import type { ChainReads, CopyRecordView, Executor, ResyncedEvent, SentTx, TxOutcome } from "./engine.ts";
import { isRevert } from "./errors.ts";
import type { LogFilter, RawLog } from "./logs.ts";

/** ethers 的 Provider 子集：測試用記憶體假節點也只需要實作這些。 */
export type ProviderLike = Pick<
  ethers.Provider,
  "getBlockNumber" | "getBlock" | "getLogs" | "call" | "estimateGas" | "getFeeData" | "waitForTransaction"
>;

export const TRACKER_IFACE = new ethers.Interface(COPY_TRACKER_ABI as unknown as string[]);
const REGISTRY_IFACE = new ethers.Interface(STRATEGY_REGISTRY_ABI as unknown as string[]);

/** 讀一個 view：自己編碼、自己解碼，不依賴 ethers.Contract 的 runner 細節（假節點只要實作 call）。 */
async function view(p: ProviderLike, to: string, iface: ethers.Interface, fn: string, args: unknown[], from?: string) {
  const data = iface.encodeFunctionData(fn, args);
  const ret = await p.call({ to, data, ...(from ? { from } : {}) });
  return iface.decodeFunctionResult(fn, ret);
}

/** followersByTrader 一次最多讀多少筆（每筆一個 eth_call；公開節點有每秒額度）。 */
export const MAX_FOLLOWERS_PER_TRADER = 2_000;

/**
 * @param opts.hasSyncExecutor tracker 有沒有 `syncExecutor`（指定執行者）。run.ts 啟動時探測一次；
 *   沒有的版本（指定執行者之前編出來的 tracker）一律視為「未指定」——那個版本本來就沒有這項限制。
 */
export function makeChainReads(p: ProviderLike, tracker: string, registry: string, opts: { hasSyncExecutor?: boolean } = {}): ChainReads {
  const hasSyncExecutor = opts.hasSyncExecutor ?? true;
  return {
    blockNumber: () => p.getBlockNumber(),
    async blockTimestamp() {
      const b = await p.getBlock("latest");
      if (!b) throw new Error("讀不到最新區塊");
      return Number(b.timestamp);
    },
    async getLogs(f: LogFilter & { fromBlock: number; toBlock: number }): Promise<RawLog[]> {
      const logs = await p.getLogs({ address: f.address, topics: f.topics, fromBlock: f.fromBlock, toBlock: f.toBlock });
      return logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        index: l.index,
        transactionHash: l.transactionHash,
      }));
    },
    async copyRecords(follower): Promise<CopyRecordView[]> {
      const [recs] = await view(p, tracker, TRACKER_IFACE, "getCopyRecords", [follower]);
      return (recs as ethers.Result[]).map((r) => ({
        trader: r[0] as string,
        versionId: r[1] as bigint,
        positionIds: [...(r[3] as bigint[])],
        active: r[5] as boolean,
        deployedAmount: r[6] as bigint,
      }));
    },
    async followersOf(trader) {
      const [n] = await view(p, tracker, TRACKER_IFACE, "getFollowerCount", [trader]);
      const count = Math.min(Number(n as bigint), MAX_FOLLOWERS_PER_TRADER);
      const seen = new Set<string>();
      for (let i = 0; i < count; i++) {
        const [f] = await view(p, tracker, TRACKER_IFACE, "followersByTrader", [trader, i]);
        seen.add((f as string).toLowerCase());
      }
      return [...seen];
    },
    async syncConfig(follower, idx) {
      const r = await view(p, tracker, TRACKER_IFACE, "syncConfig", [follower, idx]);
      let executor: string | null = null;
      if (hasSyncExecutor) {
        const [ex] = await view(p, tracker, TRACKER_IFACE, "syncExecutor", [follower, idx]);
        executor = (ex as string) === ethers.ZeroAddress ? null : (ex as string).toLowerCase();
      }
      return {
        autoSync: r[0] as boolean,
        maxLeverage: Number(r[1]),
        minSyncInterval: Number(r[2]),
        tipWei: r[3] as bigint,
        executor,
      };
    },
    async syncReadyAt(follower, idx) {
      const [t] = await view(p, tracker, TRACKER_IFACE, "syncReadyAt", [follower, idx]);
      return Number(t as bigint);
    },
    async latestVersion(_follower, _idx, trader) {
      // 直接問 registry（版本號＝策略數−1，與 getLatestStrategy 相同），不依賴 pendingSync 的回傳語意。
      const [n] = await view(p, registry, REGISTRY_IFACE, "getStrategyCount", [trader]);
      const count = n as bigint;
      return count === 0n ? null : count - 1n;
    },
  };
}

/** 從收據找出 Resynced 事件（只認 tracker 發的）。 */
export function resyncedFromLogs(logs: readonly { address: string; topics: readonly string[]; data: string }[], tracker: string): ResyncedEvent | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== tracker.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = TRACKER_IFACE.parseLog({ topics: [...l.topics], data: l.data });
    } catch {
      parsed = null;
    }
    if (parsed?.name !== "Resynced") continue;
    const a = parsed.args;
    return {
      follower: (a[0] as string).toLowerCase(),
      recordIdx: Number(a[1]),
      trader: (a[2] as string).toLowerCase(),
      fromVersion: Number(a[3]),
      toVersion: Number(a[4]),
      executor: (a[5] as string).toLowerCase(),
      redeployedMargin: a[6] as bigint,
      legs: Number(a[7]),
    };
  }
  return null;
}

function isTimeout(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown } | null;
  return x?.code === "TIMEOUT" || /timeout/i.test(String(x?.message ?? ""));
}

/**
 * 執行者。`signer` 為 null 時只能模擬（dry-run）：from 用執行者位址，沒有金鑰時用零位址
 * （零位址不是跟隨者，所以合約會照「陌生人」的規則判斷，與真正的執行者相同）。
 */
export function makeExecutor(a: {
  provider: ProviderLike;
  tracker: string;
  signer: Pick<ethers.Signer, "sendTransaction"> | null;
  address: string | null;
  /** 換一個新的 nonce 追蹤器（見 Executor.resetNonce）；回傳新的 signer。 */
  renewSigner?: () => Pick<ethers.Signer, "sendTransaction">;
}): Executor {
  const from = a.address ?? ethers.ZeroAddress;
  const data = (f: string, i: number) => TRACKER_IFACE.encodeFunctionData("resyncFor", [f, i]);
  let signer = a.signer;
  return {
    address: a.address,
    resetNonce() {
      if (signer && a.renewSigner) signer = a.renewSigner();
    },
    async simulate(f, i, as) {
      await a.provider.call({ to: a.tracker, from: as ?? from, data: data(f, i) });
    },
    async quote(f, i) {
      const gas = await a.provider.estimateGas({ to: a.tracker, from, data: data(f, i) });
      const fee = await a.provider.getFeeData();
      const gasPriceWei = fee.maxFeePerGas ?? fee.gasPrice;
      if (gasPriceWei === null || gasPriceWei === undefined) throw new Error("讀不到 gas 價格");
      return { gas, gasPriceWei };
    },
    async send(f, i, gasLimit): Promise<SentTx> {
      if (!signer) throw new Error("dry-run 沒有簽署者，不能送交易");
      const tx = await signer.sendTransaction({ to: a.tracker, data: data(f, i), value: 0n, gasLimit });
      return { hash: tx.hash };
    },
    async wait(tx, timeoutMs): Promise<TxOutcome | null> {
      let rc: ethers.TransactionReceipt | null;
      try {
        rc = await a.provider.waitForTransaction(tx.hash, 1, timeoutMs);
      } catch (e) {
        if (isTimeout(e)) return null;
        throw e;
      }
      if (!rc) return null;
      return {
        status: rc.status === 1 ? "success" : "reverted",
        resynced: rc.status === 1 ? resyncedFromLogs(rc.logs, a.tracker) : null,
        gasUsed: rc.gasUsed,
        effectiveGasPrice: rc.gasPrice ?? 0n,
      };
    },
  };
}

/**
 * 這個 CopyTracker 是不是自動同步版：讀 totalSyncGas()。舊版沒有這個函式，eth_call 會回空資料
 * 或 revert。回傳 false 時呼叫端應拒絕啟動（舊 tracker 上沒有 resyncFor 可以送）。
 */
export async function supportsAutoSync(p: ProviderLike, tracker: string): Promise<boolean> {
  try {
    await view(p, tracker, TRACKER_IFACE, "totalSyncGas", []);
    return true;
  } catch {
    return false;
  }
}

/**
 * tracker 有沒有 `syncExecutor`（指定執行者，ADR-024 第四輪審查）。回傳 false 時讀取端把每筆跟單都視為
 * 「未指定執行者」。
 */
export async function supportsSyncExecutor(p: ProviderLike, tracker: string): Promise<boolean> {
  try {
    await view(p, tracker, TRACKER_IFACE, "syncExecutor", [ethers.ZeroAddress, 0]);
    return true;
  } catch (e) {
    // 沒有這個函式：revert 或回空資料（解碼失敗）。連線錯誤照常丟出，不誤判成舊版。
    if (isRevert(e) || (e as { code?: unknown } | null)?.code === "BAD_DATA") return false;
    throw e;
  }
}

/**
 * 某個位址在這個 tracker 上的「跟隨者足跡」：跟單紀錄筆數（含已結束的）與同步油箱餘額。
 * run.ts 載入執行者金鑰後用它確認這把金鑰不是任何跟隨者的主錢包（keys.ts 的 executorFollowerError）。
 */
export async function followerFootprint(
  p: ProviderLike,
  tracker: string,
  address: string,
): Promise<{ records: number; syncGasWei: bigint }> {
  const [[recs], [gas]] = await Promise.all([
    view(p, tracker, TRACKER_IFACE, "getCopyRecords", [address]),
    view(p, tracker, TRACKER_IFACE, "syncGasBalance", [address]),
  ]);
  return { records: (recs as unknown[]).length, syncGasWei: gas as bigint };
}

/** tracker.registry()：沒給 --registry 時用它，確保監聽的就是 tracker 實際讀的那一個。 */
export async function trackerRegistry(p: ProviderLike, tracker: string): Promise<string> {
  const [r] = await view(p, tracker, TRACKER_IFACE, "registry", []);
  return ethers.getAddress(r as string);
}
