// x402-copy-agent 的判斷邏輯與完整流程。完全離線：鏈是 copy-sync 的記憶體假鏈（ethers 編碼／簽章路徑是真的），
// 付款是假的 fetch，不連網、不付款、不送交易。
//   cd agent && npx tsx examples/x402-copy-agent.test.ts
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { LocalNonceSigner } from "../keeper/nonceSigner.ts";
import { makeChainReads, makeExecutor } from "../copy-sync/src/chain.ts";
import { CopySyncEngine, type EngineConfig } from "../copy-sync/src/engine.ts";
import { FakeChain, FakeProvider, FAKE_CHAIN_ID, REGISTRY_ADDR, TRACKER_ADDR, type Alloc } from "../copy-sync/src/fakeChain.ts";
import { ExecutorWallet } from "../copy-sync/src/guard.ts";
import { makeRedactor } from "../copy-sync/src/log.ts";
import { makeWebhookNotifier, type NotifyPayload } from "../copy-sync/src/notify.ts";
import { emptyState, scopeOf } from "../copy-sync/src/state.ts";
import { meteredFetch } from "../shared/src/x402Client.ts";
import {
  admitNotification, adviceFor, blockedLines, captureAuthorizations, checkSignal, classifyPayment, createWebhookServer, dedupeDecision, emptyLedger, gateDecision,
  loadLedger, makeRetryScheduler, makeSerialQueue, makeSignalPayer, MAX_BODY_BYTES, parseAuthorization, parseLedger, paymentTxFromHeaders, processNotice,
  RETRY_MARGIN_SEC, routeWebhook, saveLedger,
  signalKey, syncKey,
  type AgentConfig, type AgentDeps, type ChainSnapshot, type Ledger, type NewVersionNotice, type PayAttempt,
} from "./x402-copy-agent-core.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const TRADER = ethers.getAddress("0x" + "11".repeat(20));
const ALICE = ethers.getAddress("0x" + "a1".repeat(20));
const BOB = ethers.getAddress("0x" + "b0".repeat(20));
const MALLORY = ethers.getAddress("0x" + "ee".repeat(20));
const TX = "0x" + "ab".repeat(32);
const BTC = ethers.id("sBTC");
const ETH = ethers.id("sETH");
const alloc = (asset: string): Alloc => ({ asset, weight: 10_000n, isLong: true, leverage: 2n });
const CFG: AgentConfig = { chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, followers: [ALICE.toLowerCase(), BOB.toLowerCase()] };

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "pepefi-copy-sync", kind: "new-version", chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, follower: ALICE, recordIdx: 0,
  trader: TRADER, fromVersion: 0, toVersion: 1, category: null, autoSync: true, message: "x", txHash: null, executor: null,
  retryAt: null, at: new Date().toISOString(), ...over,
});
const NOTICE: NewVersionNotice = { chainId: FAKE_CHAIN_ID, follower: ALICE.toLowerCase(), recordIdx: 0, trader: TRADER.toLowerCase(), fromVersion: 0, toVersion: 1, autoSync: true };

// ── 1. 通知驗證：畸形 payload、白名單外 ─────────────────────────────────────
{
  const r = admitNotification(payload(), CFG);
  assert.equal(r.kind, "accept");
  if (r.kind === "accept") {
    assert.equal(r.notice.follower, ALICE.toLowerCase(), "地址正規化成小寫");
    assert.equal(r.notice.toVersion, 1);
  }
  ok("合法的 new-version 通知通過，地址正規化");

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["陣列", []],
    ["字串", "x"],
    ["source 錯", payload({ source: "evil" })],
    ["kind 缺", payload({ kind: undefined })],
    ["kind 未知", payload({ kind: "drain" })],
    ["follower 不是地址", payload({ follower: "0x123" })],
    ["follower 零地址", payload({ follower: ethers.ZeroAddress })],
    ["trader 不是字串", payload({ trader: 42 })],
    ["toVersion null", payload({ toVersion: null })],
    ["toVersion 負數", payload({ toVersion: -1 })],
    ["toVersion 字串", payload({ toVersion: "1" })],
    ["toVersion 小數", payload({ toVersion: 1.5 })],
    ["recordIdx 字串", payload({ recordIdx: "0" })],
    ["fromVersion 不小於 toVersion", payload({ fromVersion: 1, toVersion: 1 })],
    ["autoSync 字串", payload({ autoSync: "true" })],
    ["chainId 字串", payload({ chainId: "31337" })],
    ["chainId 別條鏈", payload({ chainId: 1 })],
    ["別的 tracker", payload({ copyTracker: MALLORY })],
    ["retryAt 不是時間", payload({ retryAt: "soon" })],
  ];
  for (const [label, body] of bad) {
    const x = admitNotification(body, CFG);
    assert.ok(x.kind === "reject" && x.status === 400, `畸形 payload 要拒絕：${label}`);
  }
  ok(`畸形 payload 一律 400（${bad.length} 種）`);

  const w = admitNotification(payload({ follower: MALLORY }), CFG);
  assert.ok(w.kind === "reject" && w.status === 403);
  ok("白名單外的跟隨者 403");

  assert.equal(admitNotification(payload({ kind: "resynced" }), CFG).kind, "ignore");
  ok("其他種類的通知（resynced…）略過，不當錯誤");

  const bl = admitNotification(payload({ kind: "blocked", toVersion: null, autoSync: "x", category: "gas" }), CFG);
  assert.ok(bl.kind === "blocked" && bl.notice.category === "gas");
  if (bl.kind === "blocked") {
    const text = blockedLines(bl.notice).join("\n");
    assert.match(text, /油箱餘額不足/);
    assert.match(text, /depositSyncGas/);
    assert.match(text, /本次未付費/);
  }
  assert.equal(admitNotification(payload({ kind: "blocked", category: "__proto__" }), CFG).kind, "reject", "未知分類");
  assert.equal(admitNotification(payload({ kind: "blocked", category: "gas", follower: MALLORY }), CFG).kind, "reject", "白名單外");
  ok("copy-sync 的 blocked 通知：印原因與本人該怎麼做，分類要是已知的，白名單照樣檢查");
}

