// policy gate（policyGate.ts）逐條單元測試。簽章白名單見 examples/signing-guard.test.ts。
// 完全離線：不送任何交易、RPC 指向必定連不上的位址、狀態與稽核寫到暫存目錄。
//   npx tsx examples/policy-gate.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-policy-"));
const AGENT_PK = ethers.Wallet.createRandom().privateKey;
process.env.AGENT_PRIVATE_KEY = AGENT_PK;
process.env.SESSION_MANAGER_ADDRESS = "0x" + "1".repeat(40);
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.POLICY_STATE_PATH = path.join(TMP, "state.json");
process.env.POLICY_AUDIT_PATH = path.join(TMP, "audit.jsonl");
delete process.env.RISK_GATE_ENABLED;
delete process.env.AGENT_ALLOW_UNSIGNED_TRADES;
for (const k of Object.keys(process.env)) if (k.startsWith("POLICY_") && !/STATE_PATH|AUDIT_PATH/.test(k)) delete process.env[k];

const S = await import("@pepelab/shared");
const {
  DEFAULT_POLICY, evaluatePolicy, applyReservation, releaseReservation, loadPolicyConfig,
  enforcePolicyGate, readAudit, verifyAuditChain, openPositionForSession,
} = S;

const AGENT = new ethers.Wallet(AGENT_PK).address;
const USER = ethers.getAddress("0x" + "c1".repeat(20)); // 鏈上 session.user
const KEY = `${AGENT.toLowerCase()}|${USER.toLowerCase()}`; // 每位客戶的狀態鍵：agent|session.user
const GKEY = `${AGENT.toLowerCase()}|*`; // agent 全域層
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const empty = () => ({ version: 1 as const, agents: {} });
const open = (o: Partial<Parameters<typeof evaluatePolicy>[0]> = {}) => ({
  action: "open" as const, sessionId: 7, agent: AGENT, user: USER, symbol: "sBTC", isLong: true, marginUsdc: 10, leverage: 2, ...o,
});
let n = 0;
const ok = (msg: string) => console.log(`✓ ${++n}. ${msg}`);

// ─────────────── policy gate：逐條規則 ───────────────
const cfg = { ...DEFAULT_POLICY };
assert.equal(evaluatePolicy(open(), cfg, empty(), T0).reasonCode, "OK"); ok("合規的開倉 → OK");

assert.equal(evaluatePolicy(open({ symbol: "sDOGE" }), cfg, empty(), T0).reasonCode, "ASSET_NOT_ALLOWED");
assert.equal(evaluatePolicy(open({ symbol: "sETH" }), { ...cfg, allowedAssets: ["sBTC"] }, empty(), T0).reasonCode, "ASSET_NOT_ALLOWED");
ok("資產白名單：未上架與白名單外 → ASSET_NOT_ALLOWED");

assert.equal(evaluatePolicy(open({ leverage: 6 }), cfg, empty(), T0).reasonCode, "LEVERAGE_EXCEEDED");
assert.equal(evaluatePolicy(open({ leverage: 5 }), cfg, empty(), T0).reasonCode, "OK");
assert.equal(evaluatePolicy(open({ leverage: 1.5 }), cfg, empty(), T0).reasonCode, "LEVERAGE_INVALID");
assert.equal(evaluatePolicy(open({ leverage: 0 }), cfg, empty(), T0).reasonCode, "LEVERAGE_INVALID");
ok("槓桿上限：>5x 拒絕、=5x 放行、非整數/0 → LEVERAGE_INVALID");

assert.equal(evaluatePolicy(open({ marginUsdc: 100.01 }), cfg, empty(), T0).reasonCode, "MARGIN_PER_TRADE_EXCEEDED");
assert.equal(evaluatePolicy(open({ marginUsdc: 100 }), cfg, empty(), T0).reasonCode, "OK");
assert.equal(evaluatePolicy(open({ marginUsdc: -1 }), cfg, empty(), T0).reasonCode, "MARGIN_INVALID");
assert.equal(evaluatePolicy(open({ marginUsdc: NaN }), cfg, empty(), T0).reasonCode, "MARGIN_INVALID");
ok("單筆保證金上限：>100 拒絕、=100 放行、負數/NaN → MARGIN_INVALID");

