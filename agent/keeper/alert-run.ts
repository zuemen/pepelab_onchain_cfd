// oracle-health 告警 CLI：讀 health.ts 的報告，依 alert.ts 的決策用 gh 開／留言／關 issue。
//
// 用法（CI，見 .github/workflows/oracle-health.yml）：
//   HEALTH_REPORT_PATH=... ALERT_TITLE="[oracle-health] Base Sepolia 價格過期" \
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo npx tsx keeper/alert-run.ts
//
// 本機 dry-run（不需要 gh、不會動任何 issue，只印出會做什麼）：
//   cd agent
//   ALERT_DRY_RUN=1 HEALTH_REPORT_PATH=keeper/fixtures/health-stale.json \
//     ALERT_FAKE_OPEN_ISSUE=none npx tsx keeper/alert-run.ts
//   ALERT_DRY_RUN=1 HEALTH_REPORT_PATH=keeper/fixtures/health-ok.json \
//     ALERT_FAKE_OPEN_ISSUE='{"number":7,"lastSignature":"sBTC","lastUpdatedSec":0}' \
//     npx tsx keeper/alert-run.ts
//   ALERT_FAKE_RECENTLY_CLOSED='{"number":7,"closedAtSec":…}' 模擬 24h 內關閉過 → reopen。
//
// 偽造防護（審查 Medium 5）：只認 label=oracle-health 且作者是 github-actions 的 issue，
// 節流簽章只取 github-actions 的留言，見 alert.ts。
//
// 所有 gh 呼叫都用 execFileSync 傳陣列參數、內文走 --body-file：不經過 shell，
// 報告內容（來自外部 API 的錯誤訊息）無法注入指令。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAlert,
  pickOwnIssue,
  pickRecentlyClosed,
  renderBody,
  renderCloseComment,
  renderRecovering,
  DEFAULT_CLOSE_AFTER_OK,
  toOpenIssue,
  ALERT_LABEL,
  DEFAULT_REPEAT_SEC,
  type GhIssue,
  type HealthReport,
  type OpenIssue,
} from "./alert.ts";

const DRY_RUN = process.env.ALERT_DRY_RUN === "1";
const TITLE = (process.env.ALERT_TITLE ?? "").trim();
const REPO = (process.env.GITHUB_REPOSITORY ?? "").trim();
const REPORT_PATH = (process.env.HEALTH_REPORT_PATH ?? "").trim();
const REPEAT_SEC = Number(process.env.ALERT_REPEAT_SEC ?? String(DEFAULT_REPEAT_SEC));
// 窄複審 4：連續幾輪正常才關 issue。非正整數一律退回預設（告警步驟不因設定錯而中止）。
const CLOSE_AFTER_OK = (() => {
  const n = Number(process.env.ALERT_CLOSE_AFTER ?? String(DEFAULT_CLOSE_AFTER_OK));
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_CLOSE_AFTER_OK;
})();
const RUN_URL =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

function gh(args: string[]): string {
  return execFileSync("gh", [...args, "--repo", REPO], { encoding: "utf8" });
}

function bodyFile(body: string): string {
  if (DRY_RUN) return "<body.md>";
  const f = join(mkdtempSync(join(tmpdir(), "oracle-health-")), "body.md");
  writeFileSync(f, body, "utf8");
  return f;
}

// 只列 ALERT_LABEL 的 issue（label 只有 triage 以上權限能加，外部使用者偽造不了），
// 作者再於用戶端檢查必須是 github-actions。label 過濾後數量很小，--limit 50 不會漏抓。
// 不用 --search：搜尋索引有延遲，也會把 `[oracle-health]` 的中括號斷詞。
function listOwn(state: "open" | "closed"): GhIssue[] {
  return JSON.parse(
    gh([
      "issue", "list", "--state", state, "--label", ALERT_LABEL, "--limit", "50",
      "--json", "number,title,author,closedAt",
    ]),
  ) as GhIssue[];
}

