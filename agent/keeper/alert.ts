// oracle-health 告警：STALE 時在 repo 開 issue，已開著就留言更新，恢復後自動關閉。
//
// 為什麼不只靠 job 失敗：GitHub 對排程 job 失敗的預設通知只寄給「最後修改該
// workflow 的人」，而且每 3 小時一封、內容只有「failed」。持牌機構要看的是
// 「哪天幾點開始過期、哪些資產、何時恢復」這條可稽核的時間線 —— issue 就是那條線。
//
// 這個檔案只有純函式（決策＋內文），不碰網路也不碰 gh，才能被單元測試覆蓋。
// 實際呼叫 gh 的是 alert-run.ts。

export type HealthStatus = "ok" | "stale" | "error";

/** health.ts 寫出的報告（HEALTH_REPORT_PATH）。 */
export interface HealthReport {
  /** health = oracle-health 的過期告警（預設）；breaker = keeper 的價格熔斷告警（複審 H2 (c)）。 */
  kind?: "health" | "breaker" | "funding";
  /** breaker：停單動作的結果與「需人工處置」的說明。 */
  notes?: string[];
  chain: string;
  status: HealthStatus;
  checkedAtSec: number;
  maxAgeSec: number;
  /** 判定過期的資產，例如 ["sBTC(6.1h)", "sAAPL(unreadable)"]。 */
  stale: string[];
  /** 休市中、依市場時段放寬而未告警的資產（第 4 項）。 */
  closed?: string[];
  /** RPC 讀不到的資產 —— 不算過期，但也不能證明已恢復，所以會擋住自動關閉。 */
  unreadable?: string[];
  /** 只靠行事曆後備（沒有 Yahoo 時段）被放寬的資產 —— 同樣擋住自動關閉。 */
  fallbackTolerated?: string[];
  /** 交易所上仍在保護中（ReduceOnly／Halted）的資產 —— 擋住自動關閉（窄複審 4）。 */
  protected?: string[];
  /** 每個資產一行的人類可讀輸出。 */
  lines: string[];
  error?: string;
}

/** 已開著、同標題的 issue 目前狀態。 */
export interface OpenIssue {
  number: number;
  /** 最近一次（本文或留言）寫入的簽章，見 signatureOf()。 */
  lastSignature: string | null;
  /** 最近一次（本文或留言）的時間。 */
  lastUpdatedSec: number;
  /** 目前連續正常的輪數（最近一則 bot 標記留言的 ok-streak；過期留言歸零）。 */
  okStreak?: number;
}

export type AlertAction = "create" | "reopen" | "comment" | "recovering" | "close" | "none";

/** 窄複審 4：連續幾輪正常才自動關 issue（keeper 設 4 ≈ 1 小時；預設 1）。 */
export const DEFAULT_CLOSE_AFTER_OK = 1;
const STREAK_RE = /<!--\s*oracle-health:ok-streak=(\d+)\s*-->/;
export function parseOkStreak(text: string | null | undefined): number | null {
  const m = (text ?? "").match(STREAK_RE);
  return m ? Number(m[1]) : null;
}

// ── 公開 repo 上的 issue 偽造防護（審查 Medium 5）──────────────────────────
// 任何人都能在公開 repo 開一張同標題的 issue，或在告警 issue 底下留一則帶簽章的
// 留言，讓 keeper 以為「已經告警過／集合沒變」而靜默。所以：
//   • 只認 github-actions 開的、帶 ALERT_LABEL 的 issue（label 只有 triage 以上權限
//     能加，外部使用者加不上；author 在用戶端再檢查一次）。
//   • 節流簽章只從 github-actions 的留言解析。
//   • 24 小時內關閉過的同標題 issue 用 reopen，不另開新的（時間線留在同一張）。

export const ALERT_LABEL = "oracle-health";
/** 恢復後多久內再壞就 reopen 同一張，而不是開新的。 */
export const REOPEN_WINDOW_SEC = 24 * 3600;

/** gh 的 GraphQL 回 "github-actions"，REST 回 "github-actions[bot]"；兩者都認。 */
const BOT_LOGINS = new Set(["github-actions", "github-actions[bot]", "app/github-actions"]);
export const isBotAuthor = (login: string | undefined | null): boolean => !!login && BOT_LOGINS.has(login);

