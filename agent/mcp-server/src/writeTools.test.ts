// MCP 寫入工具的人類確認流程測試（純邏輯，假依賴，不送任何交易、不連 RPC）。
//   npx tsx mcp-server/src/writeTools.test.ts
import assert from "node:assert";
import {
  WriteConfirmStore,
  createWriteHandlers,
  writeConfirmRequired,
  estimateFees,
  TOOL_ANNOTATIONS,
  CONFIRM_TTL_MS,
  CONFIRM_DISABLED_WARNING,
  type WriteToolDeps,
} from "./writeTools.ts";

let clock = 1_000_000;
const now = () => clock;

function makeDeps(over: Partial<WriteToolDeps> = {}) {
  const calls = { open: 0, close: 0, warnings: [] as string[], preview: [] as unknown[] };
  const deps: WriteToolDeps = {
    requireConfirm: true,
    store: new WriteConfirmStore(CONFIRM_TTL_MS, now),
    open: async () => { calls.open++; return { ok: true, txHash: "0xabc", positionId: "9" }; },
    close: async () => { calls.close++; return { ok: true, txHash: "0xdef" }; },
    readFees: async () => ({ tradingFeeBps: 10, executionFeeEth: "0.001" }),
    readPosition: async () => ({ asset: "sETH", isLong: false, marginUsdc: 20, leverage: 3, isOpen: true }),
    policyPreview: (r) => { calls.preview.push(r); return { allowed: true, reasonCode: "OK", message: "policy gate 通過" }; },
    warn: (m) => calls.warnings.push(m),
    ...over,
  };
  return { deps, calls, h: createWriteHandlers(deps) };
}

const VC = JSON.stringify({ proof: { proofValue: "0x00" } });
const OPEN = { sessionId: 6, asset: "sBTC", isLong: true, marginUsdc: 50, leverage: 4, authVcJson: VC };
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// 1) 第一次呼叫：不送交易，回摘要＋確認碼
{
  const { h, calls } = makeDeps();
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "ok");
  assert.equal(calls.open, 0, "第一次呼叫絕不送交易");
  assert.equal(r.data.status, "confirmation_required");
  assert.equal(r.data.txSent, false);
  const s = r.data.summary;
  assert.deepEqual(
    [s.asset, s.direction, s.marginUsdc, s.leverage, s.notionalUsdc],
    ["sBTC", "long", 50, 4, 200],
  );
  assert.equal(s.estimatedFees.tradingFeeUsdc, 0.2, "200 × 10bps = 0.2 USDC");
  assert.equal(s.estimatedFees.executionFeeEth, "0.001");
  assert.equal(s.policyPreview.reasonCode, "OK");
  assert.match(r.data.confirmationCode, /^[0-9A-F]{10}$/);
  assert.equal(r.data.ttlSec, 120);
  ok("open 第一次呼叫：不送交易，回標的/方向/保證金/槓桿/估計手續費/policy 預檢＋一次性確認碼（120s）");

  // 2) 帶碼再呼叫 → 送出
  const r2: any = await h.openPosition({ ...OPEN, confirmationCode: r.data.confirmationCode });
  assert.equal(r2.kind, "ok");
  assert.equal(calls.open, 1);
  assert.equal(r2.data.txHash, "0xabc");
  ok("帶正確確認碼＋相同參數 → 才真正送出");

  // 3) 同一個碼不能重用
  const r3: any = await h.openPosition({ ...OPEN, confirmationCode: r.data.confirmationCode });
  assert.equal(r3.kind, "fail");
  assert.match(r3.message, /CONFIRM_CODE_UNKNOWN/);
  assert.equal(calls.open, 1);
  ok("確認碼一次性：重放 → CONFIRM_CODE_UNKNOWN，不送出");
}

// 4) 換參數 → 碼失效
{
  const { h, calls } = makeDeps();
  const r: any = await h.openPosition(OPEN);
  const r2: any = await h.openPosition({ ...OPEN, marginUsdc: 5000, confirmationCode: r.data.confirmationCode });
  assert.equal(r2.kind, "fail");
  assert.match(r2.message, /CONFIRM_PARAMS_MISMATCH/);
  assert.equal(calls.open, 0);
  // 失敗後原碼也已作廢（防止先試探再用）
  const r3: any = await h.openPosition({ ...OPEN, confirmationCode: r.data.confirmationCode });
  assert.match(r3.message, /CONFIRM_CODE_UNKNOWN/);
  ok("確認後換參數（保證金 50→5000）→ CONFIRM_PARAMS_MISMATCH；原碼同時作廢");
}