/** 找 github-actions 開的、同標題、開著的告警 issue。 */
function findOpen(): OpenIssue | null {
  const fake = process.env.ALERT_FAKE_OPEN_ISSUE;
  if (fake !== undefined) return fake === "none" ? null : (JSON.parse(fake) as OpenIssue);

  const hit = pickOwnIssue(listOwn("open"), TITLE);
  if (!hit) return null;
  const view = JSON.parse(
    gh(["issue", "view", String(hit.number), "--json", "number,title,author,body,createdAt,comments"]),
  ) as GhIssue;
  return toOpenIssue(view);
}

function findRecentlyClosed(nowSec: number): { number: number; closedAtSec: number } | null {
  const fake = process.env.ALERT_FAKE_RECENTLY_CLOSED;
  if (fake !== undefined) return fake === "none" ? null : JSON.parse(fake);
  return pickRecentlyClosed(listOwn("closed"), TITLE, nowSec);
}

function loadReport(): HealthReport {
  if (!REPORT_PATH || !existsSync(REPORT_PATH)) {
    return {
      chain: "?", status: "error", checkedAtSec: Math.floor(Date.now() / 1000),
      maxAgeSec: 0, stale: [], lines: [], error: `找不到健檢報告 ${REPORT_PATH || "(未設 HEALTH_REPORT_PATH)"}`,
    };
  }
  return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as HealthReport;
}

function main(): void {
  if (!TITLE) {
    throw new Error("ALERT_TITLE 未設");
  }
  if (!DRY_RUN && !REPO) {
    throw new Error("GITHUB_REPOSITORY 未設");
  }

  const report = loadReport();
  const nowSec = Math.floor(Date.now() / 1000);
  const open = findOpen();
  // 只有「要開新告警」時才需要查最近關閉的那張。
  const recentlyClosed = !open && report.status === "stale" ? findRecentlyClosed(nowSec) : null;
  const d = decideAlert({ report, open, recentlyClosed, nowSec, repeatSec: REPEAT_SEC, closeAfterOk: CLOSE_AFTER_OK });
  console.log(`[${TITLE}] status=${report.status} open=${open ? `#${open.number}` : "none"} → ${d.action}：${d.reason}`);

  const run = (args: string[]) => {
    if (DRY_RUN) {
      console.log(`  (dry-run) gh ${args.join(" ")} --repo ${REPO || "<repo>"}`);
      return;
    }
    gh(args);
  };

  switch (d.action) {
    case "create": {
      const body = renderBody(report, RUN_URL);
      if (DRY_RUN) console.log(body);
      // label 不存在時 issue create 會失敗；--force 讓它冪等（已存在就只更新顏色/說明）。
      run(["label", "create", ALERT_LABEL, "--color", "B60205", "--description", "oracle-health 自動告警（勿手動加）", "--force"]);
      run(["issue", "create", "--title", TITLE, "--label", ALERT_LABEL, "--body-file", bodyFile(body)]);
      break;
    }
    case "reopen": {
      const body = renderBody(report, RUN_URL);
      if (DRY_RUN) console.log(body);
      run(["issue", "reopen", String(recentlyClosed!.number)]);
      run(["issue", "comment", String(recentlyClosed!.number), "--body-file", bodyFile(body)]);
      break;
    }
    case "comment": {
      const body = renderBody(report, RUN_URL);
      if (DRY_RUN) console.log(body);
      run(["issue", "comment", String(open!.number), "--body-file", bodyFile(body)]);
      break;
    }
    case "recovering": {
      const body = renderRecovering(report, d.okStreak ?? 1, CLOSE_AFTER_OK, RUN_URL);
      if (DRY_RUN) console.log(body);
      run(["issue", "comment", String(open!.number), "--body-file", bodyFile(body)]);
      break;
    }
    case "close": {
      const body = renderCloseComment(report, RUN_URL);
      if (DRY_RUN) console.log(body);
      run(["issue", "comment", String(open!.number), "--body-file", bodyFile(body)]);
      run(["issue", "close", String(open!.number), "--reason", "completed"]);
      break;
    }
    case "none":
      break;
  }
}

try {
  main();
} catch (e) {
  // 告警步驟本身失敗（gh 限流、權限、label）只發 warning 並 exit 0：job 的紅綠只
  // 代表健檢結果（health step），不能被「告警壞了」蓋掉或混淆。
  console.log(`::warning::oracle-health 告警步驟失敗（健檢結果不受影響）：${(e as Error).message.slice(0, 300)}`);
  process.exit(0);
}
