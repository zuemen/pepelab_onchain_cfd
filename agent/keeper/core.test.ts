// 純函式測試：keeper 的資料驗證與偏離上限邏輯。
//   cd agent && npx tsx keeper/core.test.ts
import assert from "node:assert";
import {
  parseFeedValue,
  toPrice8,
  planUpdate,
  stepTowards,
  deviationAccepted,
  guardDeviation,
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

// ── guardDeviation：MockOracle 的偏離上限（稽核 A-5）─────────────────────
// 交易所讀的是沒有任何鏈上保護的 MockOracle，所以「數值合法但離譜」必須在這裡擋。

// 鏈上還沒有價格 → seed，沒有可比基準，原樣寫入。
{
  const g = guardDeviation({ target: 311, current: 0 });
  assert.equal(g.write, true);
  assert.equal(g.value, 311);
  assert.equal(g.clamped, false);
}

// 正常波動（< 10%）→ 原樣寫入。
{
  const g = guardDeviation({ target: 105, current: 100 });
  assert.equal(g.write, true);
  assert.equal(g.value, 105);
  assert.equal(g.clamped, false);
}

// 超過上限但未達拒寫門檻 → 夾到邊緣，分段逼近（不是放棄、也不是照寫）。
{
  const up = guardDeviation({ target: 130, current: 100 });
  assert.equal(up.write, true);
  assert.equal(up.clamped, true);
  assert.ok(Math.abs(up.value - 110) < 1e-9, `向上應夾到 110，得到 ${up.value}`);

  const down = guardDeviation({ target: 70, current: 100 });
  assert.equal(down.write, true);
  assert.equal(down.clamped, true);
  assert.ok(Math.abs(down.value - 90) < 1e-9, `向下應夾到 90，得到 ${down.value}`);
}

// 這就是 A-5 描述的事故形狀：拆股日 Yahoo 回 1/4 的價格（−75%），
// 數值完全合法、parseFeedValue 擋不住，舊 keeper 會照寫並在下一輪清算所有部位。
{
  const split = guardDeviation({ target: 77.75, current: 311 });
  assert.equal(split.write, false, "拆股價必須被拒寫，而不是照寫");
  assert.ok(split.reason.includes("拒寫"), split.reason);
}
// 反向的離譜（來源換成別的標的 → 價格翻 3 倍）同樣拒寫。
assert.equal(guardDeviation({ target: 933, current: 311 }).write, false);

// 分段逼近必須在有限輪數內收斂（不能像舊 GuardedOracle 那樣永遠追不上）。
{
  let p = 100;
  const target = 130;
  let rounds = 0;
  while (Math.abs(p - target) / p > 1e-9 && rounds < 20) {
    const g = guardDeviation({ target, current: p });
    assert.equal(g.write, true, `第 ${rounds} 輪不該被拒寫`);
    assert.notEqual(g.value, p, "不得原地踏步");
    p = g.value;
    rounds += 1;
  }
  assert.ok(Math.abs(p - target) < 1e-6, `應收斂到目標，停在 ${p}`);
  assert.ok(rounds <= 4, `收斂太慢：${rounds} 輪`);
}

// 非法 target 一律不寫。
assert.equal(guardDeviation({ target: 0, current: 100 }).write, false);
assert.equal(guardDeviation({ target: Number.NaN, current: 100 }).write, false);

console.log("core.test.ts ✓ all assertions passed");
