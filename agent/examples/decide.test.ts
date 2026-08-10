// 稽核 A-1（Critical）的回歸測試：**錯誤回應絕不可以變成交易方向**。
//
// 原始缺陷：`const data = body?.data ?? body` + `decide()` 只檢查 `!d || d.isStale`。
// 於是 503 `price_stale`、402 未付款、HTML 錯誤頁等 body 全都變成「資料」，
// `recommendation` 是 `undefined` → 不等於 `"no_trade"` → `isLong = false`
// → 送出真實 SHORT 單。這支測試把每一種已知的壞回應都餵進去，要求一律 skip。
//
//   npx tsx examples/decide.test.ts
import assert from "node:assert";
import { decide } from "./x402-autonomous.ts";
import { parseOracleBody, parseSignalsBody, VALID_RECOMMENDATIONS } from "@pepelab/shared";

const LIMITS = {
  wantMargin: 50,
  wantLeverage: 3,
  sessionMaxPerTrade: 1000,
  sessionRemainingBudget: 3000,
  sessionMaxLev: 5,
};

/** 一份合法的 enriched oracle 快照（server 真的會回的形狀）。 */
function goodData(over: Record<string, unknown> = {}) {
  return {
    asset: "sBTC", price: 64578.12, fundingRateBps: -60, oiImbalance: -0.5,
    isStale: false, tradableNow: true, maintenanceMarginBps: 500,
    edgeScore: 68, recommendation: "long", confidence: 68,
    ...over,
  };
}

// ── 這些是真實抓到會下單的壞 body ───────────────────────────────────────────
const BAD_BODIES: Array<{ label: string; body: unknown; status?: number }> = [
  {
    label: "503 price_stale（本分支新加的 stale 閘門回的就是它）",
    status: 503,
    body: { ok: false, error: "price_stale", message: "sAAPL 的鏈上價格已 228 小時未更新", asset: "sAAPL", ageSec: 820000 },
  },
  {
    label: "402 未付款（x402 的付款需求）",
    status: 402,
    body: { x402Version: 1, accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "5000" }], error: "X-PAYMENT header is required" },
  },
  { label: "400 未知資產", status: 400, body: { ok: false, error: '未知資產 "sDOGE"' } },
  { label: "500 空 body", status: 500, body: null },
  { label: "200 但 ok:false", status: 200, body: { ok: false, error: "RPC timeout" } },
  { label: "200 但沒有 data", status: 200, body: { ok: true } },
  { label: "200 但 data 是字串", status: 200, body: { ok: true, data: "sBTC" } },
  { label: "HTML 錯誤頁被硬 parse 成字串", status: 200, body: "<html>502 Bad Gateway</html>" },
  { label: "data 缺 recommendation", status: 200, body: { ok: true, data: goodData({ recommendation: undefined }) } },
  { label: "data.recommendation 是未知動作", status: 200, body: { ok: true, data: goodData({ recommendation: "liquidate_everything" }) } },
  { label: "data.recommendation 是 null", status: 200, body: { ok: true, data: goodData({ recommendation: null }) } },
  { label: "data.price 缺漏", status: 200, body: { ok: true, data: goodData({ price: undefined }) } },
  { label: "data.price 為 0", status: 200, body: { ok: true, data: goodData({ price: 0 }) } },
  { label: "data.fundingRateBps 是字串", status: 200, body: { ok: true, data: goodData({ fundingRateBps: "-60" }) } },
];

for (const { label, body, status } of BAD_BODIES) {
  const parsed = parseOracleBody(body, status);
  assert.equal(parsed.ok, false, `parseOracleBody 應拒絕：${label}`);

  // 同時測「整包 body 餵進 decide」與「舊寫法 body?.data ?? body 的結果餵進 decide」，
  // 兩條路徑都不可以產生方向。
  const legacyData = (body as any)?.data ?? body;
  for (const [how, data] of [["整包 body", body], ["body?.data ?? body（舊寫法）", legacyData]] as const) {
    const dec = decide({ ...LIMITS, data, httpStatus: status });
    assert.equal(
      dec.action,
      "skip",
      `❌ ${label} 經「${how}」得到 action=${dec.action}（應為 skip）— 這正是 A-1 的下單路徑`,
    );
  }
}
console.log(`✓ ${BAD_BODIES.length} 種壞回應 × 2 種餵法，全部 skip（無一產生方向）`);