// ── 2. 去重 ─────────────────────────────────────────────────────────────────
{
  const l = emptyLedger();
  assert.deepEqual(dedupeDecision(l, NOTICE), { action: "process", payment: "pay" });

  for (const status of ["paying", "uncertain"] as const) {
    l.signals[signalKey(NOTICE)] = { status, tx: null, paidAtomic: "0", version: null };
    assert.equal(dedupeDecision(l, NOTICE).action, "skip", `${status}：付款狀態不明，不重付`);
  }
  l.signals[signalKey(NOTICE)] = { status: "mismatch", tx: TX, paidAtomic: "10000", version: 0 };
  assert.equal(dedupeDecision(l, NOTICE).action, "skip", "版號不符過：不再付");

  l.signals[signalKey(NOTICE)] = { status: "paid", tx: TX, paidAtomic: "10000", version: 1 };
  assert.deepEqual(dedupeDecision(l, NOTICE), { action: "process", payment: "reuse" }, "已付但還沒同步（例如冷卻）：不再付、可以再試同步");
  const bob = { ...NOTICE, follower: BOB.toLowerCase() };
  assert.deepEqual(dedupeDecision(l, bob), { action: "process", payment: "reuse" }, "同一版、另一位跟隨者：共用訊號，不再付");
  assert.deepEqual(dedupeDecision(l, { ...NOTICE, toVersion: 2 }), { action: "process", payment: "pay" }, "新的一版要重新付");

  l.syncs[syncKey(NOTICE)] = { status: "synced", tx: TX };
  assert.equal(dedupeDecision(l, NOTICE).action, "skip");
  assert.equal(dedupeDecision(l, bob).action, "process", "另一位跟隨者還沒同步");
  l.syncs[syncKey(NOTICE)] = { status: "unconfirmed", tx: TX };
  assert.equal(dedupeDecision(l, NOTICE).action, "skip", "交易未確認不重送");
  ok("去重：同一 trader＋toVersion 不重複付款，同一筆跟單的同一版不重複同步");

  const dir = mkdtempSync(join(tmpdir(), "x402-copy-agent-"));
  const p = join(dir, "sub", "ledger.json");
  assert.deepEqual(loadLedger(p), emptyLedger(), "沒有檔案：空紀錄");
  saveLedger(p, l);
  assert.deepEqual(loadLedger(p), l, "寫檔後讀回相同（重啟不重付）");
  assert.throws(() => parseLedger('{"records":{}}'), /不是 x402-copy-agent 的狀態檔/);
  rmSync(dir, { recursive: true, force: true });
  ok("去重紀錄寫檔、讀回；別的檔案不接受");
}

// ── 3. 閘門：autoSync 關閉、冷卻、其他 ────────────────────────────────────
{
  const snap = (over: Partial<ChainSnapshot> = {}): ChainSnapshot => ({
    record: { trader: TRADER, versionId: 0n, active: true }, latest: 1n, autoSync: true, executor: null, readyAt: 100, now: 200, ...over,
  });
  const me = "0x" + "ca".repeat(20);
  assert.equal(gateDecision(NOTICE, snap(), me), null);
  assert.equal(gateDecision(NOTICE, snap({ executor: me }), me), null, "指定的就是這把熱錢包");

  const code = (nn: NewVersionNotice, s: ChainSnapshot, m: string | null = me) => gateDecision(nn, s, m)?.code;
  assert.equal(code(NOTICE, snap({ autoSync: false })), "auto-sync-off", "鏈上關閉");
  assert.equal(code({ ...NOTICE, autoSync: false }, snap()), "auto-sync-off", "通知說關閉");
  assert.match(gateDecision(NOTICE, snap({ autoSync: false }), me)!.action, /立即同步/);
  ok("autoSync 關閉（通知或鏈上任一）：不同步，告訴本人怎麼做");

  const cd = gateDecision(NOTICE, snap({ readyAt: 300 }), me)!;
  assert.equal(cd.code, "cooldown");
  assert.match(cd.reason, new RegExp(new Date(300_000).toISOString()), "印出冷卻結束時間");
  assert.match(cd.action, /本人不受冷卻/);
  assert.match(cd.action, /自動再試/);
  assert.equal(cd.retryInSec, 100, "還要多久（鏈上時間）");
  assert.equal(code(NOTICE, snap({ readyAt: 200 })), undefined, "時間到（now == readyAt）就可以");
  ok("冷卻中：不同步，印出到什麼時候與本人的選項");

  assert.equal(code(NOTICE, snap({ record: undefined })), "no-record");
  assert.equal(code(NOTICE, snap({ record: { trader: TRADER, versionId: 0n, active: false } })), "no-record");
  assert.equal(code(NOTICE, snap({ record: { trader: MALLORY, versionId: 0n, active: true } })), "trader-mismatch", "偽造的 trader");
  assert.equal(code(NOTICE, snap({ record: { trader: TRADER, versionId: 1n, active: true } })), "already-synced");
  assert.equal(code(NOTICE, snap({ latest: 2n })), "stale", "鏈上已有更新的版本");
  assert.equal(code({ ...NOTICE, toVersion: 9 }, snap()), "stale", "偽造的未來版本不能騙它付費");
  assert.equal(code(NOTICE, snap({ latest: null })), "stale");
  assert.equal(code(NOTICE, snap({ executor: "0x" + "dd".repeat(20) })), "executor");
  assert.equal(code(NOTICE, snap({ executor: "0x" + "dd".repeat(20) }), null), undefined, "dry-run 沒有金鑰：改用模擬判斷");
  ok("跟單不存在、交易者不符、已同步、版本不是最新、指定別的執行者：都不動作");

  for (const c of ["synced", "dropped", "cooldown", "gas", "consent", "kyc", "market", "capacity", "trader", "config", "unknown"] as const) {
    assert.ok(adviceFor(c).length > 0);
  }
  ok("每一種模擬拒絕分類都有給本人的建議");
}

