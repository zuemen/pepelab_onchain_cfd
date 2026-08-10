// 純函式測試：付費 API 的新鮮度判準必須與交易所一致。
//   cd agent && npx tsx examples/freshness.test.ts
import assert from "node:assert";
import { classifyTradeFreshness } from "@pepelab/shared";

// 交易所（Base Sepolia 實測值）：maxPriceAge = 21600 秒 = 6 小時
const MAX = 21600;

assert.equal(classifyTradeFreshness({ updatedAtSec: 1000, nowSec: 1060, maxPriceAgeSec: MAX }).fresh, true);
assert.equal(classifyTradeFreshness({ updatedAtSec: 0, nowSec: MAX, maxPriceAgeSec: MAX }).fresh, true);
assert.equal(classifyTradeFreshness({ updatedAtSec: 0, nowSec: MAX + 1, maxPriceAgeSec: MAX }).fresh, false);

// 這是最重要的一條：MockOracle.isStale 的門檻是 24 小時，交易所是 6 小時。
// 落在兩者之間時，舊的 snapshot 會說「不 stale、建議做多」，agent 照做，
// 然後 openPositionForSession 直接 revert StalePrice。
const between = classifyTradeFreshness({ updatedAtSec: 0, nowSec: 12 * 3600, maxPriceAgeSec: MAX });
assert.equal(between.fresh, false, "6–24 小時之間必須判為不可交易");
assert.equal(between.ageSec, 12 * 3600);

// 2026-08-06 的線上情況：Base Sepolia sBTC 9.5 天沒更新
const live = classifyTradeFreshness({ updatedAtSec: 1785162620, nowSec: 1785982648, maxPriceAgeSec: MAX });
assert.equal(live.fresh, false);
assert.ok(live.ageSec > 9 * 86400);

// 未來時間戳不產生負數
assert.equal(classifyTradeFreshness({ updatedAtSec: 2000, nowSec: 1000, maxPriceAgeSec: MAX }).ageSec, 0);

console.log("freshness.test.ts ✓ all assertions passed");