{
  let st: any = empty();
  const big = { ...cfg, maxOrdersPerWindow: 100 };
  for (let i = 0; i < 5; i++) st = applyReservation(st, open({ marginUsdc: 100 }), big, T0 + i);
  assert.equal(st.agents[KEY].dailyMargin, 500);
  assert.equal(evaluatePolicy(open({ marginUsdc: 1 }), big, st, T0 + 10).reasonCode, "DAILY_MARGIN_EXCEEDED");
  // 額度以 (agent, 鏈上 session.user) 為鍵：同一位使用者換 session 也無法放大額度
  assert.equal(evaluatePolicy(open({ sessionId: 8, marginUsdc: 1 }), big, st, T0 + 10).reasonCode, "DAILY_MARGIN_EXCEEDED", "同一 user 的另一個 session 共用額度");
  assert.equal(evaluatePolicy(open({ sessionId: 999, marginUsdc: 1 }), big, st, T0 + 10).reasonCode, "DAILY_MARGIN_EXCEEDED");
  // 另一位客戶（不同 session.user）、另一個 agent 不受影響
  assert.equal(evaluatePolicy(open({ user: "0x" + "d2".repeat(20), marginUsdc: 1 }), big, st, T0).reasonCode, "OK");
  assert.equal(evaluatePolicy(open({ agent: "0x" + "2".repeat(40), marginUsdc: 1 }), big, st, T0).reasonCode, "OK");
  assert.deepEqual(Object.keys(st.agents).sort(), [KEY, GKEY].sort(), "狀態鍵 = agent|user ＋ agent|*（全域）");
  assert.equal(st.agents[GKEY].dailyMargin, 500, "全域層同步累計");
  // 缺 session.user → fail-closed
  assert.equal(evaluatePolicy(open({ user: "" }), big, empty(), T0).reasonCode, "CONFIG_INVALID");
  // 跨 UTC 日歸零
  const nextDay = Date.UTC(2026, 9, 1, 0, 0, 1);
  assert.equal(evaluatePolicy(open({ marginUsdc: 100 }), big, st, nextDay).reasonCode, "OK");
  ok("每日累計（每位客戶）：500 用滿 → DAILY_MARGIN_EXCEEDED；同 user 換 session 無法放大額度；別的 user / agent 不受影響；UTC 跨日歸零");
}

// agent 全域層：多位客戶、多個 session 合計也無法超過 agent 全域上限
{
  let st: any = empty();
  const c = { ...cfg, maxDailyMargin: 500, maxAgentDailyMargin: 250, maxOrdersPerWindow: 100, maxAgentOrdersPerWindow: 100 };
  const users = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "a3".repeat(20)];
  // 三位客戶、各自不同 session，每位 100 → 第三位只剩 50 → 拒絕
  st = applyReservation(st, open({ user: users[0], sessionId: 1, marginUsdc: 100 }), c, T0);
  st = applyReservation(st, open({ user: users[1], sessionId: 2, marginUsdc: 100 }), c, T0 + 1);
  assert.equal(evaluatePolicy(open({ user: users[2], sessionId: 3, marginUsdc: 100 }), c, st, T0 + 2).reasonCode, "AGENT_DAILY_MARGIN_EXCEEDED");
  assert.equal(evaluatePolicy(open({ user: users[2], sessionId: 3, marginUsdc: 50 }), c, st, T0 + 2).reasonCode, "OK");
  // 全域頻率
  let sr: any = empty();
  const cr = { ...cfg, maxOrdersPerWindow: 100, maxAgentOrdersPerWindow: 3, maxDailyMargin: 10_000, maxAgentDailyMargin: 10_000 };
  for (let i = 0; i < 3; i++) sr = applyReservation(sr, open({ user: users[i], sessionId: i }), cr, T0 + i);
  assert.equal(evaluatePolicy(open({ user: "0x" + "a4".repeat(20), sessionId: 9 }), cr, sr, T0 + 5).reasonCode, "AGENT_RATE_LIMITED");
  // 平倉不受全域層限制
  assert.equal(evaluatePolicy({ action: "close", sessionId: 9, agent: AGENT, user: users[0], positionId: 1 }, cr, sr, T0 + 5).reasonCode, "OK");
  assert.equal(DEFAULT_POLICY.maxAgentDailyMargin, 2000);
  assert.equal(DEFAULT_POLICY.maxAgentOrdersPerWindow, 40);
  ok("agent 全域層：多位客戶／多個 session 合計超過全域每日額度或頻率 → AGENT_DAILY_MARGIN_EXCEEDED / AGENT_RATE_LIMITED；平倉不受全域層限制");
}

