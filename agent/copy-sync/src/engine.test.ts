// 執行者的完整流程：對著記憶體假鏈（fakeChain.ts）跑 runRound。
// chain.ts 的 ethers 編碼、guard.ts 的簽章白名單、keeper 的 LocalNonceSigner 都走真的路徑；
// 只有 JSON-RPC 傳輸是假的。完全離線、不送任何交易到任何鏈。
//   cd agent && npx tsx copy-sync/src/engine.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { LocalNonceSigner } from "../../keeper/nonceSigner.ts";
import { followerFootprint, makeChainReads, makeExecutor, supportsAutoSync, trackerRegistry } from "./chain.ts";
import { buildFilter, CopySyncEngine, exitCodeOf, UNCONFIRMED_HOLD_SEC, type EngineConfig, type Executor, type RoundReport } from "./engine.ts";
import { FakeChain, FakeProvider, FAKE_CHAIN_ID, REGISTRY_ADDR, TRACKER_ADDR, type Alloc } from "./fakeChain.ts";
import { ExecutorWallet } from "./guard.ts";
import { executorFollowerError } from "./keys.ts";
import { makeRedactor, type Logger, type Redactor } from "./log.ts";
import type { NotifyPayload } from "./notify.ts";
import { emptyState, parseState, recordKey, scopeOf, type CopySyncState } from "./state.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const TRADER = ethers.getAddress("0x" + "11".repeat(20));
const TRADER2 = ethers.getAddress("0x" + "12".repeat(20));
const ALICE = ethers.getAddress("0x" + "a1".repeat(20));
const BOB = ethers.getAddress("0x" + "b0".repeat(20));
const CAROL = ethers.getAddress("0x" + "c0".repeat(20));
const BTC = ethers.id("sBTC");
const ETH = ethers.id("sETH");
const AAPL = ethers.id("sAAPL");
const alloc = (asset: string, weight = 10_000n, isLong = true, leverage = 2n): Alloc => ({ asset, weight, isLong, leverage });
const TIP = 10n ** 13n;

interface Harness {
  chain: FakeChain;
  engine: CopySyncEngine;
  state: CopySyncState;
  notes: NotifyPayload[];
  lines: string[];
  executor: string;
  saves: () => number;
  /** 最近一次 persist 寫出的狀態檔內容（與 saveState 相同的 JSON）。 */
  saved: () => string;
  round: () => Promise<RoundReport>;
}

