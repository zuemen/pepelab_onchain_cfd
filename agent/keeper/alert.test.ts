// oracle-health 告警決策的純函式測試（不碰 gh、不碰網路）。
//   cd agent && npx tsx keeper/alert.test.ts
import assert from "node:assert";
import {
  decideAlert,
  signatureOf,
  parseSignature,
  renderBody,
  renderCloseComment,
  type HealthReport,
} from "./alert.ts";

const NOW = 1_790_899_200;
const base: HealthReport = {
  chain: "base-sepolia",
  status: "stale",
  checkedAtSec: NOW,
  maxAgeSec: 18_000,
  stale: ["sETH(6.2h)", "sBTC(6.1h)"],
  lines: ["STALE sBTC ...", "STALE sETH ..."],
};

// ── 簽章：只看資產名、排序，年齡變化不算「集合改變」 ────────────────────────
assert.equal(signatureOf(["sETH(6.2h)", "sBTC(unreadable)"]), "sBTC,sETH");
assert.equal(signatureOf(["sBTC(6.1h)", "sETH(6.2h)"]), signatureOf(["sETH(9.0h)", "sBTC(9.1h)"]));
assert.equal(signatureOf([]), "");

// ── 內文帶簽章，可被找回 ──────────────────────────────────────────────────
{
  const body = renderBody(base, "https://github.com/o/r/actions/runs/1");
  assert.equal(parseSignature(body), "sBTC,sETH");
  assert.ok(body.includes("StalePrice"));
  assert.ok(body.includes("https://github.com/o/r/actions/runs/1"));
  assert.equal(parseSignature(renderCloseComment({ ...base, status: "ok", stale: [] })), "");
  assert.equal(parseSignature("沒有簽章的人工留言"), null);
}

// ── STALE、沒有開著的 issue → 開新 issue ─────────────────────────────────
assert.equal(decideAlert({ report: base, open: null, nowSec: NOW }).action, "create");

// ── STALE、同標題 issue 已開著、集合改變 → 留言更新（不另開） ───────────────
assert.equal(
  decideAlert({
    report: base,
    open: { number: 7, lastSignature: "sBTC", lastUpdatedSec: NOW - 3 * 3600 },
    nowSec: NOW,
  }).action,
  "comment",
);

// ── STALE、同一組、3 小時前才更新過 → 不重複留言 ──────────────────────────
assert.equal(
  decideAlert({
    report: base,
    open: { number: 7, lastSignature: "sBTC,sETH", lastUpdatedSec: NOW - 3 * 3600 },
    nowSec: NOW,
  }).action,
  "none",
);

// ── STALE、同一組、超過 24 小時沒更新 → 留言（仍在壞，要讓人知道） ─────────
assert.equal(
  decideAlert({
    report: base,
    open: { number: 7, lastSignature: "sBTC,sETH", lastUpdatedSec: NOW - 25 * 3600 },
    nowSec: NOW,
  }).action,
  "comment",
);
// repeatSec=0 → 每輪都留言
assert.equal(
  decideAlert({
    report: base,
    open: { number: 7, lastSignature: "sBTC,sETH", lastUpdatedSec: NOW },
    nowSec: NOW,
    repeatSec: 0,
  }).action,
  "comment",
);

// ── 人工開的同標題 issue（沒有簽章）→ 視為集合改變，留言 ─────────────────
assert.equal(
  decideAlert({ report: base, open: { number: 3, lastSignature: null, lastUpdatedSec: NOW }, nowSec: NOW }).action,
  "comment",
);

// ── 恢復 → 自動關閉；沒有開著的 → 什麼都不做 ─────────────────────────────
const ok: HealthReport = { ...base, status: "ok", stale: [] };
{
  const d = decideAlert({ report: ok, open: { number: 7, lastSignature: "sBTC", lastUpdatedSec: 0 }, nowSec: NOW });
  assert.equal(d.action, "close");
  assert.ok(d.reason.includes("#7"));
}
assert.equal(decideAlert({ report: ok, open: null, nowSec: NOW }).action, "none");

// ── 健檢本身失敗（RPC／secret）→ 不開、不關，避免把兩種事故混在一起 ─────────
const err: HealthReport = { ...base, status: "error", stale: [], error: "could not detect network" };
assert.equal(decideAlert({ report: err, open: null, nowSec: NOW }).action, "none");
assert.equal(
  decideAlert({ report: err, open: { number: 7, lastSignature: "sBTC", lastUpdatedSec: 0 }, nowSec: NOW }).action,
  "none",
);

console.log("alert.test.ts ✓ all assertions passed");