// 5) 過期
{
  const { h, calls } = makeDeps();
  const r: any = await h.openPosition(OPEN);
  clock += CONFIRM_TTL_MS + 1;
  const r2: any = await h.openPosition({ ...OPEN, confirmationCode: r.data.confirmationCode });
  assert.match(r2.message, /CONFIRM_CODE_EXPIRED/);
  assert.equal(calls.open, 0);
  ok("超過 120 秒 → CONFIRM_CODE_EXPIRED，不送出");
}

// 6) 亂猜的碼
{
  const { h, calls } = makeDeps();
  await h.openPosition(OPEN);
  const r: any = await h.openPosition({ ...OPEN, confirmationCode: "0000000000" });
  assert.match(r.message, /CONFIRM_CODE_UNKNOWN/);
  assert.equal(calls.open, 0);
  ok("不存在的碼 → 拒絕");
}

// 7) close 同樣兩步、摘要含部位資訊
{
  const { h, calls } = makeDeps();
  const args = { sessionId: 6, positionId: 42, authVcJson: VC };
  const r: any = await h.closePosition(args);
  assert.equal(calls.close, 0);
  const s = r.data.summary;
  assert.deepEqual([s.asset, s.direction, s.marginUsdc, s.leverage, s.notionalUsdc], ["sETH", "short", 20, 3, 60]);
  assert.equal(s.estimatedFees.tradingFeeUsdc, 0.06);
  const r2: any = await h.closePosition({ ...args, confirmationCode: r.data.confirmationCode });
  assert.equal(r2.kind, "ok");
  assert.equal(calls.close, 1);
  // 開倉的碼不能拿來平倉
  const o: any = await h.openPosition(OPEN);
  const r3: any = await h.closePosition({ ...args, confirmationCode: o.data.confirmationCode });
  assert.equal(r3.kind, "fail");
  assert.equal(calls.close, 1);
  ok("close_position 兩步流程；摘要含標的/方向/保證金/槓桿/手續費；open 的碼不能用在 close");
}

// 8) RPC 讀不到手續費 → 摘要仍回（欄位 null），不擋流程
{
  const { h } = makeDeps({ readFees: async () => { throw new Error("rpc down"); } });
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.data.summary.estimatedFees.tradingFeeUsdc, null);
  assert.ok(r.data.confirmationCode);
  ok("手續費讀取失敗 → 欄位 null，仍可確認");
}

// 9) 關閉確認：直接送出並警告
{
  const { h, calls } = makeDeps({ requireConfirm: false });
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "ok");
  assert.equal(calls.open, 1);
  assert.ok(calls.warnings.includes(CONFIRM_DISABLED_WARNING));
  assert.equal(writeConfirmRequired({} as any), true, "預設開啟");
  assert.equal(writeConfirmRequired({ MCP_WRITE_REQUIRE_CONFIRM: "false" } as any), false);
  assert.equal(writeConfirmRequired({ MCP_WRITE_REQUIRE_CONFIRM: "0" } as any), true, "只有明確 false 才關");
  ok("MCP_WRITE_REQUIRE_CONFIRM：預設開；只有明確 false 才關，關閉時每次寫入都警告");
}

// 10) 下游（write.ts，含 policy gate）拒絕 → 工具回錯誤
{
  const { h } = makeDeps({
    open: async () => ({ ok: false, error: "拒絕下單（policy gate LEVERAGE_EXCEEDED）：槓桿 20x 超過政策上限 5x" }),
  });
  const r: any = await h.openPosition(OPEN);
  const r2: any = await h.openPosition({ ...OPEN, confirmationCode: r.data.confirmationCode });
  assert.equal(r2.kind, "fail");
  assert.match(r2.message, /policy gate LEVERAGE_EXCEEDED/);
  ok("確認後仍經 write.ts 的 policy gate；被擋時回 isError");
}

// 11) VC JSON 壞掉 → 連摘要都不給
{
  const { h, calls } = makeDeps();
  const r: any = await h.openPosition({ ...OPEN, authVcJson: "{bad" });
  assert.equal(r.kind, "fail");
  assert.equal(calls.open, 0);
  ok("authVcJson 無法解析 → 直接拒絕");
}

// 12) annotations
{
  for (const t of ["open_position", "close_position"] as const) {
    const a = TOOL_ANNOTATIONS[t];
    assert.equal(a.destructiveHint, true);
    assert.equal(a.readOnlyHint, false);
    assert.equal(a.idempotentHint, false);
  }
  assert.equal(TOOL_ANNOTATIONS.read.readOnlyHint, true);
  assert.deepEqual(estimateFees(null, { tradingFeeBps: 10, executionFeeEth: null }).tradingFeeUsdc, null);
  ok("tool annotations：寫入工具 destructiveHint=true / readOnlyHint=false / idempotentHint=false；讀取工具 readOnlyHint=true");
}

console.log(`\n✅ mcp-server writeTools.test.ts 全過（${n} 組）`);