async function harness(
  opts: Partial<EngineConfig> & {
    setup?: (c: FakeChain) => void;
    dryRun?: boolean;
    redact?: Redactor;
    wrapExec?: (e: Executor) => Executor;
  } = {},
): Promise<Harness> {
  const chain = new FakeChain();
  opts.setup?.(chain);
  const provider = new FakeProvider(chain);
  const key = ethers.Wallet.createRandom().privateKey;
  const wallet = new ExecutorWallet(key, { copyTracker: TRACKER_ADDR, chainId: FAKE_CHAIN_ID }, provider);
  const signer = opts.dryRun ? null : new LocalNonceSigner(wallet);
  const cfg: EngineConfig = {
    mode: "public",
    followers: [],
    chainId: FAKE_CHAIN_ID,
    copyTracker: TRACKER_ADDR,
    registry: REGISTRY_ADDR,
    dryRun: !!opts.dryRun,
    confirmations: 0,
    startBlock: 0,
    lookbackBlocks: 1000,
    rescanIntervalSec: 600,
    minTipWei: 0n,
    maxGasPriceWei: null,
    maxSendsPerRound: 10,
    txTimeoutMs: 200,
    ...opts,
  };
  const state = emptyState({ chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, scope: scopeOf(cfg.mode, cfg.followers) });
  const notes: NotifyPayload[] = [];
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERR ${m}`) };
  let saves = 0;
  let saved = "";
  const exec = makeExecutor({ provider, tracker: TRACKER_ADDR, signer, address: opts.dryRun ? null : wallet.address });
  const engine = new CopySyncEngine({
    cfg,
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: opts.wrapExec ? opts.wrapExec(exec) : exec,
    state,
    persist: (st) => {
      saves++;
      saved = JSON.stringify(st, null, 2);
    },
    log,
    notify: async (p) => void notes.push(p),
    sleep: async () => {},
    redact: opts.redact,
  });
  return {
    chain, engine, state, notes, lines, executor: wallet.address, saves: () => saves, saved: () => saved, round: () => engine.runRound(),
  };
}

const entry = (h: Harness, f: string, i = 0) => h.state.records[recordKey(f, i)];
const recOf = (h: Harness, f: string, i = 0) => h.chain.records.get(f.toLowerCase())![i];

// ── 1. 基本流程 ─────────────────────────────────────────────────────────────
{
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true, { tipWei: TIP });
      c.deposit(ALICE, 10n ** 16n);
      c.follow(BOB, TRADER); // 沒開自動同步
      c.follow(ALICE, TRADER); // 同一位跟隨者重複出現在 followersByTrader
    },
  });
  assert.ok(await supportsAutoSync(new FakeProvider(h.chain), TRACKER_ADDR));
  assert.equal(await trackerRegistry(new FakeProvider(h.chain), TRACKER_ADDR), REGISTRY_ADDR);

  const r0 = await h.round();
  assert.equal(r0.sent, 0, "還沒有新版，不送");
  assert.equal(entry(h, ALICE).status, "synced");
  assert.equal(entry(h, BOB), undefined, "沒開自動同步的 record 不追蹤");
  assert.equal(entry(h, ALICE, 1), undefined);
  ok("沒有新版時不送交易；只追蹤開了自動同步的 record");

  h.chain.publish(TRADER, [alloc(BTC, 6000n), alloc(ETH, 4000n, false, 5n)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 1);
  assert.equal(r1.synced, 1);
  assert.equal(exitCodeOf(r1), 0);
  assert.equal(recOf(h, ALICE).versionId, 1n, "部位已調成最新版");
  assert.equal(recOf(h, ALICE).positionIds.length, 2);
  assert.equal(recOf(h, BOB).versionId, 0n, "沒開自動同步的跟隨者不動");
  assert.equal(h.chain.eth.get(h.executor.toLowerCase()), TIP, "執行者拿到小費");
  assert.equal(h.chain.gas.get(ALICE.toLowerCase()), 10n ** 16n - 2n * h.chain.executionFee - TIP, "油箱扣執行費×腿數＋小費");
  assert.equal(entry(h, ALICE).status, "synced");
  assert.equal(entry(h, ALICE).syncedVersion, 1);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].kind, "resynced");
  assert.equal(h.notes[0].fromVersion, 0);
  assert.equal(h.notes[0].toVersion, 1);
  assert.match(h.notes[0].message, /2 條腿/);
  assert.equal(h.state.lastBlock, h.chain.block - 1, "游標推進到掃描時的 head");
  assert.ok(h.chain.calls.filter((c) => c === "getFollowerCount").length >= 1, "依 followersByTrader 找跟隨者");
  ok("交易者發新版 → 找出跟隨者（去重）→ 模擬 → 送出 resyncFor → 拿小費、通知 resynced");

  // 下一輪會看到自己那筆交易的 Resynced 事件：讀一次確認已是最新版，不送。
  const r2 = await h.round();
  assert.equal(r2.sent, 0);
  assert.equal(entry(h, ALICE).status, "synced");
  const before = h.chain.calls.length;
  const r3 = await h.round();
  assert.equal(r3.sent, 0);
  assert.equal(r3.evaluated, 0, "沒有新事件、沒到重掃時間 → 什麼都不讀");
  assert.equal(h.chain.calls.length, before);
  ok("冪等：再跑一輪沒有新事件就不做事");
}

// ── 2. 冷卻、油箱不足、存入後立即重試 ──────────────────────────────────────
{
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true, { tipWei: TIP, minSyncInterval: 3600 });
    },
  });
  await h.round();
  // 從未同步時，冷卻從跟單當下起算（合約 _syncReadyAt）：先讓時間過去。
  h.chain.time += 3600;
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 0);
  assert.equal(entry(h, ALICE).status, "blocked");
  assert.equal(entry(h, ALICE).category, "gas");
  assert.equal(h.notes.at(-1)!.kind, "blocked");
  assert.equal(h.notes.at(-1)!.category, "gas");
  const nextAt = entry(h, ALICE).nextCheckAt;
  assert.ok(nextAt >= h.chain.time + 1800 - 10, "油箱不足 → 30 分鐘後再試");
  ok("油箱不足 → 合約 revert InsufficientSyncGas → 記為 blocked(gas)、通知本人、排 30 分鐘後重試");

  const notesBefore = h.notes.length;
  h.chain.mine();
  await h.round();
  assert.equal(h.notes.length, notesBefore, "同一個原因不重複通知");

  h.chain.deposit(ALICE, 10n ** 16n);
  const r2 = await h.round();
  assert.equal(r2.sent, 1, "SyncGasDeposited 事件 → 不等退避，立刻重試");
  assert.equal(recOf(h, ALICE).versionId, 1n);
  ok("同一原因只通知一次；存入油箱（SyncGasDeposited）後立刻重試成功");

  h.chain.publish(TRADER, [alloc(BTC)]);
  const calls = h.chain.calls.filter((c) => c === "resyncFor").length;
  const r3 = await h.round();
  assert.equal(r3.sent, 0);
  assert.equal(entry(h, ALICE).category, "cooldown");
  assert.equal(h.chain.calls.filter((c) => c === "resyncFor").length, calls, "冷卻中先在本地判斷，不白白模擬");
  assert.ok(entry(h, ALICE).nextCheckAt > h.chain.time);
  assert.ok(!h.notes.some((p) => p.category === "cooldown"), "冷卻不通知（不是問題）");
  h.chain.time += 3600;
  h.chain.mine();
  const r4 = await h.round();
  assert.equal(r4.sent, 1, "冷卻結束後同步");
  assert.equal(recOf(h, ALICE).versionId, 2n);
  ok("冷卻（minSyncInterval）：本地先算好 readyAt，冷卻結束後才送；冷卻不通知");
}

// ── 3. RWA 未 KYC → 原子 revert → KYC 後重試成功；休市 ──────────────────────
{
  const h = await harness({
    setup: (c) => {
      c.rwa.add(AAPL);
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(BTC, 5000n), alloc(AAPL, 5000n)]);
  await h.round();
  assert.equal(entry(h, ALICE).category, "kyc");
  assert.equal(recOf(h, ALICE).versionId, 0n, "整筆 revert，部位維持舊版");
  assert.match(h.notes.at(-1)!.message, /KYC/);
  assert.ok(h.notes.at(-1)!.retryAt);
  h.chain.kyc.add(ALICE.toLowerCase());
  h.chain.time += 3600;
  h.chain.mine();
  const r = await h.round();
  assert.equal(r.sent, 1);
  assert.equal(recOf(h, ALICE).versionId, 1n);
  ok("新版含 RWA 而跟隨者未 KYC → 整筆 revert、部位不動、通知；KYC 後到重試時間就同步成功");

  h.chain.halted.add(ETH);
  h.chain.publish(TRADER, [alloc(ETH)]);
  await h.round();
  assert.equal(entry(h, ALICE).category, "market");
  h.chain.halted.delete(ETH);
  h.chain.time += 600;
  h.chain.mine();
  assert.equal((await h.round()).sent, 1);
  ok("市場 Halted／ReduceOnly → blocked(market)，10 分鐘後重試、恢復後成功");
}

// ── 3b. 交易所調高執行費 → 高於跟隨者同意的費率 → blocked(consent)；本人重新同意後立刻重試 ──────
{
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true, { tipWei: TIP });
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.executionFee *= 3n; // 交易所 owner 調高費率
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 0);
  assert.equal(entry(h, ALICE).status, "blocked");
  assert.equal(entry(h, ALICE).category, "consent");
  assert.equal(recOf(h, ALICE).versionId, 0n, "部位維持舊版");
  assert.equal(h.chain.gas.get(ALICE.toLowerCase()), 10n ** 16n, "油箱一 wei 不動");
  assert.equal(h.notes.at(-1)!.category, "consent");
  assert.match(h.notes.at(-1)!.message, /ExecutionFeeAboveCap/);
  assert.ok(entry(h, ALICE).nextCheckAt >= h.chain.time + 3600 - 10, "1 小時後再試");
  ok("交易所調高執行費、超過跟隨者同意的費率 → 合約 revert ExecutionFeeAboveCap → blocked(consent)、通知本人");

  h.chain.setAutoSync(ALICE, 0, true, { tipWei: TIP }); // 本人看過新費率、帶入新上限重新同意
  const r2 = await h.round();
  assert.equal(r2.sent, 1, "AutoSyncSet → 不等退避，立刻重試");
  assert.equal(recOf(h, ALICE).versionId, 1n);
  assert.equal(h.chain.gas.get(ALICE.toLowerCase()), 10n ** 16n - h.chain.executionFee - TIP, "按新費率扣");
  ok("本人重新 setAutoSync（同意新費率）→ AutoSyncSet 事件觸發立刻重試、按新費率同步");
}

// ── 4. 關閉自動同步、結束跟單、別人先同步、交易者資格 ────────────────────
{
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.publish(TRADER2, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
      c.follow(CAROL, TRADER2);
      c.setAutoSync(CAROL, 0, true);
      c.deposit(CAROL, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.setAutoSync(ALICE, 0, false);
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r = await h.round();
  assert.equal(r.sent, 0);
  assert.equal(entry(h, ALICE).status, "dropped");
  assert.equal(recOf(h, ALICE).versionId, 0n);
  h.chain.setAutoSync(ALICE, 0, true);
  assert.equal((await h.round()).sent, 1, "重新開啟 → AutoSyncSet 事件 → 同步");
  ok("跟隨者關閉自動同步 → 停止追蹤、不送；重新開啟後立刻同步");

  // 另一位執行者先同步了：模擬時 AlreadySynced → 視為完成，不送
  h.chain.publish(TRADER2, [alloc(ETH)]);
  h.chain.resyncFor(CAROL, CAROL, 0n, true, "0x" + "ab".repeat(32)); // 本人手動同步
  const r2 = await h.round();
  assert.equal(r2.sent, 0);
  assert.equal(entry(h, CAROL).status, "synced");
  ok("別人（或本人）已先同步 → 讀到已是最新版，不送交易");

  h.chain.ineligible.add(TRADER2.toLowerCase());
  h.chain.publish(TRADER2, [alloc(BTC)]);
  await h.round();
  assert.equal(entry(h, CAROL).category, "trader");
  h.chain.unfollow(CAROL, 0);
  await h.round();
  assert.equal(entry(h, CAROL).status, "dropped");
  ok("交易者不符資格 → blocked(trader)；跟隨者結束跟單 → 停止追蹤");
}

// ── 5. 公開模式的小費門檻、每輪上限、dry-run ───────────────────────────────
{
  const h = await harness({
    minTipWei: TIP,
    maxSendsPerRound: 1,
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      for (const f of [ALICE, BOB, CAROL]) {
        c.follow(f, TRADER);
        c.setAutoSync(f, 0, true, { tipWei: f === CAROL ? 0n : TIP });
        c.deposit(f, 10n ** 16n);
      }
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 1, "每輪上限 1 筆");
  const r2 = await h.round();
  assert.equal(r2.sent, 1);
  assert.equal(recOf(h, CAROL).versionId, 0n, "小費低於門檻的不服務");
  assert.match(entry(h, CAROL).lastReason!, /低於本執行者門檻/);
  assert.ok(!h.notes.some((p) => p.follower === CAROL), "門檻是執行者自己的選擇，不通知跟隨者");
  ok("public 模式：小費低於 --min-tip-wei 不服務（也不通知）；--max-sends-per-round 生效");

  const d = await harness({
    dryRun: true,
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
      c.publish(TRADER, [alloc(ETH)]);
    },
  });
  const rd = await d.round();
  assert.equal(rd.simulatedOk, 1);
  assert.equal(rd.sent, 0);
  assert.equal(recOf(d, ALICE).versionId, 0n);
  assert.ok(d.lines.some((l) => /\[dry-run\] 模擬成功：v1 → v2（versionId 0 → 1）/.test(l)), "日誌的版本號與前端一致從 1 起算，括號附 versionId");
  ok("dry-run：沒有金鑰、只模擬（from＝零位址，與陌生人規則相同）、不送交易");
}

// ── 6. personal 模式 ─────────────────────────────────────────────────────────
{
  const h = await harness({
    mode: "personal",
    followers: [ALICE.toLowerCase()],
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      for (const f of [ALICE, BOB]) {
        c.follow(f, TRADER);
        c.setAutoSync(f, 0, true, { tipWei: 0n });
        c.deposit(f, 10n ** 16n);
      }
    },
  });
  await h.round();
  assert.equal(entry(h, BOB), undefined, "personal 模式不碰別人的 record");
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r = await h.round();
  assert.equal(r.sent, 1);
  assert.equal(recOf(h, ALICE).versionId, 1n);
  assert.equal(recOf(h, BOB).versionId, 0n);
  assert.equal(h.chain.calls.filter((c) => c === "getFollowerCount").length, 0, "personal 模式不掃 followersByTrader");
  const f = buildFilter({ mode: "personal", followers: [ALICE.toLowerCase()], copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR }, [TRADER.toLowerCase()]);
  assert.equal(f.topics.length, 2);
  assert.equal((f.topics[1] as string[]).length, 2, "topic1 = 自己的跟隨者 ∪ 他們跟的交易者");
  ok("personal 模式：只服務 --followers；getLogs 以 topic1 縮小範圍；不掃 followersByTrader");

  // 執行者位址 = 跟隨者 → 略過（那代表把主錢包私鑰交給了 bot）
  const self = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
    },
  });
  self.chain.follow(self.executor, TRADER);
  self.chain.setAutoSync(self.executor, 0, true);
  self.chain.deposit(self.executor, 10n ** 16n);
  self.chain.publish(TRADER, [alloc(ETH)]);
  const rs = await self.round();
  assert.equal(rs.sent, 0);
  assert.ok(self.lines.some((l) => /執行者位址就是跟隨者/.test(l)));
  ok("執行者位址就是跟隨者 → 拒絕服務並警告");
}

// ── 7. 中斷續跑、getLogs 失敗、交易狀態未知 ───────────────────────────────
{
  // 定期重掃關掉，才看得出「只靠事件游標」時有沒有漏（重掃本身另外測）。
  const h = await harness({
    rescanIntervalSec: 1e9,
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  // 製造 600 塊的空白，讓掃描分成多段；中間那段節點故障。
  for (let i = 0; i < 300; i++) h.chain.mine();
  h.chain.publish(TRADER, [alloc(ETH)]);
  const publishedAt = h.chain.block;
  for (let i = 0; i < 300; i++) h.chain.mine();
  h.chain.failLogsAt = publishedAt;
  const r1 = await h.round();
  assert.ok(r1.scanError, "有一段讀不到");
  assert.equal(exitCodeOf(r1), 1, "--once 會 exit 1");
  assert.ok(h.state.lastBlock < publishedAt, "游標停在失敗那段之前");
  assert.equal(r1.sent, 0);
  h.chain.failLogsAt = null;
  const r2 = await h.round();
  assert.equal(r2.scanError, null);
  assert.equal(r2.sent, 1, "下一輪從游標接著掃，沒漏掉發版事件");
  ok("getLogs 某段失敗 → 游標不越過、exit 1；下一輪接著掃，事件不漏");

  // 游標已推進、跟隨者還沒讀完就中斷：待辦在狀態檔裡，下一輪補做。
  h.chain.publish(TRADER, [alloc(BTC)]);
  const saved = JSON.parse(JSON.stringify(h.state)) as CopySyncState;
  saved.lastBlock = h.chain.block; // 模擬「游標已存、事件已入列」
  saved.queue = { followers: [], traders: [TRADER.toLowerCase()] };
  const h2 = await harness();
  // 把 h 的鏈與這份狀態接到新引擎上
  const provider = new FakeProvider(h.chain);
  const wallet = new ExecutorWallet(ethers.Wallet.createRandom().privateKey, { copyTracker: TRACKER_ADDR, chainId: FAKE_CHAIN_ID }, provider);
  const resumed = new CopySyncEngine({
    cfg: { ...((h2.engine as unknown as { d: { cfg: EngineConfig } }).d.cfg) },
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: makeExecutor({ provider, tracker: TRACKER_ADDR, signer: new LocalNonceSigner(wallet), address: wallet.address }),
    state: saved,
    persist: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    notify: async () => {},
  });
  const r3 = await resumed.runRound();
  assert.equal(r3.events, 0, "沒有新的區塊要掃");
  assert.equal(r3.sent, 1, "從狀態檔的待辦補做");
  assert.deepEqual(saved.queue, { followers: [], traders: [] });
  ok("中斷續跑：游標推進前事件先寫進狀態檔的待辦，重啟後照樣處理");

  // 交易送出但等不到確認
  h.chain.holdTxs = true;
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r4 = await h.round();
  assert.equal(r4.sent, 1);
  assert.equal(r4.unconfirmed, 1);
  assert.equal(exitCodeOf(r4), 1);
  assert.equal(entry(h, ALICE).status, "unconfirmed");
  assert.equal(h.notes.at(-1)!.kind, "tx-unconfirmed");
  h.chain.mine();
  const r5 = await h.round();
  assert.equal(r5.sent, 0, `狀態未知的交易在 ${UNCONFIRMED_HOLD_SEC} 秒內不重送`);
  h.chain.holdTxs = false;
  h.chain.releaseHeld();
  h.chain.time += 120;
  h.chain.mine();
  const r6 = await h.round();
  assert.equal(r6.sent, 0);
  assert.equal(r6.synced, 1, "下一輪查到收據 → 標成已同步");
  assert.equal(entry(h, ALICE).status, "synced");
  ok("交易等確認逾時 → 標 unconfirmed、通知、短時間內不重送；之後查到收據就完成");
}

// ── 7a. 狀態未知的交易從 mempool 消失 → 重新對齊 nonce ─────────────────────
{
  const chain = new FakeChain();
  chain.publish(TRADER, [alloc(BTC)]);
  chain.follow(ALICE, TRADER);
  chain.setAutoSync(ALICE, 0, true);
  chain.deposit(ALICE, 10n ** 16n);
  const provider = new FakeProvider(chain);
  const wallet = new ExecutorWallet(ethers.Wallet.createRandom().privateKey, { copyTracker: TRACKER_ADDR, chainId: FAKE_CHAIN_ID }, provider);
  const lines: string[] = [];
  const state = emptyState({ chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, scope: "public" });
  const engine = new CopySyncEngine({
    cfg: {
      mode: "public", followers: [], chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, dryRun: false,
      confirmations: 0, startBlock: 0, lookbackBlocks: 1000, rescanIntervalSec: 1e9, minTipWei: 0n, maxGasPriceWei: null,
      maxSendsPerRound: 10, txTimeoutMs: 100,
    },
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: makeExecutor({
      provider, tracker: TRACKER_ADDR, signer: new LocalNonceSigner(wallet), address: wallet.address,
      renewSigner: () => new LocalNonceSigner(wallet),
    }),
    state,
    persist: () => {},
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERR ${m}`) },
    notify: async () => {},
  });
  await engine.runRound();
  chain.holdTxs = true;
  chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await engine.runRound();
  assert.equal(r1.unconfirmed, 1);
  chain.holdTxs = false;
  chain.dropHeld(); // 交易從 mempool 消失，nonce 0 沒有被用掉
  chain.time += UNCONFIRMED_HOLD_SEC + 1;
  chain.mine();
  const r2 = await engine.runRound();
  assert.ok(lines.some((l) => /重新向節點對齊 nonce/.test(l)));
  assert.equal(r2.sent, 1);
  assert.equal(r2.synced, 1, "用回 nonce 0 重新送出，沒有卡在缺口後面");
  assert.equal(chain.records.get(ALICE.toLowerCase())![0].versionId, 1n);
  ok("狀態未知的交易超過等待時間仍沒上鏈 → 重新向節點對齊 nonce 再送，不會卡在 nonce 缺口後面");
}

