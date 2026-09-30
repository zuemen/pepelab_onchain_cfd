// policy gate（policyGate.ts）＋ 簽章守門（signingGuard.ts）逐條單元測試。
// 完全離線：不送任何交易、RPC 指向必定連不上的位址、狀態與稽核寫到暫存目錄。
//   npx tsx examples/policy-gate.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

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
  enforcePolicyGate, readAudit, verifyAuditChain,
  assertSafeTransaction, assertSafeTypedData, checkCalldata, GuardedWallet, guardViemAccount,
  SigningGuardError, MAX_UINT256, MAX_UINT160, makeSigner, openPositionForSession,
} = S;

const AGENT = new ethers.Wallet(AGENT_PK).address;
const KEY = `${AGENT.toLowerCase()}|7`; // policy 狀態鍵：agent|sessionId
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const empty = () => ({ version: 1 as const, agents: {} });
const open = (o: Partial<Parameters<typeof evaluatePolicy>[0]> = {}) => ({
  action: "open" as const, sessionId: 7, agent: AGENT, symbol: "sBTC", isLong: true, marginUsdc: 10, leverage: 2, ...o,
});
let n = 0;
const ok = (msg: string) => console.log(`✓ ${++n}. ${msg}`);
const expectGuard = (fn: () => unknown, code: string) => {
  assert.throws(fn, (e: any) => e instanceof SigningGuardError && e.reasonCode === code);
};
const expectGuardAsync = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: any) => e instanceof SigningGuardError && e.reasonCode === code);
};

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
  // 額度以 (agent, sessionId) 為鍵：另一個 agent、或同一 agent 的另一個 session（另一位客戶）不受影響
  assert.equal(evaluatePolicy(open({ agent: "0x" + "2".repeat(40), marginUsdc: 1 }), big, st, T0).reasonCode, "OK");
  assert.equal(evaluatePolicy(open({ sessionId: 8, marginUsdc: 1 }), big, st, T0).reasonCode, "OK");
  assert.deepEqual(Object.keys(st.agents), [KEY], "狀態鍵 = agent|sessionId");
  // 跨 UTC 日歸零
  const nextDay = Date.UTC(2026, 9, 1, 0, 0, 1);
  assert.equal(evaluatePolicy(open({ marginUsdc: 100 }), big, st, nextDay).reasonCode, "OK");
  ok("每日累計上限：當日 500 用滿後再 1 → DAILY_MARGIN_EXCEEDED；以 agent|sessionId 為鍵，別的 agent / session 不受影響；UTC 跨日歸零");
}

