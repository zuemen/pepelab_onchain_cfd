import type { Mode } from 'src/contexts/mode-context'

import { t } from 'src/locales'

// Open Positions 在 expert 模式下是一張交易桌——entry/oracle/live/margin/
// leverage/funding 全部攤開。simple 模式的原則跟 nav（navDataForMode）、
// PortfolioAnalysis 一樣：只回答「我有什麼、現在好不好」，不回答「怎麼算的」。
// 這裡把「這個模式看得到哪些欄」抽成純函式，讓 Simple/Expert 的欄位清單只有
// 一份、可以直接測，不必靠讀 JSX 才知道兩邊差在哪。

export type OpenPositionColumnKey =
  | 'asset' | 'esg' | 'side' | 'entry' | 'oracle' | 'liveMarket'
  | 'margin' | 'leverage' | 'copiedFrom' | 'unrealizedPnl' | 'accruedFunding' | 'value'

export const COLUMN_LABELS: Record<OpenPositionColumnKey, string> = t.portfolio.column

const EXPERT_COLUMNS: OpenPositionColumnKey[] = [
  'asset', 'esg', 'side', 'entry', 'oracle', 'liveMarket',
  'margin', 'leverage', 'copiedFrom', 'unrealizedPnl', 'accruedFunding', 'value',
]

const SIMPLE_COLUMNS: OpenPositionColumnKey[] = ['asset', 'side', 'value', 'unrealizedPnl']

export function openPositionColumnsForMode(mode: Mode): OpenPositionColumnKey[] {
  return mode === 'simple' ? SIMPLE_COLUMNS : EXPERT_COLUMNS
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