{
  let st: any = empty();
  const c = { ...cfg, maxOrdersPerWindow: 3, windowSec: 60, maxDailyMargin: 10_000 };
  for (let i = 0; i < 3; i++) st = applyReservation(st, open(), c, T0 + i * 1000);
  const d = evaluatePolicy(open(), c, st, T0 + 5000);
  assert.equal(d.reasonCode, "RATE_LIMITED");
  assert.match(d.message, /後再試/);
  // 平倉不計入、也不受開倉的頻率限制（開倉桶已滿仍可平倉）
  const close = { action: "close" as const, sessionId: 7, agent: AGENT, user: USER, positionId: 1 };
  assert.equal(evaluatePolicy(close, c, st, T0 + 5000).reasonCode, "OK");
  const afterClose = applyReservation(st, close, c, T0 + 5000);
  assert.equal(afterClose.agents[KEY].orders.length, 3, "平倉不佔開倉的筆數");
  assert.equal(afterClose.agents[KEY].dailyMargin, st.agents[KEY].dailyMargin, "平倉不佔額度");
  // 平倉有自己寬鬆的桶
  let cs: any = empty();
  const cc = { ...c, maxClosesPerWindow: 2 };
  for (let i = 0; i < 2; i++) cs = applyReservation(cs, close, cc, T0 + i);
  assert.equal(evaluatePolicy(close, cc, cs, T0 + 10).reasonCode, "CLOSE_RATE_LIMITED");
  assert.equal(evaluatePolicy(open(), cc, cs, T0 + 10).reasonCode, "OK", "平倉桶滿不影響開倉");
  assert.equal(DEFAULT_POLICY.maxClosesPerWindow > DEFAULT_POLICY.maxOrdersPerWindow, true, "平倉桶比開倉寬鬆");
  // 時間窗滑過後恢復
  assert.equal(evaluatePolicy(open(), c, st, T0 + 61_000).reasonCode, "OK");
  ok("開倉頻率上限：窗內第 4 筆 → RATE_LIMITED；平倉不計入也不受限（獨立寬鬆桶 CLOSE_RATE_LIMITED）；窗滑過後恢復");
}

{
  let st: any = applyReservation(empty(), open({ marginUsdc: 40 }), cfg, T0);
  st = releaseReservation(st, open({ marginUsdc: 40 }), T0);
  assert.equal(st.agents[KEY].dailyMargin, 0);
  assert.equal(st.agents[KEY].orders.length, 0);
  ok("release：送出前失敗 → 額度與筆數歸還");
}

// ─────────────── 設定：env / JSON / fail-closed ───────────────
{
  const c = loadPolicyConfig({ POLICY_MAX_MARGIN_PER_TRADE: "25", POLICY_ALLOWED_ASSETS: "sBTC, sETH", POLICY_MAX_LEVERAGE: "3" } as any);
  assert.equal(c.maxMarginPerTrade, 25);
  assert.deepEqual(c.allowedAssets, ["sBTC", "sETH"]);
  assert.equal(c.maxLeverage, 3);
  const f = path.join(TMP, "policy.json");
  fs.writeFileSync(f, JSON.stringify({ maxDailyMargin: 50, windowSec: 10 }));
  const c2 = loadPolicyConfig({ POLICY_GATE_CONFIG_PATH: f, POLICY_WINDOW_SEC: "20" } as any);
  assert.equal(c2.maxDailyMargin, 50);
  assert.equal(c2.windowSec, 20, "個別 env 覆寫 JSON");
  assert.throws(() => loadPolicyConfig({ POLICY_MAX_LEVERAGE: "abc" } as any));
  assert.throws(() => loadPolicyConfig({ POLICY_MAX_DAILY_MARGIN: "-5" } as any));
  assert.throws(() => loadPolicyConfig({ POLICY_ALLOWED_ASSETS: "sDOGE" } as any));
  ok("設定：env 與 JSON 可覆寫；非法值/未上架資產 → 丟錯");
}

