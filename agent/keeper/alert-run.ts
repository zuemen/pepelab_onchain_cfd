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
//
// 所有 gh 呼叫都用 execFileSync 傳陣列參數、內文走 --body-file：不經過 shell，
// 報告內容（來自外部 API 的錯誤訊息）無法注入指令。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAlert,
  parseSignature,
  renderBody,
  renderCloseComment,
  DEFAULT_REPEAT_SEC,
  type HealthReport,
  type OpenIssue,
} from "./alert.ts";

const DRY_RUN = process.env.ALERT_DRY_RUN === "1";
const TITLE = (process.env.ALERT_TITLE ?? "").trim();
const REPO = (process.env.GITHUB_REPOSITORY ?? "").trim();
const REPORT_PATH = (process.env.HEALTH_REPORT_PATH ?? "").trim();
const REPEAT_SEC = Number(process.env.ALERT_REPEAT_SEC ?? String(DEFAULT_REPEAT_SEC));
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

function toSec(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** 找同標題、開著的 issue（多個就取最舊的那個，其他視為人為重複）。 */
function findOpen(): OpenIssue | null {
  const fake = process.env.ALERT_FAKE_OPEN_ISSUE;
  if (fake !== undefined) return fake === "none" ? null : (JSON.parse(fake) as OpenIssue);

  // 不用 --search：搜尋索引有延遲，也會把 `[oracle-health]` 的中括號斷詞。
  const list = JSON.parse(
    gh(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title"]),
  ) as { number: number; title: string }[];
  const hit = list.filter((i) => i.title === TITLE).sort((a, b) => a.number - b.number)[0];
  if (!hit) return null;

  const view = JSON.parse(
    gh(["issue", "view", String(hit.number), "--json", "body,createdAt,comments"]),
  ) as { body: string; createdAt: string; comments: { body: string; createdAt: string }[] };
  for (const c of [...view.comments].reverse()) {
    const sig = parseSignature(c.body);
    if (sig !== null) return { number: hit.number, lastSignature: sig, lastUpdatedSec: toSec(c.createdAt) };
  }
  return {
    number: hit.number,
    lastSignature: parseSignature(view.body),
    lastUpdatedSec: toSec(view.createdAt),
  };
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
    console.error("::error::ALERT_TITLE 未設");
    process.exit(1);
  }
  if (!DRY_RUN && !REPO) {
    console.error("::error::GITHUB_REPOSITORY 未設");
    process.exit(1);
  }

  const report = loadReport();
  const open = findOpen();
  const d = decideAlert({ report, open, nowSec: Math.floor(Date.now() / 1000), repeatSec: REPEAT_SEC });
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
      run(["issue", "create", "--title", TITLE, "--body-file", bodyFile(body)]);
      break;
    }
    case "comment": {
      const body = renderBody(report, RUN_URL);
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
  // 告警失敗不該蓋掉健檢結果：印 error 讓人看到，但 exit 1 只代表「告警壞了」。
  console.error(`::error::oracle-health 告警失敗：${(e as Error).message.slice(0, 300)}`);
  process.exit(1);
}
