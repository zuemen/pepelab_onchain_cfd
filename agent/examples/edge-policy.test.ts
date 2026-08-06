// 純函式測試：Part A 的 edge 政策（可測、透明）。
//   npx tsx examples/edge-policy.test.ts
import assert from "node:assert";
import { computeOiImbalance, estLiquidationPrices, computeEdge, enrichOracle } from "@pepelab/shared";

// OI 失衡
assert.equal(computeOiImbalance(0, 0), 0);
assert.equal(computeOiImbalance(300, 100), 0.5);
assert.equal(computeOiImbalance(100, 300), -0.5);

// 清算價：1x 多單 liq = entry×(1-1+0.05)=0.05×entry；空單=entry×(1+1-0.05)=1.95×entry
const liq = estLiquidationPrices(1000);
assert.equal(liq.long["1x"], 50);     // 1000×0.05
assert.equal(liq.short["1x"], 1950);  // 1000×1.95
assert.ok(liq.long["5x"] > liq.long["1x"]); // 高槓桿清算更近現價
console.log("liq(1000):", JSON.stringify(liq));

// edge：funding 負（shorts_pay=偏多）→ 正分 → long
const longCase = computeEdge({ fundingRateBps: -60, oiImbalance: -0.5, isStale: false });
assert.equal(longCase.recommendation, "long");
assert.ok(longCase.edgeScore >= 25);

// funding 正（longs_pay=偏空）+ 多方擁擠 → short
const shortCase = computeEdge({ fundingRateBps: 60, oiImbalance: 0.8, isStale: false });
assert.equal(shortCase.recommendation, "short");

// 弱訊號 → no_trade
const weak = computeEdge({ fundingRateBps: 5, oiImbalance: 0.05, isStale: false });
assert.equal(weak.recommendation, "no_trade");

// stale → 一律 no_trade（即使分數夠）
const stale = computeEdge({ fundingRateBps: -60, oiImbalance: -0.5, isStale: true });
assert.equal(stale.recommendation, "no_trade");

// ── A-6：判準是交易所的 maxPriceAge（tradableNow），不是 24h 的 isStale ────
// 6–24 小時之間：MockOracle 說「不 stale」，但此刻開倉會 revert StalePrice。
// 舊版會回 recommendation:"long"，agent 照做然後被鏈上打回。
const between = computeEdge({ fundingRateBps: -60, oiImbalance: -0.5, isStale: false, tradableNow: false });
assert.equal(between.recommendation, "no_trade", "tradableNow=false 必須 no_trade");
assert.ok(between.reason.includes("maxPriceAge"), between.reason);
// tradableNow 優先於 isStale（兩者衝突時以交易所判準為準）。
assert.equal(
  computeEdge({ fundingRateBps: -60, oiImbalance: -0.5, isStale: true, tradableNow: true }).recommendation,
  "long",
);
// 兩者皆缺 → 保守判為不可交易（不猜）。
assert.equal(computeEdge({ fundingRateBps: -60, oiImbalance: -0.5 }).recommendation, "no_trade");

// enrichOracle 整合
const e = enrichOracle({ price: 50000, fundingRateBps: -50, longOpenInterest: 100, shortOpenInterest: 300, isStale: false, tradableNow: true });
assert.equal(e.recommendation, "long");
assert.ok(e.estLiquidation.long["3x"] > 0);

// enrichOracle 也必須把 tradableNow 傳進 computeEdge（A-6 的實際修法）。
const eStale = enrichOracle({ price: 50000, fundingRateBps: -50, longOpenInterest: 100, shortOpenInterest: 300, isStale: false, tradableNow: false });
assert.equal(eStale.recommendation, "no_trade", "enrichOracle 必須使用 tradableNow");
assert.ok(eStale.edgeScore > 0, "分數照算（透明），只是不建議進場");
console.log("enrich(sBTC-like):", JSON.stringify({ edgeScore: e.edgeScore, rec: e.recommendation, oiImbalance: e.oiImbalance, skewProxyBps: e.skewProxyBps }));

console.log("\n✅ edge-policy 純函式測試全過");