/** `gh issue list/view --json …` 回來的形狀（只列用得到的欄位）。 */
export interface GhIssue {
  number: number;
  title: string;
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  closedAt?: string | null;
  comments?: { author?: { login?: string } | null; body: string; createdAt: string }[];
}

const toSec = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

/** 同標題、github-actions 開的 issue 中取最舊的（其他視為重複）。 */
export function pickOwnIssue(list: GhIssue[], title: string): GhIssue | null {
  return (
    list
      .filter((i) => i.title === title && isBotAuthor(i.author?.login))
      .sort((a, b) => a.number - b.number)[0] ?? null
  );
}

/** 由 issue 詳情組出 OpenIssue；簽章只從 github-actions 的留言（或本文）取。 */
export function toOpenIssue(view: GhIssue): OpenIssue {
  const bot = [...(view.comments ?? [])].filter((c) => isBotAuthor(c.author?.login)).reverse();
  // okStreak：最近一則帶任一標記的 bot 留言；是「恢復中」就取其計數，是過期留言就歸零。
  let okStreak = 0;
  for (const c of bot) {
    const n = parseOkStreak(c.body);
    if (n !== null) {
      okStreak = n;
      break;
    }
    if (parseSignature(c.body) !== null) break;
  }
  for (const c of bot) {
    const sig = parseSignature(c.body);
    if (sig !== null) return { number: view.number, lastSignature: sig, lastUpdatedSec: toSec(c.createdAt), okStreak };
  }
  return { number: view.number, lastSignature: parseSignature(view.body), lastUpdatedSec: toSec(view.createdAt), okStreak };
}

/** window 內關閉過、github-actions 開的同標題 issue（取最近關閉的）。 */
export function pickRecentlyClosed(
  list: GhIssue[],
  title: string,
  nowSec: number,
  windowSec = REOPEN_WINDOW_SEC,
): { number: number; closedAtSec: number } | null {
  const hits = list
    .filter((i) => i.title === title && isBotAuthor(i.author?.login))
    .map((i) => ({ number: i.number, closedAtSec: toSec(i.closedAt) }))
    .filter((i) => i.closedAtSec > 0 && nowSec - i.closedAtSec <= windowSec)
    .sort((a, b) => b.closedAtSec - a.closedAtSec);
  return hits[0] ?? null;
}

export interface AlertDecision {
  action: AlertAction;
  reason: string;
  /** recovering：這一輪之後的連續正常輪數。 */
  okStreak?: number;
}

/** 過期集合相同、且距上次更新未滿這麼久，就不重複留言（避免每 3 小時洗版）。 */
export const DEFAULT_REPEAT_SEC = 24 * 3600;

const SIG_RE = /<!--\s*oracle-health:stale=([^>]*?)\s*-->/;