// ─────────────── enforcePolicyGate：稽核＋預留＋fail-closed ───────────────
{
  const statePath = path.join(TMP, "gate-state.json");
  const auditPath = path.join(TMP, "gate-audit.jsonl");
  const g1 = await enforcePolicyGate(open({ marginUsdc: 60 }), { statePath, auditPath, now: () => T0 });
  assert.equal(g1.allowed, true);
  const g2 = await enforcePolicyGate(open({ marginUsdc: 60 }), { statePath, auditPath, now: () => T0 + 1 });
  assert.equal(g2.allowed, true);
  const g3 = await enforcePolicyGate(open({ marginUsdc: 999 }), { statePath, auditPath, now: () => T0 + 2 });
  assert.equal(g3.reasonCode, "MARGIN_PER_TRADE_EXCEEDED");
  await g2.release();
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(st.agents[KEY].dailyMargin, 60, "g2 已釋放，只剩 g1 的 60");

  const recs = readAudit(auditPath) as any[];
  assert.equal(recs.length, 3);
  for (const r of recs) {
    for (const k of ["guardStage", "reasonCode", "allowed", "ts", "sessionId", "agent"]) assert.ok(k in r, `稽核缺 ${k}`);
    assert.equal(r.guardStage, "policy");
    assert.equal(r.agent, AGENT);
    assert.equal(r.sessionId, 7);
  }
  assert.deepEqual(recs.map((r) => r.allowed), [true, true, false]);
  assert.equal(recs[2].reasonCode, "MARGIN_PER_TRADE_EXCEEDED");
  const raw = fs.readFileSync(auditPath, "utf8").toLowerCase();
  assert.ok(!raw.includes(AGENT_PK.slice(2).toLowerCase()), "稽核檔不可含私鑰");
  assert.deepEqual(verifyAuditChain(recs), [], "稽核 hash chain 完整");
  ok("enforcePolicyGate：每次嘗試寫稽核（guardStage/reasonCode/allowed/ts/sessionId/agent）、hash chain 完整、不含私鑰、release 生效");

  fs.writeFileSync(statePath, "{not json");
  const g4 = await enforcePolicyGate(open(), { statePath, auditPath });
  assert.equal(g4.allowed, false);
  assert.equal(g4.reasonCode, "STATE_UNREADABLE");
  const g5 = await enforcePolicyGate(open(), { statePath: path.join(TMP, "s5.json"), auditPath, env: { POLICY_MAX_LEVERAGE: "0" } as any });
  assert.equal(g5.reasonCode, "CONFIG_INVALID");
  const blocker = path.join(TMP, "blocker");
  fs.writeFileSync(blocker, "x"); // 把檔案當目錄用 → 寫稽核必失敗
  const g6 = await enforcePolicyGate(open(), { statePath: path.join(TMP, "s6.json"), auditPath: path.join(blocker, "a.jsonl") });
  assert.equal(g6.reasonCode, "AUDIT_WRITE_FAILED");
  ok("開倉 fail-closed：狀態檔壞 → STATE_UNREADABLE；設定壞 → CONFIG_INVALID；稽核寫不進去 → AUDIT_WRITE_FAILED");

  // 逐筆驗型別：JSON 合法但內容被改壞 → STATE_UNREADABLE（開倉拒絕）
  const good = { day: "2026-09-30", dailyMargin: 10, orders: [T0], closes: [] };
  const bads: unknown[] = [
    { ...good, dailyMargin: -500 },
    { ...good, dailyMargin: "10" },
    { ...good, dailyMargin: null },
    { ...good, day: "yesterday" },
    { ...good, orders: "x" },
    { ...good, orders: [T0, "1"] },
    { ...good, closes: [NaN] },
    null,
    [],
  ];
  for (const [i, b] of bads.entries()) {
    const p = path.join(TMP, `bad-${i}.json`);
    fs.writeFileSync(p, JSON.stringify({ version: 1, agents: { x: b } }));
    const g = await enforcePolicyGate(open(), { statePath: p, auditPath });
    assert.equal(g.reasonCode, "STATE_UNREADABLE", `壞紀錄 #${i} 應被拒：${JSON.stringify(b)}`);
  }
  for (const top of [{ version: 2, agents: {} }, { version: 1, agents: [] }, { version: 1 }]) {
    const p = path.join(TMP, "bad-top.json");
    fs.writeFileSync(p, JSON.stringify(top));
    assert.equal((await enforcePolicyGate(open(), { statePath: p, auditPath })).reasonCode, "STATE_UNREADABLE");
  }
  const okp = path.join(TMP, "legacy-no-closes.json");
  fs.writeFileSync(okp, JSON.stringify({ version: 1, agents: { x: { day: "2026-09-30", dailyMargin: 0, orders: [] } } }));
  assert.equal((await enforcePolicyGate(open(), { statePath: okp, auditPath })).allowed, true, "缺 closes 的舊紀錄可讀");
  ok("狀態檔逐筆驗型別：負數/字串/null 額度、壞日期、壞時間戳、壞頂層 → STATE_UNREADABLE（開倉 fail-closed）");

  // 平倉：同樣的故障一律放行（OK_DEGRADED），印 ::error:: 並在稽核標記 degraded
  const close = { action: "close" as const, sessionId: 7, agent: AGENT, user: USER, positionId: 5 };
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    const auditC = path.join(TMP, "close-audit.jsonl");
    const c1 = await enforcePolicyGate(close, { statePath, auditPath: auditC }); // statePath 仍是壞檔
    assert.equal(c1.allowed, true);
    assert.equal(c1.reasonCode, "OK_DEGRADED");
    assert.deepEqual(c1.degraded, ["STATE_UNREADABLE"]);
    const rec = (readAudit(auditC) as any[]).at(-1);
    assert.deepEqual([rec.allowed, rec.reasonCode, rec.degraded], [true, "OK_DEGRADED", ["STATE_UNREADABLE"]]);
    const c2 = await enforcePolicyGate(close, { statePath: path.join(TMP, "s7.json"), auditPath: path.join(blocker, "b.jsonl") });
    assert.equal(c2.allowed, true);
    assert.ok(c2.degraded?.includes("AUDIT_WRITE_FAILED"));
    const c3 = await enforcePolicyGate(close, { statePath: path.join(TMP, "s8.json"), auditPath: auditC, env: { POLICY_MAX_LEVERAGE: "0" } as any });
    assert.equal(c3.allowed, true);
    assert.deepEqual(c3.degraded, ["CONFIG_INVALID"]);
  } finally {
    console.error = origErr;
  }
  assert.ok(errs.filter((e) => e.startsWith("::error::")).length >= 3, "每次降級放行都有 ::error::");
  ok("平倉 fail-open：狀態檔壞 / 稽核寫不進去 / 設定壞 → 仍放行（OK_DEGRADED），::error:: ＋ 稽核 degraded 標記");

  // 開倉達頻率上限後仍可平倉（經 enforcePolicyGate）
  const sp = path.join(TMP, "s9.json");
  const env = { POLICY_MAX_ORDERS_PER_WINDOW: "2" } as any;
  for (let i = 0; i < 2; i++) assert.equal((await enforcePolicyGate(open(), { statePath: sp, auditPath, env, now: () => T0 + i })).allowed, true);
  assert.equal((await enforcePolicyGate(open(), { statePath: sp, auditPath, env, now: () => T0 + 5 })).reasonCode, "RATE_LIMITED");
  const cl = await enforcePolicyGate(close, { statePath: sp, auditPath, env, now: () => T0 + 6 });
  assert.equal(cl.allowed, true);
  assert.equal(cl.reasonCode, "OK");
  assert.equal((await enforcePolicyGate(open(), { statePath: sp, auditPath, env, now: () => T0 + 7 })).reasonCode, "RATE_LIMITED", "平倉不會把開倉額度還回去");
  ok("開倉達頻率上限後仍可平倉");
}