// ── 4. 訊號與付款判斷 ───────────────────────────────────────────────────────
{
  const good = { ok: true, settled: true, data: { trader: TRADER, strategyVersion: 1 } };
  assert.deepEqual(checkSignal(good, NOTICE), { ok: true, version: 1 });
  const wrong = checkSignal({ ...good, data: { trader: TRADER, strategyVersion: 0 } }, NOTICE);
  assert.ok(!wrong.ok && wrong.version === 0, "版號不符");
  assert.ok(!checkSignal({ ...good, data: { trader: TRADER, strategyVersion: null } }, NOTICE).ok, "沒有策略");
  assert.ok(!checkSignal({ ...good, data: { trader: TRADER, strategyVersion: "1" } }, NOTICE).ok, "字串版號不接受");
  assert.ok(!checkSignal({ ...good, data: { trader: MALLORY, strategyVersion: 1 } }, NOTICE).ok, "別的交易者的訊號");
  assert.ok(!checkSignal({ ok: false, error: "x" }, NOTICE).ok);
  assert.ok(!checkSignal(null, NOTICE).ok);
  ok("checkSignal：只有同一位交易者、版號完全相等才算");

  assert.equal(classifyPayment({ status: 200, sentAtomic: 10_000n }), "paid");
  assert.equal(classifyPayment({ status: 200, sentAtomic: 0n }), "free");
  assert.equal(classifyPayment({ status: null, sentAtomic: 0n }), "not-charged", "拒簽（超過上限）");
  assert.equal(classifyPayment({ status: 400, sentAtomic: 0n }), "not-charged");
  assert.equal(classifyPayment({ status: 402, sentAtomic: 10_000n }), "rejected", "送出授權後回 402：要核對授權才知道有沒有扣款");
  assert.equal(classifyPayment({ status: 402, sentAtomic: 0n }), "not-charged", "沒送出授權的 402");
  assert.equal(classifyPayment({ status: 502, sentAtomic: 10_000n }), "uncertain", "授權已交出");
  assert.equal(classifyPayment({ status: null, sentAtomic: 10_000n }), "uncertain", "斷線");
  ok("classifyPayment：授權交出去但沒拿到成功回應 → 狀態不明，不自動重付");

  const hdr = (name: string, o: unknown) => new Headers({ [name]: Buffer.from(JSON.stringify(o)).toString("base64") });
  assert.equal(paymentTxFromHeaders(hdr("X-PAYMENT-RESPONSE", { success: true, transaction: TX })), TX);
  assert.equal(paymentTxFromHeaders(hdr("PAYMENT-RESPONSE", { success: true, transaction: TX })), TX);
  assert.equal(paymentTxFromHeaders(hdr("X-PAYMENT-RESPONSE", { transaction: "nope" })), null);
  assert.equal(paymentTxFromHeaders(new Headers({ "X-PAYMENT-RESPONSE": "%%%" })), null);
  assert.equal(paymentTxFromHeaders(new Headers()), null);
  ok("從結算證明 header 取付款 tx（v1／v2），解不開回 null");
}

