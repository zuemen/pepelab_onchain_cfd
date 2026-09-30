// 決定這一次 cron 要不要觸發 keeper workflow。純函式，方便測試。
//
// 為什麼需要外部觸發：base-sepolia-keeper.yml 名目上每 15 分鐘跑一次，但 GitHub
// 排程是 best-effort，實測間隔 68–169 分鐘，2026-09-30 甚至超過 4.5 小時沒跑。
// 交易所的 maxPriceAge 是 6 小時，一次寫價失敗再遇上排程延遲，sBTC 就過期到無法交易。
//
// 規則：
//   - 最近一次執行還在排隊或進行中 → 不觸發（workflow 的 concurrency 是
//     cancel-in-progress: false，重複觸發只會排隊，但沒有必要）。
//   - 最近一次執行（不論觸發來源）建立於 minGapSec 內 → 不觸發。
//   - 讀不到執行紀錄 → 觸發（寧可多跑一次；keeper 在不需要寫價時不送交易）。

/**
 * @param {{ status?: string, created_at?: string } | null | undefined} latestRun
 * @param {number} nowMs
 * @param {number} [minGapSec]
 * @returns {{ dispatch: boolean, reason: string }}
 */
export function decide(latestRun, nowMs, minGapSec = 15 * 60) {
  if (!latestRun) return { dispatch: true, reason: "no previous run found" };
  const status = latestRun.status ?? "";
  if (["queued", "in_progress", "waiting", "requested", "pending"].includes(status)) {
    return { dispatch: false, reason: `latest run is ${status}` };
  }
  const created = Date.parse(latestRun.created_at ?? "");
  if (!Number.isFinite(created)) return { dispatch: true, reason: "latest run has no valid created_at" };
  const ageSec = Math.floor((nowMs - created) / 1000);
  if (ageSec < minGapSec) return { dispatch: false, reason: `latest run is ${ageSec}s old (< ${minGapSec}s)` };
  return { dispatch: true, reason: `latest run is ${ageSec}s old` };
}