// ── 合法資料仍然要能正常做出決策（修正不能把功能改死）───────────────────────
{
  const dec = decide({ ...LIMITS, data: { ok: true, data: goodData() }, httpStatus: 200 });
  assert.equal(dec.action, "long", dec.reason);
  assert.equal(dec.leverage, 3);
  assert.equal(dec.margin, 50);
}
{
  // 已剝出的 data 也要能吃（呼叫端有兩種寫法）。
  const dec = decide({ ...LIMITS, data: goodData({ recommendation: "short", edgeScore: -68 }) });
  assert.equal(dec.action, "short", dec.reason);
}
{
  const dec = decide({ ...LIMITS, data: goodData({ recommendation: "no_trade", edgeScore: 3 }) });
  assert.equal(dec.action, "skip");
}
console.log("✓ 合法資料仍可正常產生 long / short / no_trade 決策");

// ── 新鮮度：tradableNow 是判準（A-6）───────────────────────────────────────
{
  // MockOracle 的 24h isStale 說「不 stale」，但交易所的 maxPriceAge 已超過 →
  // 必須 skip，否則開倉會在鏈上 revert StalePrice。
  const dec = decide({ ...LIMITS, data: goodData({ isStale: false, tradableNow: false }) });
  assert.equal(dec.action, "skip", "tradableNow=false 必須 skip");
  assert.ok(dec.reason.includes("maxPriceAge"), dec.reason);
}
{
  const dec = decide({ ...LIMITS, data: goodData({ isStale: true, tradableNow: undefined }) });
  assert.equal(dec.action, "skip");
}
console.log("✓ tradableNow=false 一律 skip（不再只看 24h 的 isStale）");

// ── CLI 參數非法不得變成 NaN 下單 ──────────────────────────────────────────
assert.equal(decide({ ...LIMITS, wantMargin: Number.NaN, data: goodData() }).action, "skip");
assert.equal(decide({ ...LIMITS, wantLeverage: Number.NaN, data: goodData() }).action, "skip");
assert.equal(decide({ ...LIMITS, wantMargin: -50, data: goodData() }).action, "skip");
console.log("✓ 非法保證金/槓桿參數一律 skip");

// ── 額度閘門仍生效 ─────────────────────────────────────────────────────────
assert.equal(
  decide({ ...LIMITS, sessionRemainingBudget: 10, data: goodData() }).action,
  "skip",
  "超過 session 剩餘預算必須 skip",
);
assert.equal(decide({ ...LIMITS, sessionMaxPerTrade: 0, data: goodData() }).action, "long");
console.log("✓ session 額度閘門仍生效");

// ── 白名單本身 ─────────────────────────────────────────────────────────────
assert.deepEqual([...VALID_RECOMMENDATIONS], ["long", "short", "no_trade"]);

// ── /signals 的解析（buy-signal / autotrade 共用）───────────────────────────
assert.equal(parseSignalsBody({ ok: false, error: "boom" }, 200).ok, false);
assert.equal(parseSignalsBody({ ok: true }, 200).ok, false);
assert.equal(parseSignalsBody(null, 502).ok, false);
assert.equal(
  parseSignalsBody({ ok: true, data: { trader: "0x" + "1".repeat(40), suggestion: [] } }, 200).ok,
  true,
);
console.log("✓ /signals 回應解析（錯誤 body 不會變成訊號）");

console.log("\n✅ decide.test.ts 全過（A-1 回歸測試）");