// ── 5. 付款：計量差額照實回報 ───────────────────────────────────────────────
{
  const header = (value: string) => Buffer.from(JSON.stringify({ payload: { authorization: { value } } })).toString("base64");
  const urls: string[] = [];
  const proof = { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: TX })).toString("base64") };
  let mode: "ok" | "gone" = "ok";
  const meter = meteredFetch((async () => {
    if (mode === "gone") throw new Error("socket hang up");
    return new Response(JSON.stringify({ ok: true, data: { trader: TRADER, strategyVersion: 1 } }), { status: 200, headers: proof });
  }) as unknown as typeof fetch);
  // 模擬 wrapFetchWithPayment：帶著 X-PAYMENT 重送。
  const payFetch = (async (url: string, init: RequestInit) => {
    urls.push(url);
    return meter.fetch(url, { ...init, headers: { "X-PAYMENT": header("10000") } });
  }) as unknown as typeof fetch;
  const pay = makeSignalPayer({ api: "http://api.test", payFetch, meter, redact: (s) => s });

  await pay(TRADER.toLowerCase());
  const second = await pay(TRADER.toLowerCase());
  assert.equal(urls[0], `http://api.test/signals/${TRADER}`, "網址用 checksum 地址");
  assert.equal(second.paidAtomic, 10_000n, "是這一次的差額，不是累計");
  assert.equal(second.sentAtomic, 10_000n);
  assert.equal(second.tx, TX);
  assert.equal(second.status, 200);

  mode = "gone";
  const lost = await pay(TRADER.toLowerCase());
  assert.equal(lost.status, null);
  assert.equal(lost.paidAtomic, 0n);
  assert.equal(lost.unsettledAtomic, 10_000n, "斷線：照實記未結算");
  assert.equal(classifyPayment(lost), "uncertain");
  ok("makeSignalPayer：用計量器的差額回報實付與未結算");
}

// ── 6. 完整流程（假鏈＋假付款）─────────────────────────────────────────────
interface Rig {
  chain: FakeChain;
  deps: AgentDeps;
  lines: string[];
  pays: () => number;
  sends: () => number;
  notice: NewVersionNotice;
  setPay: (fn: (t: string) => Promise<PayAttempt>) => void;
}

const paid = (version: number | null = 1): PayAttempt => ({
  status: 200, body: { ok: true, settled: true, data: { trader: TRADER, strategyVersion: version } },
  sentAtomic: 10_000n, paidAtomic: 10_000n, unsettledAtomic: 0n, tx: TX,
});

function rig(opts: { autoSync?: boolean; cooled?: boolean; gas?: boolean; dryRun?: boolean; ledger?: Ledger; onPay?: (c: FakeChain) => void; authUsed?: (from: string, nonce: string) => Promise<boolean> } = {}): Rig {
  const chain = new FakeChain();
  chain.publish(TRADER, [alloc(BTC)]);
  chain.follow(ALICE, TRADER);
  if (opts.autoSync !== false) chain.setAutoSync(ALICE, 0, true, { minSyncInterval: 3600, tipWei: 0n });
  if (opts.gas !== false) chain.deposit(ALICE, 10n ** 16n);
  chain.publish(TRADER, [alloc(ETH)]);
  if (opts.cooled !== false) {
    chain.time += 3600;
    chain.mine();
  }
  const provider = new FakeProvider(chain);
  const wallet = new ExecutorWallet(ethers.Wallet.createRandom().privateKey, { copyTracker: TRACKER_ADDR, chainId: FAKE_CHAIN_ID }, provider);
  const exec = makeExecutor({
    provider, tracker: TRACKER_ADDR, signer: opts.dryRun ? null : new LocalNonceSigner(wallet), address: opts.dryRun ? null : wallet.address,
  });
  let payCount = 0;
  let sendCount = 0;
  let payImpl = async (_t: string): Promise<PayAttempt> => paid();
  const lines: string[] = [];
  const deps: AgentDeps = {
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: { ...exec, send: (...a) => { sendCount++; return exec.send(...a); } },
    pay: async (t) => {
      payCount++;
      const r = await payImpl(t);
      opts.onPay?.(chain);
      return r;
    },
    ledger: opts.ledger ?? emptyLedger(),
    persist: () => {},
    print: (l) => lines.push(l),
    redact: makeRedactor([]),
    txLink: (h) => `https://explorer.test/tx/${h}`,
    dryRun: !!opts.dryRun,
    txTimeoutMs: 200,
    authUsed: opts.authUsed,
    sleep: async (ms) => {
      chain.time += Math.ceil(ms / 1000);
      chain.mine();
    },
  };
  return { chain, deps, lines, pays: () => payCount, sends: () => sendCount, notice: NOTICE, setPay: (fn) => void (payImpl = fn) };
}
const out = (r: Rig) => r.lines.join("\n");

{
  const r = rig();
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.result, "synced");
  assert.equal(r.pays(), 1);
  assert.equal(r.sends(), 1);
  assert.equal(o.paymentTx, TX);
  assert.match(o.syncTx ?? "", /^0x[0-9a-f]{64}$/);
  assert.equal(r.chain.records.get(ALICE.toLowerCase())![0].versionId, 1n, "部位真的到了新版");
  const s = out(r);
  for (const step of ["① 收到新版通知", "② x402 付費買訊號  0.01 USDC", "③ 確認版號", "④ 同步"]) assert.ok(s.includes(step), step);
  assert.ok(s.includes(TX), "印付款 tx");
  assert.ok(s.includes(o.syncTx!), "印同步 tx");
  ok("正常流程：①②③④ 依序，付一次費、同步到新版、印出兩筆 tx");

  const again = await processNotice(r.deps, r.notice);
  assert.equal(again.result, "duplicate");
  assert.equal(r.pays(), 1, "重複通知不再付");
  assert.equal(r.sends(), 1, "重複通知不再送");
  ok("重複通知：不付款、不同步");
}