/** 過期集合的簽章：只看資產名、排序後串起來（年齡每輪都在變，不算）。 */
export function signatureOf(stale: string[]): string {
  return [...new Set(stale.map((s) => s.replace(/\(.*$/, "").trim()))].sort().join(",");
}

/** 從 issue 本文或留言裡找回簽章。 */
export function parseSignature(text: string | null | undefined): string | null {
  const m = (text ?? "").match(SIG_RE);
  return m ? m[1] : null;
}

export function decideAlert(a: {
  report: HealthReport;
  open: OpenIssue | null;
  /** 24 小時內關閉過的同一張告警（沒有開著的時才看）。 */
  recentlyClosed?: { number: number; closedAtSec: number } | null;
  nowSec: number;
  repeatSec?: number;
  closeAfterOk?: number;
}): AlertDecision {
  const repeat = a.repeatSec ?? DEFAULT_REPEAT_SEC;
  const { report, open } = a;

  if (report.status === "error") {
    // 健檢本身壞了（RPC 掛、secret 沒設）不代表價格過期；開 issue 會把兩種事故
    // 混在一起。job 仍會失敗，GitHub 的預設通知照常發出。
    return { action: "none", reason: `健檢本身失敗，不動 issue：${report.error ?? "unknown"}` };
  }

  if (report.status === "ok") {
    if (!open) return { action: "none", reason: "全部資產正常，且沒有開著的告警" };
    // 讀不到的資產不能證明已恢復；關掉 issue 會讓「仍在壞」的事故從時間線上消失。
    if (report.unreadable?.length) {
      return {
        action: "none",
        reason: `仍有資產讀不到（${report.unreadable.join(", ")}），無法確認恢復，不關閉 #${open.number}`,
      };
    }
    // 只靠行事曆後備判「休市」的資產：Yahoo 拿不到，無法確認真的休市，不據此關閉。
    if (report.fallbackTolerated?.length) {
      return {
        action: "none",
        reason: `${report.fallbackTolerated.join(", ")} 僅靠行事曆後備判為休市，無法確認恢復，不關閉 #${open.number}`,
      };
    }
    // 窄複審 4：還有資產在保護中（交易所 ReduceOnly／Halted）就不關 —— 事故沒結束，
    // 只是被人或 keeper 擋住了，解除是人工步驟。
    if (report.protected?.length) {
      return {
        action: "none",
        reason: `仍有保護中的資產（${report.protected.join(", ")}），不關閉 #${open.number}`,
      };
    }
    // 窄複審 4：連續 N 輪正常才關（keeper N=4 ≈ 1 小時），避免在門檻邊緣反覆開關。
    const need = Math.max(1, a.closeAfterOk ?? DEFAULT_CLOSE_AFTER_OK);
    const streak = (open.okStreak ?? 0) + 1;
    if (streak < need) {
      return { action: "recovering", okStreak: streak, reason: `恢復中 ${streak}/${need} 輪，暫不關閉 #${open.number}` };
    }
    return { action: "close", reason: `連續 ${streak} 輪正常，關閉 #${open.number}` };
  }

  // stale
  if (!open && a.recentlyClosed) {
    return {
      action: "reopen",
      reason: `#${a.recentlyClosed.number} 關閉後 ${((a.nowSec - a.recentlyClosed.closedAtSec) / 3600).toFixed(1)}h 又過期，reopen：${signatureOf(report.stale)}`,
    };
  }
  if (!open) return { action: "create", reason: `新的過期事件：${signatureOf(report.stale)}` };
  // 恢復中又壞：一定要留言，讓連續正常計數歸零。
  if ((open.okStreak ?? 0) > 0) {
    return { action: "comment", reason: `恢復中（${open.okStreak} 輪）又過期，計數歸零，留言更新 #${open.number}` };
  }

  const sig = signatureOf(report.stale);
  if (open.lastSignature !== sig) {
    return {
      action: "comment",
      reason: `過期集合改變（${open.lastSignature ?? "?"} → ${sig}），留言更新 #${open.number}`,
    };
  }
  const since = a.nowSec - open.lastUpdatedSec;
  if (since >= repeat) {
    return {
      action: "comment",
      reason: `同一組資產仍過期，距上次更新 ${(since / 3600).toFixed(1)}h，留言更新 #${open.number}`,
    };
  }
  return {
    action: "none",
    reason: `同一組資產仍過期，距上次更新 ${(since / 3600).toFixed(1)}h < ${(repeat / 3600).toFixed(0)}h，不重複留言`,
  };
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

/** 新開 issue 與留言共用的內文。runUrl 是這次 Actions run 的連結。 */
export function renderBody(report: HealthReport, runUrl?: string): string {
  if (report.kind === "breaker") return renderBreakerBody(report, runUrl);
  if (report.kind === "funding") {
    return [
      `**鏈**：${report.chain}　**檢查時間**：${iso(report.checkedAtSec)}　**上限**：${(report.maxAgeSec / 3600).toFixed(1)}h（2 × FUNDING_INTERVAL）`,
      "",
      `**funding 未結算資產（${report.stale.length}）**：${report.stale.join(", ") || "—"}`,
      ...(report.unreadable?.length ? [`**讀不到**：${report.unreadable.join(", ")}`] : []),
      "",
      "lastFundingUpdateAt 超過 2 × FUNDING_INTERVAL：持倉的 funding 沒有在結算。",
      "處置：看 base-sepolia-keeper 的「Crank settleFunding」step —— 是否因熔斷跳過該資產、",
      "拒寫清單不存在、或 settleFunding 本身失敗（log 會印 revert 原文）。",
      "",
      "```",
      ...report.lines,
      "```",
      ...(runUrl ? ["", `Run：${runUrl}`] : []),
      "",
      `<!-- oracle-health:stale=${signatureOf(report.stale)} -->`,
    ].join("\n");
  }
  const out = [
    `**鏈**：${report.chain}　**檢查時間**：${iso(report.checkedAtSec)}　**門檻**：${(report.maxAgeSec / 3600).toFixed(1)}h`,
    "",
    `**過期資產（${report.stale.length}）**：${report.stale.join(", ") || "—"}`,
  ];
  if (report.closed?.length) {
    out.push(`**休市中、未告警**：${report.closed.join(", ")}`);
  }
  if (report.unreadable?.length) {
    out.push(`**讀不到（RPC，未算過期）**：${report.unreadable.join(", ")}`);
  }
  out.push(
    "",
    "過期資產在交易所會 revert `StalePrice` —— 開倉、平倉、清算全部無法執行。",
    "處置：先看 keeper（base-sepolia-keeper / price-keeper）最近一次 run 的日誌與錢包餘額。",
    "",
    "```",
    ...report.lines,
    "```",
  );
  if (runUrl) out.push("", `Run：${runUrl}`);
  out.push("", `<!-- oracle-health:stale=${signatureOf(report.stale)} -->`);
  return out.join("\n");
}

/** keeper 價格熔斷的 issue 內文：哪些資產被拒寫、停單做到哪、哪裡需要人工。 */
function renderBreakerBody(report: HealthReport, runUrl?: string): string {
  const age = report.maxAgeSec > 0 ? `${(report.maxAgeSec / 3600).toFixed(1)}h` : "maxPriceAge";
  const out = [
    `**鏈**：${report.chain}　**時間**：${iso(report.checkedAtSec)}　**交易所 maxPriceAge**：${age}`,
    "",
    `**熔斷拒寫資產（${report.stale.length}）**：${report.stale.join(", ") || "—"}`,
    "",
    "MockOracle 與 GuardedOracle 都沒有寫入。價格停在舊值；在 maxPriceAge 到期前，",
    "交易所仍會以這個舊價成交。停單動作與結果：",
    "",
    ...(report.notes ?? []).map((n) => `- ${n}`),
    "",
    "處置步驟：docs/RUNBOOK_KEEPER.md「價格熔斷」。",
    "",
    "```",
    ...report.lines,
    "```",
  ];
  if (report.unreadable?.length) out.push("", `**本輪來源無效（未判斷）**：${report.unreadable.join(", ")}`);
  if (runUrl) out.push("", `Run：${runUrl}`);
  out.push("", `<!-- oracle-health:stale=${signatureOf(report.stale)} -->`);
  return out.join("\n");
}

/** 恢復中（未達連續 N 輪）的簡短留言；帶 ok-streak 標記供下一輪累計。 */
export function renderRecovering(report: HealthReport, streak: number, need: number, runUrl?: string): string {
  return [
    `恢復中：${iso(report.checkedAtSec)} 這一輪正常（連續 ${streak}/${need} 輪）；連續 ${need} 輪正常後自動關閉。`,
    ...(runUrl ? ["", `Run：${runUrl}`] : []),
    "",
    `<!-- oracle-health:ok-streak=${streak} -->`,
  ].join("\n");
}

export function renderCloseComment(report: HealthReport, runUrl?: string): string {
  if (report.kind === "breaker") {
    return [
      `已恢復：${iso(report.checkedAtSec)} 這一輪沒有資產被熔斷拒寫，自動關閉。`,
      "若先前有凍結 GuardedOracle 或切 ReduceOnly，需人工確認後解除（keeper 不會自動解除）。",
      ...(runUrl ? ["", `Run：${runUrl}`] : []),
      "",
      "<!-- oracle-health:stale= -->",
    ].join("\n");
  }
  return [
    `已恢復：${iso(report.checkedAtSec)} 檢查時所有資產都在 ${(report.maxAgeSec / 3600).toFixed(1)}h 門檻內，自動關閉。`,
    ...(report.closed?.length ? [`（休市中、依市場時段放寬：${report.closed.join(", ")}）`] : []),
    ...(runUrl ? ["", `Run：${runUrl}`] : []),
    "",
    "<!-- oracle-health:stale= -->",
  ].join("\n");
}
