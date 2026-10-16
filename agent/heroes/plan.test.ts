// 純函式測試：回放怎麼把可用保證金拆給每一檔、什麼時候該清算。
//   cd agent && npx tsx heroes/plan.test.ts
import assert from "node:assert";
import { isLastDayOfMonth, planHedge, planOpens, shouldLiquidate, MIN_MARGIN, type LegPlan } from "./plan.ts";

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

// ── planHedge：造市帳號把某個資產的多空名目拉平 ──────────────────────────────
// 交易者淨多 10000、造市帳號還沒有部位：開 10000 的空單
assert.deepEqual(planHedge({ long: 10_000n * E18, short: 0n }, { long: 0n, short: 0n }), {
  closeExisting: true, open: { isLong: false, margin: 10_000n * E18 },
});
// 已經平衡（失衡 ≤ 1%）就不動，免得每天白付手續費
assert.equal(planHedge({ long: 10_000n * E18, short: 9_950n * E18 }, { long: 0n, short: 9_950n * E18 }), null);
// 交易者變成淨空 3000（總多 2000、總空 5000，其中造市帳號的空單 0）：平掉舊的、改開 3000 多單
assert.deepEqual(planHedge({ long: 2_000n * E18, short: 5_000n * E18 }, { long: 0n, short: 0n }), {
  closeExisting: true, open: { isLong: true, margin: 3_000n * E18 },
});
// 造市帳號的舊空單 8000 已經太多（交易者只剩淨多 5000）：平掉、重開 5000 空單
assert.deepEqual(planHedge({ long: 5_000n * E18, short: 8_000n * E18 }, { long: 0n, short: 8_000n * E18 }), {
  closeExisting: true, open: { isLong: false, margin: 5_000n * E18 },
});
// 交易者全部平倉、只剩造市帳號自己的部位：平掉，不再開
assert.deepEqual(planHedge({ long: 0n, short: 4_000n * E18 }, { long: 0n, short: 4_000n * E18 }), {
  closeExisting: true, open: null,
});
// 交易者的淨額低於交易所最低保證金：只平不開
assert.deepEqual(planHedge({ long: 5n * E18, short: 100n * E18 }, { long: 0n, short: 100n * E18 }), {
  closeExisting: true, open: null,
});
// 完全沒有部位：不動
assert.equal(planHedge({ long: 0n, short: 0n }, { long: 0n, short: 0n }), null);

// ── isLastDayOfMonth：碳權退役每個模擬月份觸發一次，在該月排程的最後一天（#333） ──
const dates = ["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01", "2024-03-04"];
assert.deepEqual(
  dates.map((_, i) => isLastDayOfMonth(dates, i)),
  [false, true, false, true, false, true],
);
assert.equal(isLastDayOfMonth(["2024-01-05"], 0), true, "單日排程：最後一天也算");

console.log("plan.test.ts ✓");