{
  const r = rig();
  r.setPay(async () => paid(0));
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.result, "mismatch");
  assert.equal(o.paidAtomic, 10_000n);
  assert.equal(r.sends(), 0, "版號不符不同步");
  assert.equal(r.chain.records.get(ALICE.toLowerCase())![0].versionId, 0n);
  assert.match(out(r), /版號不符.*versionId 0.*通知是 1/);
  assert.match(out(r), /費用：本次已付 0\.01 USDC/, "付過的費用照實印");
  assert.equal((await processNotice(r.deps, r.notice)).result, "duplicate");
  assert.equal(r.pays(), 1, "版號不符的同一版不再付第二次");
  ok("版號不符：不同步，費用照實印，同一版不再付");
}

{
  const r = rig({ autoSync: false });
  const o = await processNotice(r.deps, { ...r.notice, autoSync: false });
  assert.equal(o.code, "auto-sync-off");
  assert.equal(r.pays(), 0, "免費檢查就知道不能同步：不花錢");
  assert.equal(r.sends(), 0);
  assert.match(out(r), /本人：.*立即同步/);
  assert.match(out(r), /本次未付費/);
  ok("autoSync 關閉：不付費、不送交易，印原因與本人該怎麼做");
}

{
  const r = rig({ cooled: false });
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.code, "cooldown");
  assert.equal(r.pays(), 0);
  assert.equal(r.sends(), 0);
  assert.match(out(r), /冷卻中，到 \d{4}-/);
  assert.ok(o.retryInSec !== undefined && o.retryInSec > 0 && o.retryInSec <= 3600, "回傳還要等多久，給呼叫端排程");
  // 冷卻結束後重新觸發：這次才付費與同步
  r.chain.time += 3600;
  r.chain.mine();
  assert.equal((await processNotice(r.deps, r.notice)).result, "synced");
  assert.equal(r.pays(), 1);
  ok("冷卻中：不付費、不送交易；冷卻結束後重新觸發會完成");
}

{
  const r = rig({ gas: false });
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.code, "sim-gas", "模擬被擋，分類沿用 copy-sync 的 classifyRevert");
  assert.equal(r.pays(), 0);
  assert.equal(r.sends(), 0);
  assert.match(out(r), /InsufficientSyncGas/);
  assert.match(out(r), /depositSyncGas/);
  ok("模擬被擋：不付費、不送交易，印合約理由與本人該怎麼做");
}

{
  // 付費之後才被擋：費用照實印、再次觸發不重付。
  const r = rig({ onPay: (c) => c.withdraw(ALICE, 10n ** 16n) });
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.code, "sim-gas");
  assert.equal(o.paidAtomic, 10_000n);
  assert.equal(r.sends(), 0);
  assert.match(out(r), /費用：本次已付 0\.01 USDC/);
  r.chain.deposit(ALICE, 10n ** 16n);
  r.lines.length = 0;
  const again = await processNotice(r.deps, r.notice);
  assert.equal(again.result, "synced");
  assert.equal(r.pays(), 1, "第二次沿用已付的訊號");
  assert.match(out(r), /已付過，不重複付款/);
  ok("付費後才被擋：不送交易、費用照實印；處理好再觸發不重付");
}

{
  // 付費期間交易者又發版：resyncFor 會到更新的版本，不能送。
  const r = rig({ onPay: (c) => void c.publish(TRADER, [alloc(BTC)]) });
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.code, "stale");
  assert.equal(r.sends(), 0);
  ok("付費期間交易者又發版：確認過的已不是最新版，不送交易");
}

{
  // 偽造通知：指向未來版本的通知不能騙 agent 付費。
  const r = rig();
  const o = await processNotice(r.deps, { ...r.notice, toVersion: 99, fromVersion: 0 });
  assert.equal(o.code, "stale");
  assert.equal(r.pays(), 0);
  const forged = await processNotice(r.deps, { ...r.notice, trader: MALLORY.toLowerCase() });
  assert.equal(forged.code, "trader-mismatch");
  assert.equal(r.pays(), 0);
  ok("偽造的通知（版本、交易者與鏈上不符）：讀鏈就擋下，不花錢");
}

