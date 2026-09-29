// marketOperator 休市切換：只測純函式的決策部分（不碰鏈）。
//   cd agent && npx tsx keeper/operator.test.ts
import assert from "node:assert";
import { ASSET_MODE, classifyProbeError, decideAssetMode, switchesMode } from "./operator.ts";
import type { MarketSession } from "./market.ts";

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const TUE: MarketSession = {
  regularStart: utc(2026, 9, 29, 13, 30),
  regularEnd: utc(2026, 9, 29, 20, 0),
  regularMarketTime: utc(2026, 9, 29, 15, 55),
};
const TUE_MIDDAY = utc(2026, 9, 29, 16, 0);
const TUE_NIGHT = utc(2026, 9, 30, 2, 0); // 週二 22:00 EDT
const SAT_NOON = utc(2026, 10, 3, 15, 0);
const FRI: MarketSession = {
  regularStart: utc(2026, 10, 2, 13, 30),
  regularEnd: utc(2026, 10, 2, 20, 0),
  regularMarketTime: utc(2026, 10, 2, 20, 0),
};

// ── 哪些資產會被切換 ────────────────────────────────────────────────────
assert.equal(switchesMode("sAAPL"), true);
assert.equal(switchesMode("sICLN"), true, "ETF 也是股票類");
assert.equal(switchesMode("sBTC"), false);
assert.equal(switchesMode("sGOLD"), false, "期貨每日休息 1h，不切");
assert.equal(switchesMode("sNEW"), false, "未分類資產當 crypto，不切");

// ── 休市 → ReduceOnly；開盤 → Active ─────────────────────────────────────
{
  const d = decideAssetMode({ symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: FRI });
  assert.equal(d.action, "set");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
}
{
  const d = decideAssetMode({ symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: TUE });
  assert.equal(d.action, "set");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.Active);
}
// 平日收盤後也切 ReduceOnly（session 仍是當天，now 已過 end）。
assert.equal(
  decideAssetMode({ symbol: "sTSLA", nowSec: TUE_NIGHT, currentMode: ASSET_MODE.Active, session: TUE }).action,
  "set",
);

// ── 已是目標模式 → 不送交易（冪等） ───────────────────────────────────────
assert.equal(
  decideAssetMode({ symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.ReduceOnly, session: FRI }).action,
  "skip",
);
assert.equal(
  decideAssetMode({ symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.Active, session: TUE }).action,
  "skip",
);

// ── 加密資產永遠不動 ─────────────────────────────────────────────────────
assert.equal(
  decideAssetMode({ symbol: "sBTC", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: null }).action,
  "skip",
);

// ── Halted 絕不碰（marketOperator 在合約上也無權） ────────────────────────
for (const now of [SAT_NOON, TUE_MIDDAY]) {
  const d = decideAssetMode({ symbol: "sAAPL", nowSec: now, currentMode: ASSET_MODE.Halted, session: TUE });
  assert.equal(d.action, "skip");
  assert.ok(d.reason.includes("Halted"), d.reason);
}
// 讀不到模式／未知模式 → 不動。
assert.equal(decideAssetMode({ symbol: "sAAPL", nowSec: SAT_NOON, currentMode: null, session: FRI }).action, "skip");
assert.equal(decideAssetMode({ symbol: "sAAPL", nowSec: SAT_NOON, currentMode: 7, session: FRI }).action, "skip");

// ── 沒有 Yahoo 時段：行事曆只准收緊，不准放寬 ─────────────────────────────
{
  const d = decideAssetMode({ symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: null });
  assert.equal(d.action, "set", "行事曆說休市 → 可切 ReduceOnly");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
}
{
  const d = decideAssetMode({ symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: null });
  assert.equal(d.action, "skip", "行事曆不含假日，不能據以切回 Active");
}

// ── 探測錯誤分類：舊 exchange 沒有函式 → missing，略過 ────────────────────
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x" }), "missing");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: null }), "missing");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION" }), "missing");
// AssetModeChangeNotAllowed(...) 之類的 custom error → 函式存在但被拒。
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x1234abcd0000" }), "denied");
// assetMode() 已讀成功後，setAssetMode 的空 revert → denied（記 failed），不是 missing。
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x" }, { functionExists: true }), "denied");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION" }, { functionExists: true }), "denied");
assert.equal(classifyProbeError({ code: "TIMEOUT" }, { functionExists: true }), "error");
// 網路／逾時 → 不下結論。
assert.equal(classifyProbeError({ code: "TIMEOUT" }), "error");
assert.equal(classifyProbeError({ code: "SERVER_ERROR", data: "0x" }), "error");
assert.equal(classifyProbeError(null), "error");

console.log("operator.test.ts ✓ all assertions passed");
