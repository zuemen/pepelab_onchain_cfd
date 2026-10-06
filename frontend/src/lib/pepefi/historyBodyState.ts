/**
 * 歷史紀錄頁表格區要畫什麼。
 *
 * 2026-10-06 實測：公開節點把 getLogs 範圍降到 500 塊後，日誌掃描會慢很多（失敗段要退避重試）。
 * 舊條件只在「部位讀取中」才顯示骨架；部位讀完（0 筆）但**日誌還在掃**時直接落到空狀態
 * 「尚無活動——過去 9,000 個區塊內找不到事件」，掃描還沒結束就對使用者說沒有資料。
 *
 * 規則：
 *  - 還沒有任何一筆、而部位或日誌任一仍在讀 → 骨架（不下結論）。
 *  - 讀完、篩完是 0 筆、而且有錯誤 → 讀取失敗（不是「沒有活動」）。
 *  - 讀完、篩完是 0 筆、沒有錯誤 → 空狀態。
 *  - 其他 → 表格（已經有資料時，重新整理期間保留舊列）。
 */
export type HistoryBodyState = 'skeleton' | 'readFailed' | 'empty' | 'table'

export function historyBodyState(s: {
  loading: boolean
  scanning: boolean
  eventCount: number
  visibleCount: number
  hasError: boolean
}): HistoryBodyState {
  if ((s.loading || s.scanning) && s.eventCount === 0) return 'skeleton'
  if (s.visibleCount === 0 && s.hasError) return 'readFailed'
  if (s.visibleCount === 0) return 'empty'
  return 'table'
}