{
  const r = rig();
  r.setPay(async () => ({ status: null, body: null, sentAtomic: 0n, paidAtomic: 0n, unsettledAtomic: 0n, tx: null, error: "PAYMENT_TOO_HIGH" }));
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.result, "payment-failed");
  assert.equal(r.sends(), 0);
  assert.equal(r.deps.ledger.signals[signalKey(r.notice)], undefined, "沒送出授權：可以重試");
  assert.match(out(r), /X402_MAX_PAYMENT_USDC/);
  r.setPay(async () => paid());
  assert.equal((await processNotice(r.deps, r.notice)).result, "synced");
  ok("超過單筆上限被拒簽：沒付款、不同步，調整後可以重試");

  const u = rig();
  u.setPay(async () => ({ status: null, body: null, sentAtomic: 10_000n, paidAtomic: 0n, unsettledAtomic: 10_000n, tx: null, error: "socket hang up" }));
  const uo = await processNotice(u.deps, u.notice);
  assert.equal(uo.result, "payment-failed");
  assert.equal(u.sends(), 0);
  assert.match(out(u), /0\.01 USDC 的授權已送出、沒看到結算/);
  assert.equal((await processNotice(u.deps, u.notice)).result, "duplicate", "狀態不明：不自動重付");
  assert.equal(u.pays(), 1);
  ok("授權送出後斷線：不同步、印出未結算金額、不自動重付");

  // 行程在付款途中被砍：重啟讀回 paying → 不再付
  const persisted: Ledger[] = [];
  const c = rig();
  c.deps.persist = (l) => void persisted.push(JSON.parse(JSON.stringify(l)) as Ledger);
  await processNotice(c.deps, c.notice);
  assert.equal(persisted[0].signals[signalKey(c.notice)].status, "paying", "付款前先寫入");
  ok("付款前先寫紀錄：中途被砍，重啟不會再付");

  const AUTH = { from: ALICE, nonce: "0x" + "cd".repeat(32), validBefore: 0 };
  const r402 = (c: FakeChain, over: Partial<typeof AUTH> | null = {}): PayAttempt => ({
    status: 402, body: null, sentAtomic: 10_000n, paidAtomic: 0n, unsettledAtomic: 10_000n, tx: null,
    authorizations: over === null ? [null] : [{ ...AUTH, validBefore: c.time + 60, ...over }],
  });
  const checked: string[] = [];
  const rejected = rig({ authUsed: async (_f, nonce) => (checked.push(nonce), false) });
  rejected.setPay(async () => r402(rejected.chain));
  const t0 = rejected.chain.time;
  const ro = await processNotice(rejected.deps, rejected.notice);
  assert.equal(ro.result, "payment-failed");
  assert.equal(rejected.sends(), 0);
  assert.ok(rejected.chain.time > t0 + 60, "等到授權到期才核對");
  assert.deepEqual(checked, [AUTH.nonce], "到鏈上查了這張授權");
  assert.match(out(rejected), /確定沒扣款/);
  assert.doesNotMatch(out(rejected), /授權已送出、沒看到結算/, "確認沒扣款就不再報未結算");
  rejected.setPay(async () => paid());
  assert.equal((await processNotice(rejected.deps, rejected.notice)).result, "synced", "補了 USDC 再觸發可以完成，不會整版卡死");
  ok("伺服器回 402：等授權到期、鏈上確認沒被使用，才當作沒付，可以重試");

  const used = rig({ authUsed: async () => true });
  used.setPay(async () => r402(used.chain));
  assert.equal((await processNotice(used.deps, used.notice)).result, "payment-failed");
  assert.equal(used.deps.ledger.signals[signalKey(used.notice)].status, "uncertain", "授權被用掉了：記成狀態不明");
  assert.match(out(used), /扣了款但沒拿到訊號/);
  used.setPay(async () => paid());
  assert.equal((await processNotice(used.deps, used.notice)).result, "duplicate", "不自動重付");
  assert.equal(used.pays(), 1);
  ok("伺服器回 402 但授權已在鏈上被使用：不自動重付");

  for (const [label, mk, deps] of [
    ["沒有核對手段", (c: FakeChain) => r402(c), {}],
    ["授權解不開", (c: FakeChain) => r402(c, null), { authUsed: async () => false }],
    ["授權有效期太長", (c: FakeChain) => r402(c, { validBefore: c.time + 3600 }), { authUsed: async () => false }],
  ] as const) {
    const x = rig(deps);
    x.setPay(async () => mk(x.chain));
    assert.equal((await processNotice(x.deps, x.notice)).result, "payment-failed", label);
    assert.equal(x.deps.ledger.signals[signalKey(x.notice)].status, "uncertain", label);
  }
  ok("伺服器回 402 但無法核對（沒有查詢、解不開、有效期太長）：當作狀態不明，不自動重付");

  const lost = rig();
  let resets = 0;
  lost.deps.exec = { ...lost.deps.exec, resetNonce: () => void resets++ };
  lost.chain.holdTxs = true;
  const lo = await processNotice(lost.deps, lost.notice);
  assert.equal(lo.result, "unconfirmed");
  assert.equal(resets, 1, "等確認逾時：重新對齊 nonce");
  assert.equal((await processNotice(lost.deps, lost.notice)).result, "duplicate", "未確認不重送");
  ok("同步交易等確認逾時：重新對齊 nonce、不重送");
}

{
  const r = rig({ dryRun: true });
  const o = await processNotice(r.deps, r.notice);
  assert.equal(o.result, "dry-run");
  assert.equal(r.pays(), 0);
  assert.equal(r.sends(), 0);
  assert.deepEqual(r.deps.ledger, emptyLedger(), "dry-run 不寫紀錄");
  assert.equal(r.chain.records.get(ALICE.toLowerCase())![0].versionId, 0n);
  ok("dry-run：只讀鏈與模擬，不付款、不送交易、不寫紀錄");
}

{
  // 第二位跟隨者跟同一位交易者：共用訊號，不再付，但各自同步。
  const r = rig();
  r.chain.follow(BOB, TRADER); // 跟在最新版（versionId 1）
  r.chain.publish(TRADER, [alloc(BTC)]);
  r.chain.setAutoSync(ALICE, 0, true, { minSyncInterval: 3600, tipWei: 0n });
  r.chain.setAutoSync(BOB, 0, true, { minSyncInterval: 3600, tipWei: 0n });
  r.chain.deposit(BOB, 10n ** 16n);
  r.chain.time += 3600;
  r.chain.mine();
  r.setPay(async () => paid(2));
  const a = await processNotice(r.deps, { ...r.notice, fromVersion: 0, toVersion: 2 });
  const b = await processNotice(r.deps, { ...r.notice, follower: BOB.toLowerCase(), fromVersion: 1, toVersion: 2 });
  assert.equal(a.result, "synced");
  assert.equal(b.result, "synced");
  assert.equal(r.pays(), 1, "同一 trader＋toVersion 只付一次");
  assert.equal(r.sends(), 2, "兩位跟隨者各同步一次");
  ok("多位跟隨者跟同一位交易者：訊號只付一次，各自同步");
}

