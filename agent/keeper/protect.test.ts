// 熔斷停單說明的純函式測試（複審 H2）。
//   cd agent && npx tsx keeper/protect.test.ts
import assert from "node:assert";
import { describeProtection, formatAge } from "./protect.ts";
import { renderBody, renderCloseComment, decideAlert, type HealthReport } from "./alert.ts";

// 線上現況：keeper 沒有 GUARDIAN_ROLE、exchange 是舊合約 → 兩者都做不到，必須明寫。
{
  const d = describeProtection({ symbol: "sAAPL", freeze: "no-role", mode: "unsupported" }, 21_600);
  assert.equal(d.exchangeStillTrading, true);
  assert.ok(d.notes.some((n) => n.includes("交易所將以舊價繼續成交，直到 maxPriceAge（6h）；需人工處置")), d.notes.join("\n"));
  assert.ok(d.notes[0].includes("GUARDIAN_ROLE") && d.notes[0].includes("setAssetMode"), d.notes[0]);
}
// 凍結成功但交易所仍可交易 → 仍要寫「需人工處置」。
assert.equal(describeProtection({ symbol: "sBTC", freeze: "done", mode: "not-operator" }, 21_600).exchangeStillTrading, true);
// 切到 ReduceOnly → 不再新開倉，但仍提醒平倉與清算用舊價。
{
  const d = describeProtection({ symbol: "sAAPL", freeze: "no-role", mode: "done" }, 21_600);
  assert.equal(d.exchangeStillTrading, false);
  assert.ok(d.notes.some((n) => n.includes("平倉與清算仍以舊價執行")));
}
assert.equal(describeProtection({ symbol: "x", freeze: "already", mode: "already" }, null).exchangeStillTrading, false);
// maxPriceAge 讀不到時不編造數字。
assert.ok(describeProtection({ symbol: "x", freeze: "no-role", mode: "unsupported" }, null).notes[1].includes("maxPriceAge（maxPriceAge）"));
assert.equal(formatAge(21_600), "6h");
assert.equal(formatAge(5_400), "1.5h");

// ── 熔斷 issue 內文（alert.ts kind=breaker） ────────────────────────────────
const report: HealthReport = {
  kind: "breaker",
  chain: "base-sepolia",
  status: "stale",
  checkedAtSec: 1_790_000_000,
  maxAgeSec: 21_600,
  stale: ["sAAPL"],
  unreadable: [],
  notes: describeProtection({ symbol: "sAAPL", freeze: "no-role", mode: "unsupported" }, 21_600).notes,
  lines: ["sAAPL: 偏離 30% 超過熔斷門檻"],
};
{
  const body = renderBody(report);
  assert.ok(body.includes("熔斷拒寫資產（1）"));
  assert.ok(body.includes("交易所將以舊價繼續成交，直到 maxPriceAge（6h）；需人工處置"));
  assert.ok(body.includes("<!-- oracle-health:stale=sAAPL -->"));
  assert.ok(!body.includes("過期資產"), "不能套用 oracle-health 的過期文案");
  assert.ok(renderCloseComment({ ...report, status: "ok", stale: [] }).includes("keeper 不會自動解除"));
}
// 本輪有資產來源無效 → 不自動關閉熔斷 issue。
assert.equal(
  decideAlert({
    report: { ...report, status: "ok", stale: [], unreadable: ["sAAPL"] },
    open: { number: 4, lastSignature: "sAAPL", lastUpdatedSec: 0 },
    nowSec: 1_790_000_000,
  }).action,
  "none",
);

console.log("protect.test.ts ✓ all assertions passed");
