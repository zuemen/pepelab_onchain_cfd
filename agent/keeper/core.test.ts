// 純函式測試：keeper 的資料驗證與偏離上限邏輯。
//   cd agent && npx tsx keeper/core.test.ts
import assert from "node:assert";
import {
  parseFeedValue,
  toPrice8,
  planUpdate,
  stepTowards,
  deviationAccepted,
} from "./core.ts";

// ── parseFeedValue：拒絕垃圾,不夾擠 ──────────────────────────────────────
assert.equal(parseFeedValue("64578.12").value, 64578.12);
assert.equal(parseFeedValue(" 311 ").value, 311);
assert.equal(parseFeedValue(311).value, 311);

// 這是 2026-07-27 真實把股價寫壞的那個回應：stooq 的 HTML 404。
const STOOQ_404 =
  '<meta charset=utf-8><title>Stooq</title><center style=font-family:arial>' +
  "<p style=font-size:x-large>The page you requested does not exist";
assert.equal(parseFeedValue(STOOQ_404).value, null);
assert.ok(parseFeedValue(STOOQ_404).reason.startsWith("non-numeric"));

assert.equal(parseFeedValue("").value, null);
assert.equal(parseFeedValue("N/D").value, null);
assert.equal(parseFeedValue("0").value, null);
assert.equal(parseFeedValue("-5").value, null);
assert.equal(parseFeedValue("NaN").value, null);
assert.equal(parseFeedValue(null).value, null);
assert.equal(parseFeedValue(undefined).value, null);

// ── toPrice8 ────────────────────────────────────────────────────────────
assert.equal(toPrice8(1), 100000000n);
assert.equal(toPrice8(64578.12), 6457812000000n);

// ── planUpdate ──────────────────────────────────────────────────────────
// 鏈上還沒有價格 → 一定要寫
assert.equal(
  planUpdate({ target: 100, current: 0, lastUpdatedSec: 0, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離超過門檻 → 寫
assert.equal(
  planUpdate({ target: 101, current: 100, lastUpdatedSec: 990, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離不足但超過 heartbeat → 寫
assert.equal(
  planUpdate({ target: 100, current: 100, lastUpdatedSec: 0, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離不足且在 heartbeat 內 → 不寫
assert.equal(
  planUpdate({ target: 100, current: 100, lastUpdatedSec: 990, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  false,
);

// ── deviationAccepted：必須與 GuardedOracle._deviationExceeded 同義 ──────
// 合約條件:(hi-lo)*10000 > bps*lo 即拒絕。
assert.equal(deviationAccepted(100n, 110n, 1000n), true);   // 上漲剛好 10%,可過
assert.equal(deviationAccepted(100n, 111n, 1000n), false);
assert.equal(deviationAccepted(100n, 90n, 1000n), false);   // 下跌 10% 反而被拒(合約現況)
assert.equal(deviationAccepted(100n, 91n, 1000n), true);
assert.equal(deviationAccepted(0n, 500n, 1000n), true);     // 無前價 → 不限制
assert.equal(deviationAccepted(100n, 999n, 0n), true);      // cap 0 → 不限制

// ── stepTowards：目標在上限內就直接寫目標 ────────────────────────────────
assert.equal(stepTowards(100_00000000n, 101_00000000n, 1000n), 101_00000000n);

// ── stepTowards：解掉線上真實的死鎖(sBTC 向下、sMSFT 向上) ─────────────
// sBTC：GuardedOracle 卡在 $73,468,MockOracle 為 $64,578(−12.1%,超過 10% cap)。
const sbtcCurrent = 7346800000000n; // $73,468
const sbtcTarget = 6457800000000n;  // $64,578
const sbtcStep = stepTowards(sbtcCurrent, sbtcTarget, 1000n);
assert.ok(sbtcStep < sbtcCurrent, "應該往目標方向走");
assert.ok(sbtcStep > sbtcTarget, "一步走不到,應停在上限內");
assert.equal(deviationAccepted(sbtcCurrent, sbtcStep, 1000n), true, "這一步必須能被合約接受");

// sMSFT：卡在 $389.10,MockOracle 為 $487.46(+25.3%)。
const msftCurrent = 38910000000n;
const msftTarget = 48746000000n;
const msftStep = stepTowards(msftCurrent, msftTarget, 1000n);
assert.ok(msftStep > msftCurrent && msftStep < msftTarget);
assert.equal(deviationAccepted(msftCurrent, msftStep, 1000n), true);

// ── stepTowards：連續走幾輪必須收斂,而不是永遠卡住 ──────────────────────
let p = sbtcCurrent;
let rounds = 0;
while (p !== sbtcTarget && rounds < 20) {
  const next = stepTowards(p, sbtcTarget, 1000n);
  assert.equal(deviationAccepted(p, next, 1000n), true, `第 ${rounds} 輪被合約拒絕`);
  assert.notEqual(next, p, "不得原地踏步");
  p = next;
  rounds += 1;
}
assert.equal(p, sbtcTarget, "應在有限輪數內追上目標");
assert.ok(rounds <= 5, `收斂太慢:${rounds} 輪`);

console.log("core.test.ts ✓ all assertions passed");
