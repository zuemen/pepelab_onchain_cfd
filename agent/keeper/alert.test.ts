// oracle-health 告警決策的純函式測試（不碰 gh、不碰網路）。
//   cd agent && npx tsx keeper/alert.test.ts
import assert from "node:assert";
import {
  decideAlert,
  signatureOf,
  parseSignature,
  renderBody,
  renderCloseComment,
  pickOwnIssue,
  pickRecentlyClosed,
  toOpenIssue,
  renderRecovering,
  parseOkStreak,
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
// 只靠行事曆後備被放寬的資產 → 不自動關閉（審查 Medium 3）。
assert.equal(
  decideAlert({
    report: { ...ok, fallbackTolerated: ["sAAPL(19.0h)"] },
    open: { number: 7, lastSignature: "sAAPL", lastUpdatedSec: 0 },
    nowSec: NOW,
  }).action,
  "none",
);

// ── 健檢本身失敗（RPC／secret）→ 不開、不關，避免把兩種事故混在一起 ─────────
const err: HealthReport = { ...base, status: "error", stale: [], error: "could not detect network" };
assert.equal(decideAlert({ report: err, open: null, nowSec: NOW }).action, "none");
assert.equal(
  decideAlert({ report: err, open: { number: 7, lastSignature: "sBTC", lastUpdatedSec: 0 }, nowSec: NOW }).action,
  "none",
);

// ── 偽造防護（審查 Medium 5） ──────────────────────────────────────────────
const TITLE = "[oracle-health] Base Sepolia 價格過期";
const bot = { login: "github-actions" };
const botRest = { login: "github-actions[bot]" };
const mallory = { login: "mallory" };

// 外部使用者開的同標題 issue（號碼更小）不能被當成告警 issue。
{
  const hit = pickOwnIssue(
    [
      { number: 3, title: TITLE, author: mallory },
      { number: 12, title: TITLE, author: bot },
      { number: 15, title: TITLE, author: botRest },
      { number: 5, title: "other", author: bot },
    ],
    TITLE,
  );
  assert.equal(hit?.number, 12);
  assert.equal(pickOwnIssue([{ number: 3, title: TITLE, author: mallory }], TITLE), null);
  assert.equal(pickOwnIssue([{ number: 3, title: TITLE, author: null }], TITLE), null);
}

// 節流簽章只認 github-actions 的留言：外部留言塞相同簽章不能讓 keeper 靜默。
{
  const view = {
    number: 12,
    title: TITLE,
    author: bot,
    body: "<!-- oracle-health:stale=sBTC -->",
    createdAt: "2026-10-01T00:00:00Z",
    comments: [
      { author: bot, body: "x <!-- oracle-health:stale=sBTC,sETH -->", createdAt: "2026-10-01T03:00:00Z" },
      { author: mallory, body: "<!-- oracle-health:stale=sAAPL -->", createdAt: "2026-10-01T06:00:00Z" },
    ],
  };
  const o = toOpenIssue(view);
  assert.equal(o.lastSignature, "sBTC,sETH", "忽略外部留言的簽章");
  assert.equal(o.lastUpdatedSec, Date.parse("2026-10-01T03:00:00Z") / 1000);
  // 只有外部留言 → 回退到 bot 的本文。
  const o2 = toOpenIssue({ ...view, comments: [view.comments[1]] });
  assert.equal(o2.lastSignature, "sBTC");
}

// 24 小時內關閉過 → reopen，不開新的；超過 24h 或非 bot 開的 → 不算。
{
  const now = Date.parse("2026-10-02T00:00:00Z") / 1000;
  const closed = [
    { number: 12, title: TITLE, author: bot, closedAt: "2026-10-01T06:00:00Z" },
    { number: 9, title: TITLE, author: bot, closedAt: "2026-09-20T06:00:00Z" },
    { number: 30, title: TITLE, author: mallory, closedAt: "2026-10-01T23:00:00Z" },
  ];
  const rc = pickRecentlyClosed(closed, TITLE, now);
  assert.equal(rc?.number, 12);
  assert.equal(pickRecentlyClosed(closed.slice(1), TITLE, now), null);
  assert.equal(decideAlert({ report: base, open: null, recentlyClosed: rc, nowSec: now }).action, "reopen");
  assert.equal(decideAlert({ report: base, open: null, recentlyClosed: null, nowSec: now }).action, "create");
  // 恢復狀態不會因為有最近關閉的 issue 而 reopen。
  assert.equal(decideAlert({ report: ok, open: null, recentlyClosed: rc, nowSec: now }).action, "none");
}

// ── 窄複審 4：連續 N 輪正常才關；保護中不關；恢復中又壞要歸零 ──────────────────
{
  const now = 1_790_000_000;
  const openAt = (okStreak: number) => ({ number: 7, lastSignature: "sAAPL", lastUpdatedSec: now - 3600, okStreak });
  // 第 1～3 輪正常 → recovering（計數 1,2,3），第 4 輪 → close。
  for (const [prev, want] of [[0, 1], [1, 2], [2, 3]] as const) {
    const d = decideAlert({ report: ok, open: openAt(prev), nowSec: now, closeAfterOk: 4 });
    assert.equal(d.action, "recovering", d.reason);
    assert.equal(d.okStreak, want);
  }
  assert.equal(decideAlert({ report: ok, open: openAt(3), nowSec: now, closeAfterOk: 4 }).action, "close");
  // 還有保護中的資產（ReduceOnly）→ 不關，即使已連續 4 輪。
  assert.equal(
    decideAlert({ report: { ...ok, protected: ["sAAPL(ReduceOnly)"] }, open: openAt(3), nowSec: now, closeAfterOk: 4 }).action,
    "none",
  );
  // 恢復中又壞 → 一定留言（計數歸零），即使簽章相同、24h 內更新過。
  {
    const d = decideAlert({ report: { ...base, stale: ["sAAPL(6h)"] }, open: openAt(2), nowSec: now });
    assert.equal(d.action, "comment", d.reason);
  }
  // 從 issue 留言解析 okStreak：最近的 bot 標記留言決定；過期留言在後 → 0。
  const view = (comments: { body: string; author: { login: string } }[]) =>
    toOpenIssue({
      number: 7, title: "t", author: bot, body: "<!-- oracle-health:stale=sAAPL -->", createdAt: "2026-10-01T00:00:00Z",
      comments: comments.map((c, i) => ({ ...c, createdAt: `2026-10-01T0${i + 1}:00:00Z` })),
    });
  const stale = { author: bot, body: "x <!-- oracle-health:stale=sAAPL -->" };
  const rec = (n: number) => ({ author: bot, body: renderRecovering(ok, n, 4) });
  assert.equal(view([stale, rec(1), rec(2)]).okStreak, 2);
  assert.equal(view([rec(1), rec(2), stale]).okStreak, 0);
  assert.equal(view([stale, rec(1), { author: mallory, body: "<!-- oracle-health:ok-streak=99 -->" }]).okStreak, 1, "外部留言不算");
  assert.equal(view([stale, rec(1)]).lastSignature, "sAAPL", "恢復中留言不影響過期簽章");
  assert.equal(parseOkStreak(renderRecovering(ok, 3, 4)), 3);
}

console.log("alert.test.ts ✓ all assertions passed");