// ── 7. webhook：路由與真的 HTTP ─────────────────────────────────────────────
{
  const req = (over: Partial<Parameters<typeof routeWebhook>[0]> = {}, body: unknown = payload()) => routeWebhook({
    method: "POST", url: "/webhook", headers: { host: "127.0.0.1:8402", "content-type": "application/json" }, rawBody: JSON.stringify(body), ...over,
  }, CFG);
  assert.equal(req().status, 202);
  assert.equal(req().notice?.toVersion, 1);
  assert.equal(req({ url: "/other" }).status, 404);
  assert.equal(req({ method: "GET" }).status, 405);
  assert.equal(req({ headers: { host: "evil.example:8402", "content-type": "application/json" } }).status, 403, "DNS rebinding");
  assert.equal(req({ headers: { host: "127.0.0.1:8402", "content-type": "application/json", origin: "https://evil.example" } }).status, 403, "瀏覽器來源");
  assert.equal(req({ headers: { host: "127.0.0.1:8402", "content-type": "text/plain" } }).status, 415, "簡單請求（不觸發 CORS 預檢）");
  assert.equal(req({ rawBody: "{not json" }).status, 400);
  assert.equal(req({}, payload({ follower: MALLORY })).status, 403);
  assert.equal(req({}, payload({ kind: "resynced" })).status, 200);
  assert.equal(req({}, payload({ kind: "blocked", category: "kyc" })).blocked?.category, "kyc");
  ok("routeWebhook：路徑、方法、Host、Origin、content-type、JSON 都檢查");

  const seen: number[] = [];
  const order: string[] = [];
  const q = makeSerialQueue<number>(
    async (i) => {
      order.push(`start${i}`);
      await new Promise((res) => setTimeout(res, 5));
      if (i === 2) throw new Error("boom");
      order.push(`end${i}`);
    },
    () => seen.push(2),
    3,
  );
  assert.ok(q.push(1) && q.push(2) && q.push(3));
  assert.equal(q.push(4), false, "滿了");
  await q.idle();
  assert.deepEqual(order, ["start1", "end1", "start2", "start3", "end3"], "依序，失敗不影響下一筆");
  assert.deepEqual(seen, [2]);
  ok("佇列依序處理、有上限，單筆失敗不影響後面");

  // copy-sync 真正的 notifier ↔ 真的 HTTP 伺服器（只綁 127.0.0.1）
  const got: NewVersionNotice[] = [];
  const server = createWebhookServer(CFG, (x) => got.push(x) > 0);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as AddressInfo;
  assert.equal(addr.address, "127.0.0.1");
  const url = `http://127.0.0.1:${addr.port}/webhook`;
  const errors: string[] = [];
  const notify = makeWebhookNotifier(url, { onError: (m) => errors.push(m) });
  await notify(payload() as unknown as NotifyPayload);
  assert.deepEqual(errors, []);
  assert.equal(got.length, 1);
  await notify(payload({ follower: MALLORY }) as unknown as NotifyPayload);
  assert.match(errors[0] ?? "", /HTTP 403/);
  const big = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_BODY_BYTES + 1) });
  assert.equal(big.status, 413);
  assert.equal(got.length, 1);
  await new Promise((res) => server.close(res));
  ok("copy-sync 的 webhook notifier 打真的本機伺服器：收得到、白名單外 403、太大 413");
}

// ── 8. copy-sync --notify-only 引擎真正送出的通知，agent 接得住 ─────────────
{
  const chain = new FakeChain();
  chain.publish(TRADER, [alloc(BTC)]);
  chain.follow(ALICE, TRADER);
  chain.setAutoSync(ALICE, 0, true, { minSyncInterval: 3600, tipWei: 0n });
  chain.deposit(ALICE, 10n ** 16n);
  chain.follow(ALICE, TRADER); // #1：沒開自動同步
  const provider = new FakeProvider(chain);
  const cfg: EngineConfig = {
    mode: "personal", followers: [ALICE.toLowerCase()], chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR,
    dryRun: true, notifyOnly: true, confirmations: 0, startBlock: 0, lookbackBlocks: 1000, rescanIntervalSec: 600,
    minTipWei: 0n, maxGasPriceWei: null, maxSendsPerRound: 10, txTimeoutMs: 200,
  };
  const notes: NotifyPayload[] = [];
  const state = emptyState({ chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, scope: scopeOf("personal", [ALICE], true) });
  const engine = new CopySyncEngine({
    cfg, state,
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: makeExecutor({ provider, tracker: TRACKER_ADDR, signer: null, address: null }),
    persist: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    notify: async (p) => void notes.push(p),
    sleep: async () => {},
  });
  await engine.runRound();
  chain.publish(TRADER, [alloc(ETH)]);
  await engine.runRound();
  const nv = notes.filter((x) => x.kind === "new-version");
  assert.equal(nv.length, 2);
  for (const p of nv) {
    const a = admitNotification(JSON.parse(JSON.stringify(p)), { ...CFG, chainId: FAKE_CHAIN_ID });
    assert.equal(a.kind, "accept", "經 JSON 序列化後仍通過驗證");
    if (a.kind === "accept") {
      assert.equal(a.notice.toVersion, 1);
      assert.equal(a.notice.fromVersion, 0);
      assert.equal(a.notice.autoSync, p.recordIdx === 0, "#1 沒開自動同步");
    }
  }
  ok("copy-sync --notify-only 引擎實際送出的 new-version（冷卻中、自動同步關閉兩種）都通過驗證");

  // 重新觸發（x402-copy-agent.md）：冷卻結束後用新的狀態檔跑 notify-only，第一輪就會再通知同一版。
  chain.time += 3600;
  chain.mine();
  const fresh: NotifyPayload[] = [];
  await new CopySyncEngine({
    cfg,
    state: emptyState({ chainId: FAKE_CHAIN_ID, copyTracker: TRACKER_ADDR, registry: REGISTRY_ADDR, scope: scopeOf("personal", [ALICE], true) }),
    reads: makeChainReads(provider, TRACKER_ADDR, REGISTRY_ADDR),
    exec: makeExecutor({ provider, tracker: TRACKER_ADDR, signer: null, address: null }),
    persist: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    notify: async (p) => void fresh.push(p),
    sleep: async () => {},
  }).runRound();
  const re = fresh.find((x) => x.kind === "new-version" && x.recordIdx === 0);
  assert.equal(re?.toVersion, 1, "新的狀態檔：同一版再通知一次");
  assert.equal(re?.retryAt, null, "冷卻已過");
  assert.equal(admitNotification(JSON.parse(JSON.stringify(re)), CFG).kind, "accept");
  ok("重新觸發：新的狀態檔跑 notify-only，第一輪就再送同一版的通知");
}

