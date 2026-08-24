// 純函式測試：date 參數驗證 + 收盤點選取。不打網路。
//   cd agent && npx tsx signal-api/src/benchmarks.test.ts
import assert from "node:assert";
import {
  parseDateParam,
  dateToUnixSec,
  pickCloseAtOrBefore,
  BadDateError,
} from "./benchmarks.ts";

// ── parseDateParam ───────────────────────────────────────────────────────────

// 沒給 → undefined，不是「今天」的隱性預設。
assert.equal(parseDateParam(undefined), undefined);
assert.equal(parseDateParam(""), undefined);

// 合法日期原樣通過。
assert.equal(parseDateParam("2026-07-12"), "2026-07-12");

// 格式錯誤一律丟 BadDateError，不靜默吃掉。
for (const bad of ["2026/07/12", "07-12-2026", "2026-7-12", "not-a-date", "2026-07-12T00:00:00Z"]) {
  assert.throws(() => parseDateParam(bad), BadDateError, `expected BadDateError for "${bad}"`);
}

// 月份溢位：Date.parse 對這個會直接回 NaN，是最容易寫對的一種。
assert.throws(() => parseDateParam("2026-13-01"), BadDateError);
assert.throws(() => parseDateParam("2026-00-01"), BadDateError);

// 日期溢位是真正會咬人的那種：實測過 Date.parse("2026-02-30T00:00:00Z") 不是
// NaN，而是被靜默捲進 3 月 2 日。純用 Date.parse 的 NaN 檢查會讓這個測試失敗
// （呼叫端會拿到「3/2 的收盤價」卻以為自己要的是 2/30，一個不存在的日子）。
assert.throws(() => parseDateParam("2026-02-30"), BadDateError, "2026-02-30 不存在，必須被拒絕");
assert.throws(() => parseDateParam("2026-04-31"), BadDateError, "4 月沒有 31 日");
assert.throws(() => parseDateParam("2026-02-29"), BadDateError, "2026 不是閏年");

// 閏年 2/29 合法。
assert.equal(parseDateParam("2024-02-29"), "2024-02-29");

// 未來日期丟錯——「你 vs 大盤」的錨定日不可能晚於現在。
const farFuture = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
assert.throws(() => parseDateParam(farFuture), BadDateError);

console.log("parseDateParam ✓");

// ── dateToUnixSec ─────────────────────────────────────────────────────────────

assert.equal(dateToUnixSec("2026-07-12"), Date.UTC(2026, 6, 12) / 1000);

console.log("dateToUnixSec ✓");

// ── pickCloseAtOrBefore ───────────────────────────────────────────────────────

const DAY = 86400;
const points = [
  { t: 10 * DAY + 3600, c: 100 }, // day 10
  { t: 12 * DAY + 3600, c: 102 }, // day 12
  { t: 15 * DAY + 3600, c: 105 }, // day 15
];

// target 剛好等於某一根所在的日子（但秒數不同）→ 命中那一天，不會被誤判成晚一天。
assert.deepEqual(pickCloseAtOrBefore(points, 12 * DAY), { t: 12 * DAY + 3600, c: 102 });

// target 落在兩根之間的空檔（例如週末）→ 取之前最近一根。
assert.deepEqual(pickCloseAtOrBefore(points, 14 * DAY), { t: 12 * DAY + 3600, c: 102 });

// target 早於所有資料 → 沒有「之前」可取，undefined。
assert.equal(pickCloseAtOrBefore(points, 5 * DAY), undefined);

// target 晚於所有資料 → 取最新一根。
assert.deepEqual(pickCloseAtOrBefore(points, 100 * DAY), { t: 15 * DAY + 3600, c: 105 });

// 空陣列 → undefined，不丟例外。
assert.equal(pickCloseAtOrBefore([], 12 * DAY), undefined);

// 輸入順序不影響結果（getBenchmarks 呼叫前已排序，但這個函式本身不該預設順序）。
const shuffled = [points[2], points[0], points[1]];
assert.deepEqual(pickCloseAtOrBefore(shuffled, 14 * DAY), { t: 12 * DAY + 3600, c: 102 });

console.log("pickCloseAtOrBefore ✓");

console.log("benchmarks.test.ts ✓ all assertions passed");
