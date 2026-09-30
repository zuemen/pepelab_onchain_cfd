// 純函式測試：keeper 的資料驗證與偏離上限邏輯。
//   cd agent && npx tsx keeper/core.test.ts
import assert from "node:assert";
import {
  parseFeedValue,
  toPrice8,
  planUpdate,
  deviationAccepted,
  guardDeviation,
  confirmLargeMove,
  planMirror,
  runVerdict,
  summaryLine,
  parseRatioEnv,
  BREAKER_RANGE,
  CONFIRM_TOLERANCE_RANGE,
  DEVIATION_THRESHOLD_RANGE,
  HEARTBEAT_RANGE,
  DEGRADED_RATIO_RANGE,
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

// ── guardDeviation：價格熔斷（稽核 A-5；2026-09-29 審查改為熔斷語意）──────────
// 原則：絕不寫入明知不是最佳估計的價格 —— 只有「寫完整價格」或「不寫」。

// 鏈上還沒有價格 → seed，原樣寫入。
{
  const g = guardDeviation({ target: 311, current: 0 });
  assert.equal(g.write, true);
  assert.equal(g.value, 311);
}

// 必要案例：+15%（單一來源、門檻 20% 內）→ 直接寫入完整價格，不夾限。
{
  const g = guardDeviation({ target: 115, current: 100, quotes: [{ source: "yahoo", value: 115, ageSec: 60 }] });
  assert.equal(g.write, true, g.reason);
  assert.equal(g.value, 115, "必須是完整價格，不是夾到某個邊緣");
  assert.equal(g.confirmed, false);
}
// 舊版 10–50% 區間的夾限路徑已移除：−18% 也是完整寫入。
assert.equal(guardDeviation({ target: 82, current: 100 }).value, 82);

// 必要案例：單源 +30% → 拒寫（熔斷），reason 指向 runbook。
{
  const g = guardDeviation({ target: 130, current: 100, quotes: [{ source: "yahoo", value: 130, ageSec: 60 }] });
  assert.equal(g.write, false, g.reason);
  assert.ok(g.reason.includes("熔斷") && g.reason.includes("RUNBOOK_KEEPER"), g.reason);
}
// 拆股日 Yahoo 回 1/4 的價格（−75%），單一來源 → 拒寫。
{
  const split = guardDeviation({ target: 77.75, current: 311, quotes: [{ source: "yahoo", value: 77.75, ageSec: 60 }] });
  assert.equal(split.write, false);
  assert.ok(split.reason.includes("至少需要 2 個"), split.reason);
}
assert.equal(guardDeviation({ target: 933, current: 311 }).write, false);

// 必要案例：40k→83k，多源確認通過 → 一次寫到共識價（中位數），不分段。
{
  const g = guardDeviation({
    target: 83_100,
    current: 40_000,
    quotes: [{ source: "chainlink/pyth relay", value: 83_100, ageSec: 60 }, { source: "coingecko", value: 83_000, ageSec: 60 }],
  });
  assert.equal(g.write, true, g.reason);
  assert.equal(g.confirmed, true);
  assert.equal(g.value, 83_050, "兩個來源的中位數");
}
// 三個來源 → 取中位數。
assert.equal(
  guardDeviation({
    target: 83_100, current: 40_000,
    quotes: [{ source: "a", value: 83_100, ageSec: 60 }, { source: "b", value: 83_000, ageSec: 60 }, { source: "c", value: 83_900, ageSec: 60 }],
  }).value,
  83_100,
);
// 向下同理。
assert.equal(
  guardDeviation({ target: 100, current: 311, quotes: [{ source: "yahoo", value: 100, ageSec: 60 }, { source: "relay", value: 101, ageSec: 60 }] }).value,
  100.5,
);
// 兩來源差距 > 2% → 拒寫。
assert.equal(
  guardDeviation({ target: 300, current: 100, quotes: [{ source: "a", value: 300, ageSec: 60 }, { source: "b", value: 320, ageSec: 60 }] }).write,
  false,
);
// 共識方向與 target 相反 → 拒寫。
assert.equal(
  guardDeviation({ target: 300, current: 100, quotes: [{ source: "b", value: 40, ageSec: 60 }, { source: "c", value: 40.2, ageSec: 60 }] }).write,
  false,
);
// 門檻與容許度可調。
assert.equal(guardDeviation({ target: 130, current: 100, breakerDeviation: 0.35 }).write, true);
assert.equal(
  guardDeviation({
    target: 300, current: 100, confirmTolerance: 0.1,
    quotes: [{ source: "a", value: 300, ageSec: 60 }, { source: "b", value: 320, ageSec: 60 }],
  }).value,
  310,
);
// 非法 target 一律不寫。
assert.equal(guardDeviation({ target: 0, current: 100 }).write, false);
assert.equal(guardDeviation({ target: Number.NaN, current: 100 }).write, false);


// confirmLargeMove：兩個獨立來源、差距 ≤ 2%、方向一致 → 確認，共識取平均。
{
  const c = confirmLargeMove({
    current: 40_000,
    quotes: [{ source: "chainlink/pyth relay", value: 83_100, ageSec: 60 }, { source: "coingecko", value: 83_000, ageSec: 60 }],
  });
  assert.equal(c.confirmed, true, c.reason);
  assert.ok(Math.abs(c.consensus - 83_050) < 1e-9);
}
// 只有一個來源（或同名來源重複）→ 不確認。
assert.equal(confirmLargeMove({ current: 100, quotes: [{ source: "yahoo", value: 300, ageSec: 60 }] }).confirmed, false);
assert.equal(
  confirmLargeMove({ current: 100, quotes: [{ source: "yahoo", value: 300, ageSec: 60 }, { source: "yahoo", value: 300, ageSec: 60 }] }).confirmed,
  false,
  "同一個來源抓兩次不算獨立",
);
// 差距 > 2% → 不確認。
{
  const c = confirmLargeMove({ current: 100, quotes: [{ source: "a", value: 300, ageSec: 60 }, { source: "b", value: 310, ageSec: 60 }] });
  assert.equal(c.confirmed, false);
  assert.ok(c.reason.includes("差距"), c.reason);
}
// 方向不一致（一個說漲一個說跌；差距檢查前就會被擋，這裡用差距內的構造）。
{
  const c = confirmLargeMove({ current: 100, quotes: [{ source: "a", value: 99.5, ageSec: 60 }, { source: "b", value: 100.5, ageSec: 60 }] });
  assert.equal(c.confirmed, false);
  assert.ok(c.reason.includes("方向"), c.reason);
}
// 非法報價不算數。
assert.equal(
  confirmLargeMove({ current: 100, quotes: [{ source: "a", value: 300, ageSec: 60 }, { source: "b", value: Number.NaN, ageSec: 60 }] }).confirmed,
  false,
);


// ── 多源確認的每一票必須新鮮（審查 Medium 1） ─────────────────────────────
{
  const fresh = { source: "chainlink/pyth relay", value: 83_100, ageSec: 120 };
  // 第二票 2 小時前（> 1h）→ 不算，確認失敗 → 熔斷拒寫。
  const old = confirmLargeMove({ current: 40_000, quotes: [fresh, { source: "coingecko", value: 83_000, ageSec: 7200 }] });
  assert.equal(old.confirmed, false);
  assert.ok(old.reason.includes("不新鮮") && old.reason.includes("7200s"), old.reason);
  // Yahoo 標記 quoteStale（休市收盤價）→ 不算。
  assert.equal(
    confirmLargeMove({ current: 40_000, quotes: [fresh, { source: "yahoo", value: 83_000, ageSec: 60, stale: true }] }).confirmed,
    false,
  );
  // 沒有時間戳 → 新鮮度不明，不算。
  {
    const c = confirmLargeMove({ current: 40_000, quotes: [fresh, { source: "coingecko", value: 83_000 }] });
    assert.equal(c.confirmed, false);
    assert.ok(c.reason.includes("無時間戳"), c.reason);
  }
  // 剛好 3600s 仍算；上限可調。
  assert.equal(
    confirmLargeMove({ current: 40_000, quotes: [fresh, { source: "coingecko", value: 83_000, ageSec: 3600 }] }).confirmed,
    true,
  );
  assert.equal(
    confirmLargeMove({
      current: 40_000, maxQuoteAgeSec: 60,
      quotes: [fresh, { source: "coingecko", value: 83_000, ageSec: 61 }],
    }).confirmed,
    false,
  );
  // guardDeviation 走同一條：不新鮮的第二票 → 拒寫。
  assert.equal(
    guardDeviation({ target: 83_100, current: 40_000, quotes: [fresh, { source: "coingecko", value: 83_000, ageSec: 7200 }] }).write,
    false,
  );
}

// ── planMirror：GuardedOracle 只寫完整價格 ─────────────────────────────────
// 必要案例：鏈上步進上限拒絕完整價格 → reject，不寫部分價格。
{
  const p = planMirror(7346800000000n, 6457800000000n, 1000n); // sBTC −12.1%，cap 10%
  assert.equal(p.action, "reject");
  assert.ok(p.action === "reject" && p.reason.includes("不寫部分步進"), JSON.stringify(p));
}
{
  const p = planMirror(100_00000000n, 105_00000000n, 1000n);
  assert.deepEqual(p, { action: "write", value: 105_00000000n });
}
assert.equal(planMirror(100n, 100n, 1000n).action, "skip");
assert.deepEqual(planMirror(100n, 999n, 0n), { action: "write", value: 999n }, "cap 0 → 不限制");

// ── runVerdict：熔斷拒寫一定讓 job 失敗 ────────────────────────────────────
{
  const v = runVerdict({ total: 11, available: 11, skipped: 0, rejected: 1, wrote: 10, failed: 0 }, 0.3);
  assert.equal(v.exitCode, 1, "單源 +30% 被拒寫 → job 失敗");
  assert.ok(v.errors.some((e) => e.includes("熔斷")));
}
assert.equal(runVerdict({ total: 11, available: 11, skipped: 0, rejected: 0, wrote: 11, failed: 0 }, 0.3).exitCode, 0);
assert.equal(runVerdict({ total: 11, available: 11, skipped: 0, rejected: 0, wrote: 10, failed: 1 }, 0.3).exitCode, 1);
assert.equal(runVerdict({ total: 11, available: 7, skipped: 4, rejected: 0, wrote: 7, failed: 0 }, 0.3).exitCode, 1);
assert.equal(runVerdict({ total: 11, available: 0, skipped: 11, rejected: 0, wrote: 0, failed: 0 }, 0.3).exitCode, 1);

// ── summaryLine：跳過也算失敗，格式與 workflow 的 grep 相容（2026-09-30 事故） ────
{
  const WORKFLOW_RE = /^available=[0-9]+ .*failed=[0-9]+$/;
  const pct = (line: string) => {
    const a = Number(line.match(/available=(\d+)/)![1]);
    const f = Number(line.match(/failed=(\d+)/)![1]);
    return Math.floor((f * 100) / a); // 與 workflow 的 $(( FAILED * 100 / AVAILABLE )) 相同
  };
  // 事故當時：10 個有價、sBTC 跳過 → 以前 failed=0（全綠），現在 failed=1、9%。
  const incident = summaryLine({ available: 10, skipped: 1, rejected: 0, confirmed: 0, wrote: 10, failed: 0 });
  assert.match(incident, WORKFLOW_RE);
  assert.equal(incident, "available=11 skipped=1 rejected=0 confirmed=0 wrote=10 failed=1");
  assert.equal(pct(incident), 9);
  // 4/11 跳過 → 36% > MAX_FAIL_PCT 30 → workflow 讓 job 失敗。
  assert.ok(pct(summaryLine({ available: 7, skipped: 4, rejected: 0, confirmed: 0, wrote: 7, failed: 0 })) > 30);
  // 寫入失敗與跳過一起計。
  assert.match(summaryLine({ available: 9, skipped: 2, rejected: 0, confirmed: 0, wrote: 8, failed: 1 }), /failed=3$/);
}

// ── 比例型環境變數驗證（審查 Low） ───────────────────────────────────────
assert.deepEqual(parseRatioEnv("X", undefined, 0.2, 0, 1), { value: 0.2 });
assert.deepEqual(parseRatioEnv("X", "", 0.2, 0, 1), { value: 0.2 });
assert.deepEqual(parseRatioEnv("X", "0.3", 0.2, 0, 1), { value: 0.3 });
assert.deepEqual(parseRatioEnv("X", "1", 0.2, 0, 1), { value: 1 });
for (const bad of ["abc", "NaN", "Infinity", "0", "-0.1", "1.5", "0x10", "0.25"]) {
  const r = parseRatioEnv("KEEPER_BREAKER_DEVIATION", bad, 0.2, ...BREAKER_RANGE);
  assert.ok(r.error?.includes("KEEPER_BREAKER_DEVIATION"), `${bad} 應被拒：${JSON.stringify(r)}`);
}
assert.deepEqual(parseRatioEnv("KEEPER_BREAKER_DEVIATION", "0.2", 0.2, ...BREAKER_RANGE), { value: 0.2 });
// KEEPER_DEVIATION / KEEPER_HEARTBEAT / KEEPER_MAX_DEGRADED_RATIO（複審 Low）
assert.ok(parseRatioEnv("KEEPER_DEVIATION", "abc", 0.001, ...DEVIATION_THRESHOLD_RANGE).error);
assert.ok(parseRatioEnv("KEEPER_DEVIATION", "0.5", 0.001, ...DEVIATION_THRESHOLD_RANGE).error);
assert.deepEqual(parseRatioEnv("KEEPER_DEVIATION", "0.002", 0.001, ...DEVIATION_THRESHOLD_RANGE), { value: 0.002 });
assert.ok(parseRatioEnv("KEEPER_HEARTBEAT", "NaN", 900, ...HEARTBEAT_RANGE).error);
assert.ok(parseRatioEnv("KEEPER_HEARTBEAT", "0", 900, ...HEARTBEAT_RANGE).error);
assert.ok(parseRatioEnv("KEEPER_HEARTBEAT", "86400", 900, ...HEARTBEAT_RANGE).error, "超過交易所 maxPriceAge");
assert.deepEqual(parseRatioEnv("KEEPER_HEARTBEAT", "1800", 900, ...HEARTBEAT_RANGE), { value: 1800 });
assert.deepEqual(
  parseRatioEnv("KEEPER_MAX_DEGRADED_RATIO", "0", 0.3, ...DEGRADED_RATIO_RANGE, { minInclusive: true }),
  { value: 0 },
  "0 = 任一資產無法更新就失敗，合法",
);
assert.ok(parseRatioEnv("KEEPER_MAX_DEGRADED_RATIO", "-0.1", 0.3, ...DEGRADED_RATIO_RANGE, { minInclusive: true }).error);
assert.ok(parseRatioEnv("KEEPER_MAX_DEGRADED_RATIO", "x", 0.3, ...DEGRADED_RATIO_RANGE, { minInclusive: true }).error);
assert.ok(parseRatioEnv("KEEPER_CONFIRM_TOLERANCE", "0.5", 0.02, ...CONFIRM_TOLERANCE_RANGE).error);
assert.deepEqual(parseRatioEnv("KEEPER_CONFIRM_TOLERANCE", "0.05", 0.02, ...CONFIRM_TOLERANCE_RANGE), { value: 0.05 });

console.log("core.test.ts ✓ all assertions passed");