// ── 7b. 定期重掃補上漏掉的事件 ────────────────────────────────────────────
{
  const h = await harness({
    rescanIntervalSec: 600,
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  h.chain.logs = h.chain.logs.filter((l) => l.blockNumber !== h.chain.block); // 事件「漏掉」（例如節點回了不完整的結果）
  const r1 = await h.round();
  assert.equal(r1.sent, 0, "沒看到事件、還沒到重掃時間");
  h.chain.time += 600;
  h.chain.mine();
  const r2 = await h.round();
  assert.equal(r2.sent, 1, "重掃時發現有新版");
  ok("定期重掃：就算事件漏了，追蹤中的 record 最慢一個重掃週期內也會同步");
}

// ── 8. 模擬後狀態改變：上鏈 revert ─────────────────────────────────────────
{
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  // 模擬成功後、上鏈前市場剛好停了：用 holdTxs 讓交易晚一點執行
  h.chain.holdTxs = true;
  const p = h.round();
  await new Promise((r) => setTimeout(r, 20));
  h.chain.halted.add(ETH);
  h.chain.holdTxs = false;
  h.chain.releaseHeld();
  const r = await p;
  assert.equal(r.sent, 1);
  assert.ok(r.txFailed === 1 || r.unconfirmed === 1);
  assert.equal(recOf(h, ALICE).versionId, 0n, "revert 的交易沒有改變部位");
  ok("模擬後到上鏈前狀態改變 → 交易 revert，部位不動、記失敗、稍後重試");
}

// ── 9. 指定執行者（personal 模式只讓自己的 agent 同步）與「有新版」通知 ─────────────
{
  // personal：跟隨者把本執行者設為唯一的執行者 → 照常同步；冷卻中先通知「有新版、預計何時同步」
  const h = await harness({
    mode: "personal",
    followers: [ALICE.toLowerCase()],
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true, { minSyncInterval: 3600, tipWei: 0n });
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  h.chain.setSyncExecutor(ALICE, 0, h.executor);
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 0, "冷卻中不送");
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].kind, "new-version");
  assert.equal(h.notes[0].autoSync, true);
  assert.equal(h.notes[0].toVersion, 1);
  assert.equal(h.notes[0].retryAt, new Date(Number(h.chain.readyAt(ALICE, 0)) * 1000).toISOString(), "附上預計同步的時間");
  await h.round();
  assert.equal(h.notes.length, 1, "同一版只通知一次");
  h.chain.time += 3600;
  h.chain.mine();
  const r2 = await h.round();
  assert.equal(r2.synced, 1, "冷卻結束後由指定的執行者（本執行者）同步");
  assert.equal(recOf(h, ALICE).versionId, 1n);
  assert.deepEqual(h.notes.map((x) => x.kind), ["new-version", "resynced"]);
  ok("personal：跟隨者指定本執行者 → 冷卻中先通知「有新版」（附預計時間、每版一次），冷卻結束後同步");
}
{
  // public：跟隨者指定了別人 → 不追蹤、不送；解除指定（SyncExecutorSet 事件）後立刻服務
  const other = ethers.getAddress("0x" + "0e".repeat(20));
  const h = await harness({
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true, { tipWei: TIP });
      c.deposit(ALICE, 10n ** 16n);
      c.setSyncExecutor(ALICE, 0, other);
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 0);
  assert.equal(entry(h, ALICE), undefined, "指定了別的執行者 → public 模式不追蹤");
  assert.ok(!h.chain.calls.includes("resyncFor"), "連模擬都不做");
  // 合約層：就算硬送也會被拒（假鏈照合約規則實作）
  assert.throws(() => h.chain.resyncFor(h.executor, ALICE, 0n, false), /execution reverted/);
  h.chain.setSyncExecutor(ALICE, 0, null);
  const r2 = await h.round();
  assert.equal(r2.synced, 1, "解除指定後，SyncExecutorSet 事件讓執行者立刻重新檢查");
  assert.equal(recOf(h, ALICE).versionId, 1n);
  ok("public：跟隨者指定了別的執行者 → 不追蹤、不模擬；解除指定後（SyncExecutorSet）立刻服務");
}
{
  // personal：沒開自動同步（快照式）與指定了別人的跟單 → 不送交易，只在有新版時通知本人
  const other = ethers.getAddress("0x" + "0e".repeat(20));
  const h = await harness({
    mode: "personal",
    followers: [ALICE.toLowerCase()],
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER); // #0：沒開自動同步
      c.follow(ALICE, TRADER); // #1：開了，但指定別的執行者
      c.setAutoSync(ALICE, 1, true);
      c.deposit(ALICE, 10n ** 16n);
      c.setSyncExecutor(ALICE, 1, other);
    },
  });
  await h.round();
  assert.equal(entry(h, ALICE, 0).status, "manual");
  assert.equal(entry(h, ALICE, 1).status, "manual");
  assert.equal(h.notes.length, 0, "還沒有新版，不通知");
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await h.round();
  assert.equal(r1.sent, 0, "不送任何交易");
  assert.ok(!h.chain.calls.includes("resyncFor"));
  const nv = h.notes.filter((x) => x.kind === "new-version");
  assert.equal(nv.length, 2);
  const byIdx = (i: number) => nv.find((x) => x.recordIdx === i)!;
  assert.equal(byIdx(0).autoSync, false);
  assert.match(byIdx(0).message, /自動同步未開啟.*立即同步/);
  assert.match(byIdx(1).message, /指定的執行者是/);
  assert.equal(byIdx(0).retryAt, null);
  await h.round();
  h.chain.mine();
  await h.round();
  assert.equal(h.notes.length, 2, "同一版只通知一次");
  h.chain.publish(TRADER, [alloc(BTC)]);
  await h.round();
  assert.equal(h.notes.filter((x) => x.kind === "new-version" && x.toVersion === 2).length, 2, "再發一版再通知");
  assert.equal(recOf(h, ALICE, 0).versionId, 0n);
  // 本人之後開啟自動同步 → AutoSyncSet 讓它立刻轉為代為同步
  h.chain.setAutoSync(ALICE, 0, true);
  const r2 = await h.round();
  assert.equal(r2.synced, 1);
  assert.equal(recOf(h, ALICE, 0).versionId, 2n);
  assert.equal(entry(h, ALICE, 0).status, "synced");
  ok("personal：沒開自動同步或指定了別人的跟單 → 不送交易，每一版通知本人一次；開啟後立刻代為同步");
}
{
  // dry-run（沒有金鑰）+ personal + 指定執行者：以指定的執行者身分模擬，結果才與正式執行一致
  const agent = ethers.getAddress("0x" + "ae".repeat(20));
  const h = await harness({
    mode: "personal",
    followers: [ALICE.toLowerCase()],
    dryRun: true,
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
      c.setSyncExecutor(ALICE, 0, agent);
      c.publish(TRADER, [alloc(ETH)]);
    },
  });
  const r = await h.round();
  assert.equal(r.simulatedOk, 1, "以指定執行者的身分模擬成功（零位址會被 NotSyncExecutor 拒絕）");
  assert.equal(r.sent, 0);
  ok("dry-run：跟隨者指定了執行者時，以那個地址的身分模擬");
}