{
  let st: any = empty();
  const c = { ...cfg, maxOrdersPerWindow: 3, windowSec: 60, maxDailyMargin: 10_000 };
  for (let i = 0; i < 3; i++) st = applyReservation(st, open(), c, T0 + i * 1000);
  const d = evaluatePolicy(open(), c, st, T0 + 5000);
  assert.equal(d.reasonCode, "RATE_LIMITED");
  assert.match(d.message, /後再試/);
  // 平倉不計入、也不受開倉的頻率限制（開倉桶已滿仍可平倉）
  const close = { action: "close" as const, sessionId: 7, agent: AGENT, positionId: 1 };
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
  const close = { action: "close" as const, sessionId: 7, agent: AGENT, positionId: 5 };
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

// ─────────────── write.ts 一定經過 policy gate（不送鏈）───────────────
{
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
  assert.ok(recs.some((x) => x.reasonCode === "LEVERAGE_EXCEEDED" && x.allowed === false));
  ok("openPositionForSession 在任何 RPC 之前被 policy gate 擋下（guardStage=policy）");
}

// ─────────────── 簽章守門：calldata ───────────────
const SPENDER = "0x" + "3".repeat(40);
const erc20 = new ethers.Interface([
  "function approve(address,uint256)",
  "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
]);
const permit2 = new ethers.Interface(["function approve(address,address,uint160,uint48)"]);
const dai = new ethers.Interface(["function permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)"]);
const Z32 = ethers.ZeroHash;
{
  expectGuard(() => assertSafeTransaction({ data: erc20.encodeFunctionData("approve", [SPENDER, MAX_UINT256]) }), "UNLIMITED_APPROVE_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: erc20.encodeFunctionData("approve", [SPENDER, 10n ** 18n]) }));
  expectGuard(() => assertSafeTransaction({ data: "0x095ea7b3deadbeef" }), "UNLIMITED_APPROVE_FORBIDDEN");
  ok("approve(MaxUint256) 拒絕；有限額度放行；解不開的 approve calldata fail-closed");

  expectGuard(() => assertSafeTransaction({ data: permit2.encodeFunctionData("approve", [SPENDER, SPENDER, MAX_UINT160, 0]) }), "UNLIMITED_APPROVE_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: permit2.encodeFunctionData("approve", [SPENDER, SPENDER, 5n, 0]) }));
  ok("Permit2 approve(MaxUint160) 拒絕、有限放行");

  expectGuard(() => assertSafeTransaction({ data: erc20.encodeFunctionData("permit", [SPENDER, SPENDER, MAX_UINT256, 0, 27, Z32, Z32]) }), "UNLIMITED_PERMIT_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: erc20.encodeFunctionData("permit", [SPENDER, SPENDER, 1n, 0, 27, Z32, Z32]) }));
  expectGuard(() => assertSafeTransaction({ data: dai.encodeFunctionData("permit", [SPENDER, SPENDER, 0, 0, true, 27, Z32, Z32]) }), "UNLIMITED_PERMIT_FORBIDDEN");
  assert.equal(checkCalldata(dai.encodeFunctionData("permit", [SPENDER, SPENDER, 0, 0, false, 27, Z32, Z32])), null);
  ok("EIP-2612 permit(MaxUint256) 與 DAI permit(allowed=true) 拒絕；有限/撤銷放行");

  expectGuard(() => assertSafeTransaction({ type: 4 }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertSafeTransaction({ type: "eip7702" }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertSafeTransaction({ type: 2, authorizationList: [{ address: SPENDER }] }), "EIP7702_TX_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ type: 2, data: "0x12345678" }));
  ok("type-4 / 'eip7702' / 帶 authorizationList 的交易 → EIP7702_TX_FORBIDDEN");
}

// ─────────────── 簽章守門：絕對額度上限（審查 Medium-2）───────────────
{
  const { DEFAULT_MAX_ALLOWANCE, GUARDED_SELECTORS } = S;
  const CAP = DEFAULT_MAX_ALLOWANCE;
  assert.equal(CAP, 1n << 128n);
  const ext = new ethers.Interface([
    "function increaseAllowance(address,uint256)",
    "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)",
    "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)",
  ]);
  const approve = (v: bigint) => erc20.encodeFunctionData("approve", [SPENDER, v]);
  // 接近 MaxUint 與邊界
  for (const v of [MAX_UINT256 - 1n, MAX_UINT256 / 2n, 1n << 200n, CAP]) {
    expectGuard(() => assertSafeTransaction({ data: approve(v) }), "UNLIMITED_APPROVE_FORBIDDEN");
  }
  assert.doesNotThrow(() => assertSafeTransaction({ data: approve(CAP - 1n) }), "上限 -1 放行");
  // increaseAllowance
  expectGuard(() => assertSafeTransaction({ data: ext.encodeFunctionData("increaseAllowance", [SPENDER, MAX_UINT256 - 5n]) }), "UNLIMITED_APPROVE_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: ext.encodeFunctionData("increaseAllowance", [SPENDER, 10n ** 24n]) }));
  // Permit2 approve：MaxUint160 - 1 仍 ≥ 2^128
  expectGuard(() => assertSafeTransaction({ data: permit2.encodeFunctionData("approve", [SPENDER, SPENDER, MAX_UINT160 - 1n, 0]) }), "UNLIMITED_APPROVE_FORBIDDEN");
  // Permit2 permit(PermitSingle) / permit(PermitBatch)
  const single = (amt: bigint) =>
    ext.encodeFunctionData("permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)", [
      AGENT, [[SPENDER, amt, 0, 0], SPENDER, 0], "0x",
    ]);
  const batch = (amts: bigint[]) =>
    ext.encodeFunctionData("permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)", [
      AGENT, [amts.map((a) => [SPENDER, a, 0, 0]), SPENDER, 0], "0x",
    ]);
  assert.equal(single(1n).slice(0, 10), GUARDED_SELECTORS.permit2Single);
  assert.equal(batch([1n]).slice(0, 10), GUARDED_SELECTORS.permit2Batch);
  expectGuard(() => assertSafeTransaction({ data: single(MAX_UINT160 - 1n) }), "UNLIMITED_PERMIT_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: single(10n ** 20n) }));
  expectGuard(() => assertSafeTransaction({ data: batch([1n, CAP]) }), "UNLIMITED_PERMIT_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: batch([1n, 2n]) }));
  // EIP-2612 permit 接近上限
  expectGuard(() => assertSafeTransaction({ data: erc20.encodeFunctionData("permit", [SPENDER, SPENDER, MAX_UINT256 - 1n, 0, 27, Z32, Z32]) }), "UNLIMITED_PERMIT_FORBIDDEN");
  // typed data：接近上限、DAI allowed truthy
  const permitTypes = { Permit: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }] };
  expectGuard(() => assertSafeTypedData(permitTypes, { value: MAX_UINT256 - 1n }), "UNLIMITED_PERMIT_FORBIDDEN");
  expectGuard(() => assertSafeTypedData(permitTypes, { value: CAP }), "UNLIMITED_PERMIT_FORBIDDEN");
  for (const truthy of [true, 1, "true", "yes"]) {
    expectGuard(() => assertSafeTypedData({ Permit: [] }, { allowed: truthy }, "Permit"), "UNLIMITED_PERMIT_FORBIDDEN");
  }
  assert.doesNotThrow(() => assertSafeTypedData({ Permit: [] }, { allowed: false }, "Permit"));
  expectGuard(() => assertSafeTypedData({}, { details: { amount: MAX_UINT160 - 1n } }, "PermitSingle"), "UNLIMITED_PERMIT_FORBIDDEN");
  expectGuard(() => assertSafeTypedData({}, { permitted: { amount: CAP } }, "PermitTransferFrom"), "UNLIMITED_PERMIT_FORBIDDEN");
  // env 調整上限；不合法 → fail-closed
  process.env.SIGNING_GUARD_MAX_ALLOWANCE = "1000";
  expectGuard(() => assertSafeTransaction({ data: approve(1000n) }), "UNLIMITED_APPROVE_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTransaction({ data: approve(999n) }));
  process.env.SIGNING_GUARD_MAX_ALLOWANCE = "abc";
  expectGuard(() => assertSafeTransaction({ data: approve(1n) }), "GUARD_CONFIG_INVALID");
  delete process.env.SIGNING_GUARD_MAX_ALLOWANCE;
  ok("絕對上限 2^128（>= 即拒）：接近 MaxUint 的 approve/increaseAllowance/permit/Permit2 approve・permit・permitBatch 被擋；DAI allowed truthy 被擋；env 可調、不合法 fail-closed");
}

// ─────────────── 簽章守門：typed data ───────────────
{
  const permitTypes = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  expectGuard(() => assertSafeTypedData(permitTypes, { value: MAX_UINT256 }), "UNLIMITED_PERMIT_FORBIDDEN");
  expectGuard(() => assertSafeTypedData(permitTypes, { value: MAX_UINT256.toString() }), "UNLIMITED_PERMIT_FORBIDDEN");
  assert.doesNotThrow(() => assertSafeTypedData(permitTypes, { value: 1000n }));
  expectGuard(() => assertSafeTypedData({ Permit: [] }, { allowed: true }, "Permit"), "UNLIMITED_PERMIT_FORBIDDEN");
  expectGuard(() => assertSafeTypedData({}, { details: { amount: MAX_UINT160 } }, "PermitSingle"), "UNLIMITED_PERMIT_FORBIDDEN");
  expectGuard(() => assertSafeTypedData({}, { details: [{ amount: 1n }, { amount: MAX_UINT160 }] }, "PermitBatch"), "UNLIMITED_PERMIT_FORBIDDEN");
  // x402 的 EIP-3009 TransferWithAuthorization 必須照常可簽
  assert.doesNotThrow(() => assertSafeTypedData({ TransferWithAuthorization: [] }, { value: 5000n }, "TransferWithAuthorization"));
  ok("typed data：Permit(MaxUint256 / allowed=true)、Permit2 PermitSingle/Batch(MaxUint160) 拒絕；x402 的 TransferWithAuthorization 放行");
}

// ─────────────── GuardedWallet（ethers）───────────────
{
  const signer = makeSigner(new ethers.JsonRpcProvider("http://127.0.0.1:1", 84532, { staticNetwork: true }));
  assert.ok(signer instanceof GuardedWallet, "makeSigner 必須回 GuardedWallet");
  const w = new GuardedWallet(AGENT_PK);
  const baseTx = { chainId: 84532, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, to: SPENDER, value: 0n };
  await expectGuardAsync(w.signTransaction({ ...baseTx, type: 4, authorizationList: [] }), "EIP7702_TX_FORBIDDEN");
  await expectGuardAsync(w.signTransaction({ ...baseTx, type: 2, data: erc20.encodeFunctionData("approve", [SPENDER, MAX_UINT256]) }), "UNLIMITED_APPROVE_FORBIDDEN");
  await expectGuardAsync(w.authorize({ address: SPENDER, nonce: 0, chainId: 84532 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  expectGuard(() => w.authorizeSync({ address: SPENDER, nonce: 0, chainId: 84532 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: SPENDER };
  const permitTypes = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  await expectGuardAsync(w.signTypedData(domain, permitTypes, { owner: AGENT, spender: SPENDER, value: MAX_UINT256, nonce: 0, deadline: 1 }), "UNLIMITED_PERMIT_FORBIDDEN");
  const good = await w.signTransaction({ ...baseTx, type: 2 });
  assert.match(good, /^0x02/);
  assert.ok(w.connect(null) instanceof GuardedWallet, "connect 之後仍是 GuardedWallet");
  ok("GuardedWallet：7702 交易 / authorize / 無上限 approve / Permit typed data 被擋；一般交易照常簽；makeSigner 回 GuardedWallet");
}

// ─────────────── guardViemAccount（x402 路徑）───────────────
{
  const acc = guardViemAccount(privateKeyToAccount(generatePrivateKey()));
  await expectGuardAsync(acc.signTransaction({ type: "eip7702", chainId: 84532, authorizationList: [] } as any), "EIP7702_TX_FORBIDDEN");
  await expectGuardAsync(acc.signTransaction({ type: "eip1559", chainId: 84532, to: SPENDER as any, data: erc20.encodeFunctionData("approve", [SPENDER, MAX_UINT256]) as any }), "UNLIMITED_APPROVE_FORBIDDEN");
  await expectGuardAsync((acc as any).signAuthorization({ address: SPENDER, chainId: 84532, nonce: 0 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  await expectGuardAsync((acc as any).sign({ hash: Z32 }), "RAW_HASH_SIGN_FORBIDDEN");
  await expectGuardAsync(acc.signTypedData({
    domain: { name: "X", version: "1", chainId: 84532 }, primaryType: "Permit",
    types: { Permit: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }] },
    message: { spender: SPENDER, value: MAX_UINT256 },
  } as any), "UNLIMITED_PERMIT_FORBIDDEN");
  const sig = await acc.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: SPENDER as any },
    primaryType: "TransferWithAuthorization",
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    message: { from: acc.address, to: SPENDER as any, value: 5000n, validAfter: 0n, validBefore: 9999999999n, nonce: Z32 as `0x${string}` },
  });
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  ok("guardViemAccount：7702 交易 / signAuthorization / 裸 hash sign / 無上限 approve・Permit 被擋；x402 EIP-3009 照常簽");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ policy-gate.test.ts 全過（${n} 組）`);
