import type { Mode } from 'src/contexts/mode-context'

import { t } from 'src/locales'
import { SHOW_LEVERAGE } from 'src/lib/pepefi/featureFlags'

// Open Positions 在 expert 模式下是一張交易桌——entry/oracle/live/margin/
// leverage/funding 全部攤開。simple 模式的原則跟 nav（navDataForMode）一樣：只回答「我有什麼、現在好不好」，不回答「怎麼算的」。
// 這裡把「這個模式看得到哪些欄」抽成純函式，讓 Simple/Expert 的欄位清單只有
// 一份、可以直接測，不必靠讀 JSX 才知道兩邊差在哪。

export type OpenPositionColumnKey =
  | 'asset' | 'carbonTier' | 'side' | 'entry' | 'oracle' | 'liveMarket'
  | 'margin' | 'leverage' | 'copiedFrom' | 'unrealizedPnl' | 'accruedFunding' | 'value'

export const COLUMN_LABELS: Record<OpenPositionColumnKey, string> = t.portfolio.column

const EXPERT_COLUMNS: OpenPositionColumnKey[] = [
  'asset', 'carbonTier', 'side', 'entry', 'oracle', 'liveMarket',
  'margin', 'leverage', 'copiedFrom', 'unrealizedPnl', 'accruedFunding', 'value',
]

const SIMPLE_COLUMNS: OpenPositionColumnKey[] = ['asset', 'side', 'value', 'unrealizedPnl']

/**
 * `showLeverage` 為 false（現貨呈現，2026-11-15 指導者：資產一律以 RWA 代幣現貨呈現）時
 * 收掉方向與槓桿兩欄；既有部位照樣列出、照樣能平倉，只是不顯示倍數與做多／做空。
 */
export function openPositionColumnsForMode(mode: Mode, showLeverage: boolean = SHOW_LEVERAGE): OpenPositionColumnKey[] {
  const cols = mode === 'simple' ? SIMPLE_COLUMNS : EXPERT_COLUMNS
  return showLeverage ? cols : cols.filter((k) => k !== 'side' && k !== 'leverage')
}

// issue #100 ② / #101 — Simple Mode 換掉交易桌的用字。這裡本來刻意不動用字，
// 只決定「哪幾欄看得到」；現在 Simple Mode 的欄名改用投資人的說法（未實現損益
// → 持有期報酬、保證金 → 投入金額），其餘欄位沿用同一份 COLUMN_LABELS。
// Expert Mode 一個字都不動。
const SIMPLE_COLUMN_LABELS: Partial<Record<OpenPositionColumnKey, string>> = t.portfolio.columnSimple

export function columnLabelForMode(key: OpenPositionColumnKey, mode: Mode): string {
  if (mode === 'simple') return SIMPLE_COLUMN_LABELS[key] ?? COLUMN_LABELS[key]
  return COLUMN_LABELS[key]
}
