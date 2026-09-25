import type { Mode } from 'src/contexts/mode-context'

// #150 / ADR-007：CopyTracker 跟單是 Expert Mode 的交易桌，Simple Mode 看不到它
// 的任何入口。Portfolio「部位」頁籤上有三塊跟單 UI，這裡決定每個模式看得到哪幾塊，
// 讓規則只有一份、可以直接測。
//
// 唯一的例外跟 SHOW_PERPETUALS、Open Positions 表格同一條原則——收的是入口，不是
// 既有部位：Simple Mode 使用者若已經有跟單（切模式前開的），「跟單部位」卡片仍然
// 出現，否則他看不到、也平不掉自己的錢。統計卡與績效圖是交易桌儀表，不在例外內。

export interface CopyDeskVisibility {
  /** 「跟單部位」卡片（含取消跟單按鈕；零筆時是帶「瀏覽交易者」的空狀態）。 */
  records: boolean
  /** 跟單數與總報酬兩張統計卡。 */
  stats: boolean
  /** 跟單績效圖。頁面另外還要求有兩個真實的點可畫。 */
  performance: boolean
}

export function copyDeskVisibility(mode: Mode, copyCount: number): CopyDeskVisibility {
  const hasCopies = copyCount > 0
  if (mode === 'expert') {
    return { records: true, stats: hasCopies, performance: true }
  }
  return { records: hasCopies, stats: false, performance: false }
}
