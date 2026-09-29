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
}

export type AlertAction = "create" | "comment" | "close" | "none";

export interface AlertDecision {
  action: AlertAction;
  reason: string;
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
  nowSec: number;
  repeatSec?: number;
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
    return { action: "close", reason: `全部資產恢復，關閉 #${open.number}` };
  }

  // stale
  if (!open) return { action: "create", reason: `新的過期事件：${signatureOf(report.stale)}` };

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

export function renderCloseComment(report: HealthReport, runUrl?: string): string {
  return [
    `已恢復：${iso(report.checkedAtSec)} 檢查時所有資產都在 ${(report.maxAgeSec / 3600).toFixed(1)}h 門檻內，自動關閉。`,
    ...(report.closed?.length ? [`（休市中、依市場時段放寬：${report.closed.join(", ")}）`] : []),
    ...(runUrl ? ["", `Run：${runUrl}`] : []),
    "",
    "<!-- oracle-health:stale= -->",
  ].join("\n");
}
