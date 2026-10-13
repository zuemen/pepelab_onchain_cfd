// 純函式測試：回放怎麼把可用保證金拆給每一檔、什麼時候該清算。
//   cd agent && npx tsx heroes/plan.test.ts
import assert from "node:assert";
import { planOpens, shouldLiquidate, MIN_MARGIN, type LegPlan } from "./plan.ts";

const E18 = 10n ** 18n;
const FEES = { sBTC: 100n, sETH: 10n, sESGU: 40n };

// ── planOpens：保證金加開倉手續費不能超過可用保證金 ───────────────────────
const legs: LegPlan[] = [
  { asset: "sBTC", weightBps: 5000, isLong: true, leverage: 1 },
  { asset: "sETH", weightBps: 3000, isLong: true, leverage: 5 },
  { asset: "sESGU", weightBps: 2000, isLong: false, leverage: 2 },
];
const free = 10_000n * E18;
const orders = planOpens(free, legs, FEES);
assert.equal(orders.length, 3);

const cost = orders.reduce(
  (sum, o) => sum + o.margin + (o.margin * BigInt(o.leverage) * FEES[o.asset as keyof typeof FEES]) / 10_000n,
  0n,
);
assert.ok(cost <= free, "保證金 + 手續費超過可用保證金");
assert.ok(cost >= (free * 995n) / 1000n, "留下的閒置保證金超過 0.5%");

// 各檔的比例就是權重（逐檔整數除法各自捨去，容許幾 wei 的差）
const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) < 10n;
assert.ok(near(orders[0].margin * 3n, orders[1].margin * 5n));
assert.ok(near(orders[0].margin * 2n, orders[2].margin * 5n));

// 方向與槓桿原樣帶過去
assert.deepEqual(
  orders.map((o) => [o.asset, o.isLong, o.leverage]),
  [["sBTC", true, 1], ["sETH", true, 5], ["sESGU", false, 2]],
);

// 分到的保證金低於交易所下限的那一檔不開（開了會 revert MarginTooLow）
const tiny = planOpens(60n * E18, legs, FEES);
assert.ok(tiny.every((o) => o.margin >= MIN_MARGIN));
assert.deepEqual(tiny.map((o) => o.asset), ["sBTC", "sETH", "sESGU"]);
assert.deepEqual(planOpens(30n * E18, legs, FEES).map((o) => o.asset), ["sBTC"]);
assert.deepEqual(planOpens(0n, legs, FEES), []);

// ── shouldLiquidate：部位價值 <= 維持保證金（名目 × bps）才清算 ──────────────
const margin = 1_000n * E18;
// 5 倍、維持保證金 5%：名目 5000，門檻 250
assert.equal(shouldLiquidate(250n * E18, margin, 5n, 500n), true);
assert.equal(shouldLiquidate(250n * E18 + 1n, margin, 5n, 500n), false);
assert.equal(shouldLiquidate(0n, margin, 1n, 500n), true);
assert.equal(shouldLiquidate(900n * E18, margin, 1n, 500n), false);

console.log("plan.test.ts ✓");