// ─────────────── write.ts 一定經過 policy gate（VC 閘、風險閘之後；簽章、廣播之前）───────────────
{
  // 額度以鏈上 session.user 為鍵 → write.ts 會先讀 sessions()；用假節點回答（不連真實網路）。
  const { startFakeRpc, sessionsHandler } = await import("./fixtures/fakeRpc.ts");
  const rpc = await startFakeRpc(sessionsHandler({ user: USER, agent: AGENT }));
  process.env.BASE_SEPOLIA_RPC_URL = rpc.url;
  const r = await openPositionForSession({
    sessionId: 7, symbol: "sBTC", isLong: true, marginUsdc: 5000, leverage: 2, allowUnsignedForTesting: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.guardStage, "policy");
  assert.equal(r.reasonCode, "MARGIN_PER_TRADE_EXCEEDED");
  const r2 = await openPositionForSession({
    sessionId: 7, symbol: "sBTC", isLong: true, marginUsdc: 5, leverage: 20, allowUnsignedForTesting: true,
  });
  assert.equal(r2.reasonCode, "LEVERAGE_EXCEEDED");
  const recs = readAudit(process.env.POLICY_AUDIT_PATH!) as any[];
  assert.ok(recs.some((x) => x.reasonCode === "LEVERAGE_EXCEEDED" && x.allowed === false && x.request.user === USER), "稽核記下鏈上 session.user");
  assert.ok(rpc.calls.every((m) => m === "eth_call"), "只有唯讀 eth_call，沒有任何交易");
  await rpc.close();
  process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
  // 實際順序：VC 閘（本例以 allowUnsignedForTesting 略過）→ 風險閘（預設關）→ 讀鏈上 session.user → policy gate → 簽章 → 廣播。
  ok("openPositionForSession：VC 閘與風險閘之後、簽章與廣播之前被 policy gate 擋下（guardStage=policy，未送交易；額度鍵取自鏈上 session.user）");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ policy-gate.test.ts 全過（${n} 組）`);