// ── 7. 授權核對與冷卻重試 ─────────────────────────────────────────────────────
{
  const auth = { from: ALICE, to: BOB, value: "10000", validAfter: "0", validBefore: "1900000000", nonce: "0x" + "AB".repeat(32) };
  const hdr = Buffer.from(JSON.stringify({ x402Version: 1, payload: { signature: "0x", authorization: auth } })).toString("base64");
  assert.deepEqual(parseAuthorization(hdr), { from: ALICE, nonce: "0x" + "ab".repeat(32), validBefore: 1_900_000_000 });
  assert.equal(parseAuthorization("not-base64-json"), null);
  assert.equal(parseAuthorization(Buffer.from(JSON.stringify({ payload: { authorization: { ...auth, nonce: "0x12" } } })).toString("base64")), null);
  const cap = captureAuthorizations(async () => new Response("{}", { status: 402 }));
  await cap.fetch("http://api.test/x", { headers: { "X-PAYMENT": hdr } });
  await cap.fetch("http://api.test/x", { headers: { "PAYMENT-SIGNATURE": "garbage" } });
  await cap.fetch("http://api.test/x");
  const got = cap.drain();
  assert.equal(got.length, 2, "沒帶付款的請求不記");
  assert.equal(got[0]?.nonce, "0x" + "ab".repeat(32));
  assert.equal(got[1], null, "解不開也要記（代表送出了但無法核對）");
  assert.equal(cap.drain().length, 0, "drain 會清空");
  ok("parseAuthorization／captureAuthorizations：記下每張送出的授權");
}

{
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const pushed: NewVersionNotice[] = [];
  const s = makeRetryScheduler((nn) => void pushed.push(nn), {
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clear: (t) => void ((t as { cleared: boolean }).cleared = true),
  });
  assert.equal(s.schedule(NOTICE, 100), 100 + RETRY_MARGIN_SEC);
  assert.equal(timers[0].ms, (100 + RETRY_MARGIN_SEC) * 1000);
  assert.equal(s.schedule(NOTICE, 50), null, "同一筆同一版只排一次");
  assert.equal(s.schedule({ ...NOTICE, toVersion: 2 }, -5), RETRY_MARGIN_SEC, "已經過了也至少等一下");
  timers[0].fn();
  assert.deepEqual(pushed, [NOTICE], "時間到排回佇列");
  assert.equal(s.schedule(NOTICE, 10), 10 + RETRY_MARGIN_SEC, "觸發後可以再排");
  s.cancelAll();
  assert.equal(s.size(), 0);
  assert.ok(timers[1].cleared && timers[2].cleared, "結束時清掉計時器");
  ok("冷卻重試排程：冷卻結束後自動排回佇列，同一版不重複排");
}

{
  // 端到端：冷卻中收到通知 → 排程 → 時間到重跑 → 付費並同步
  const r = rig({ cooled: false });
  const q: NewVersionNotice[] = [];
  let fire: (() => void) | null = null;
  const s = makeRetryScheduler((nn) => void q.push(nn), { set: (fn) => (fire = fn), clear: () => {} });
  const first = await processNotice(r.deps, r.notice);
  assert.equal(first.code, "cooldown");
  s.schedule(r.notice, first.retryInSec!);
  assert.equal(r.pays(), 0);
  r.chain.time += first.retryInSec! + RETRY_MARGIN_SEC;
  r.chain.mine();
  fire!();
  assert.equal((await processNotice(r.deps, q[0])).result, "synced");
  assert.equal(r.pays(), 1);
  ok("冷卻中收到通知：不必重新觸發，冷卻結束自動付費並同步");
}

console.log(`\n全部通過（${n} 項）`);