// ── 10. 送出失敗的錯誤訊息不會把 RPC 金鑰寫進狀態檔或通知 ──────────────────
{
  const rpc = "https://base-sepolia.g.alchemy.com/v2/SuperSecretApiKey0123456789";
  const h = await harness({
    redact: makeRedactor([rpc]),
    wrapExec: (e) => ({
      ...e,
      async send() {
        // ethers v6 遇到 HTTP 503 時的錯誤長這樣（實測：訊息帶完整的 requestUrl）
        throw Object.assign(new Error(`server response 503 Service Unavailable (request={  }, response={  }, error=null, info={ "requestUrl": "${rpc}", "responseBody": "", "responseStatus": "503 Service Unavailable" }, code=SERVER_ERROR, version=6.17.0)`), { code: "SERVER_ERROR" });
      },
    }),
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await h.round();
  h.chain.publish(TRADER, [alloc(ETH)]);
  const r = await h.round();
  assert.equal(r.txFailed, 1);
  assert.match(entry(h, ALICE).lastReason!, /^送出失敗：/);
  for (const text of [h.saved(), JSON.stringify(h.notes), entry(h, ALICE).lastReason!]) {
    assert.ok(!text.includes("SuperSecretApiKey0123456789"), "RPC 金鑰不得出現在狀態檔或通知");
    assert.ok(!text.includes(rpc));
  }
  // 沒有傳入 redact 時，預設也會遮掉 requestUrl 與 /v2/<key>
  const plain = await harness({
    wrapExec: (e) => ({ ...e, async send() { throw new Error(`could not coalesce error (info={ "requestUrl": "${rpc}" })`); } }),
    setup: (c) => {
      c.publish(TRADER, [alloc(BTC)]);
      c.follow(ALICE, TRADER);
      c.setAutoSync(ALICE, 0, true);
      c.deposit(ALICE, 10n ** 16n);
    },
  });
  await plain.round();
  plain.chain.publish(TRADER, [alloc(ETH)]);
  await plain.round();
  assert.ok(!plain.saved().includes("SuperSecretApiKey0123456789"));
  ok("送出失敗：錯誤訊息先遮蔽再寫進狀態檔（ethers 的 requestUrl 帶 RPC 金鑰）");
}

// ── 11. 只通知模式（--notify-only）：不送交易、沒有金鑰；狀態檔照常寫，cron 每次重啟都從存檔接著做 ─────
{
  const chain = new FakeChain();
  chain.publish(TRADER, [alloc(BTC)]);
  chain.follow(ALICE, TRADER); // #0：開了自動同步（冷卻 1 小時）
  chain.setAutoSync(ALICE, 0, true, { minSyncInterval: 3600, tipWei: 0n });
  chain.deposit(ALICE, 10n ** 16n);
  chain.follow(ALICE, TRADER); // #1：沒開自動同步
  const provider = new FakeProvider(chain);
  const cfg: EngineConfig = {
    mode: "personal", followers: [ALICE.toLowerCase()], chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR,
    dryRun: true, notifyOnly: true, confirmations: 0, startBlock: 0, lookbackBlocks: 1000, rescanIntervalSec: 600,
    minTipWei: 0n, maxGasPriceWei: null, maxSendsPerRound: 10, txTimeoutMs: 200,
  };
  const scope = scopeOf("personal", [ALICE], true);
  assert.equal(scope, `notify:personal:${ALICE.toLowerCase()}`);
  let saved = JSON.stringify(emptyState({ chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, scope }));
  const notes: NotifyPayload[] = [];
  const lines: string[] = [];
  // 每一次 --once 都是新的行程：從存檔讀回狀態、跑一輪、存檔（與 run.ts 相同）
  const once = () =>
    new CopySyncEngine({
      cfg,
      reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
      exec: makeExecutor({ provider, tracker: TRACKER_ADDR, signer: null, address: null }),
      state: parseState(saved),
      persist: (s) => void (saved = JSON.stringify(s)),
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERR ${m}`) },
      notify: async (p) => void notes.push(p),
      sleep: async () => {},
    }).runRound();

  await once();
  assert.equal(notes.length, 0, "還沒有新版");
  chain.publish(TRADER, [alloc(ETH)]);
  const r1 = await once();
  assert.equal(r1.sent, 0);
  const nv1 = notes.filter((x) => x.kind === "new-version" && x.toVersion === 1);
  assert.equal(nv1.length, 2, "兩筆跟單各通知一次");
  const auto = nv1.find((x) => x.recordIdx === 0)!;
  assert.equal(auto.retryAt, new Date(Number(chain.readyAt(ALICE, 0)) * 1000).toISOString(), "冷卻中：附上別人最早能代為同步的時間");
  assert.match(auto.message, /冷卻結束後執行者才能代為同步（本程式是只通知模式，不送交易/);
  assert.ok(!/本執行者會/.test(auto.message), "只通知模式不能說「本執行者會代為同步」");
  assert.equal(auto.executor, null);
  assert.match(nv1.find((x) => x.recordIdx === 1)!.message, /自動同步未開啟.*立即同步/);

  await once();
  chain.mine();
  await once();
  assert.equal(notes.length, 2, "cron 的下一次 --once（重啟、從存檔接著做）不重複通知同一版");

  chain.time += 3600;
  chain.mine();
  const r2 = await once();
  assert.equal(r2.simulatedOk, 1, "冷卻結束：模擬會成功");
  assert.equal(r2.sent, 0);
  assert.equal(notes.length, 2, "這一版已經通知過");
  assert.ok(lines.some((l) => /\[notify-only\] 模擬成功/.test(l)));
  assert.equal(recOf({ chain } as Harness, ALICE).versionId, 0n, "只通知，部位不動");

  // 油箱被提領 → 模擬 revert InsufficientSyncGas → blocked(gas) 通知一次，重啟後不重複
  chain.withdraw(ALICE, 10n ** 16n);
  chain.time += 601; // 提領不是喚醒事件：等到下一次重掃（--rescan-sec）
  chain.mine();
  await once();
  const gasNotes = notes.filter((x) => x.kind === "blocked" && x.category === "gas");
  assert.equal(gasNotes.length, 1);
  chain.time += 3 * 3600;
  chain.mine();
  await once();
  await once();
  assert.equal(notes.filter((x) => x.kind === "blocked" && x.category === "gas").length, 1, "同一原因跨重啟也只通知一次");

  // 存回油箱、交易者再發一版：冷卻早已過、模擬會成功 → 通知「等執行者代為同步」
  chain.deposit(ALICE, 10n ** 16n);
  chain.publish(TRADER, [alloc(BTC)]);
  await once();
  const v2 = notes.filter((x) => x.kind === "new-version" && x.toVersion === 2);
  assert.equal(v2.length, 2);
  assert.match(v2.find((x) => x.recordIdx === 0)!.message, /模擬同步會成功，等執行者代為同步（本程式是只通知模式/);
  await once();
  assert.equal(notes.filter((x) => x.toVersion === 2).length, 2);
  assert.equal(chain.nonces.size, 0, "從頭到尾沒有任何地址送過交易");
  ok("--notify-only：不送交易、不需要金鑰；狀態檔跨重啟，每一版、每個被擋原因都只通知一次；訊息不說「本執行者會同步」");
}

// ── 12. 執行者金鑰其實是跟隨者的主錢包 → 不論模式都拒絕（run.ts 啟動時檢查）─────────────
{
  const chain = new FakeChain();
  chain.publish(TRADER, [alloc(BTC)]);
  chain.follow(ALICE, TRADER);
  const provider = new FakeProvider(chain);
  const fresh = ethers.getAddress("0x" + "e8".repeat(20));
  assert.deepEqual(await followerFootprint(provider, TRACKER_ADDR, fresh), { records: 0, syncGasWei: 0n });
  assert.equal(executorFollowerError({ address: fresh, tracker: TRACKER_ADDR, records: 0, syncGasWei: 0n }), null, "全新的熱錢包可以用");

  const fp = await followerFootprint(provider, TRACKER_ADDR, ALICE);
  assert.deepEqual(fp, { records: 1, syncGasWei: 0n });
  assert.match(executorFollowerError({ address: ALICE, tracker: TRACKER_ADDR, ...fp })!, /1 筆跟單紀錄.*跟隨者的主錢包.*不論 public 或 personal/);

  // 取消跟單後紀錄仍在（getCopyRecords 含已結束的）→ 仍拒絕；只存過油箱、沒跟過單也拒絕
  chain.unfollow(ALICE, 0);
  assert.equal((await followerFootprint(provider, TRACKER_ADDR, ALICE)).records, 1);
  chain.deposit(BOB, 5n * 10n ** 15n);
  const bobFp = await followerFootprint(provider, TRACKER_ADDR, BOB);
  assert.deepEqual(bobFp, { records: 0, syncGasWei: 5n * 10n ** 15n });
  assert.match(executorFollowerError({ address: BOB, tracker: TRACKER_ADDR, ...bobFp })!, /同步油箱餘額 0\.005 ETH/);
  ok("執行者金鑰的位址在 tracker 上有任何跟單紀錄（含已結束）或油箱餘額 → 拒絕啟動，訊息指向 --notify-only");
}

console.log(`copy-sync engine: ${n} ok`);
