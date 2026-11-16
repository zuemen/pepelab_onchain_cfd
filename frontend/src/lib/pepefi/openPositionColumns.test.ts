import { describe, it, expect } from 'vitest'

import { COLUMN_LABELS, columnLabelForMode, openPositionColumnsForMode } from './openPositionColumns'

describe('openPositionColumnsForMode', () => {
  it('simple 模式只留 Asset、Side、Value、Unr. PnL 四欄,順序照這樣', () => {
    expect(openPositionColumnsForMode('simple', true)).toEqual(['asset', 'side', 'value', 'unrealizedPnl'])
  })

  it('expert 模式維持現有全部 12 欄、原本的順序不變', () => {
    expect(openPositionColumnsForMode('expert', true)).toEqual([
      'asset', 'carbonTier', 'side', 'entry', 'oracle', 'liveMarket',
      'margin', 'leverage', 'copiedFrom', 'unrealizedPnl', 'accruedFunding', 'value',
    ])
  })

  it('現貨呈現（showLeverage=false）收掉方向與槓桿兩欄，其餘順序不變', () => {
    // 2026-11-15 指導者：資產一律以 RWA 代幣現貨呈現
    expect(openPositionColumnsForMode('simple', false)).toEqual(['asset', 'value', 'unrealizedPnl'])
    expect(openPositionColumnsForMode('expert', false)).toEqual([
      'asset', 'carbonTier', 'entry', 'oracle', 'liveMarket',
      'margin', 'copiedFrom', 'unrealizedPnl', 'accruedFunding', 'value',
    ])
  })

  it('simple 是 expert 的子集,不會冒出一個 expert 沒有的欄位', () => {
    const expert = new Set(openPositionColumnsForMode('expert', true))
    for (const key of openPositionColumnsForMode('simple', true)) {
      expect(expert.has(key)).toBe(true)
    }
  })
})

describe('COLUMN_LABELS', () => {
  it('每一欄都有標籤,跟 expert 的欄位一一對應', () => {
    for (const key of openPositionColumnsForMode('expert', true)) {
      expect(COLUMN_LABELS[key]).toBeTruthy()
    }
  })

  it('COLUMN_LABELS（Expert 用）維持交易桌的用字', () => {
    expect(COLUMN_LABELS.unrealizedPnl).toBe('未實現損益')
    expect(COLUMN_LABELS.margin).toBe('投入金額')
  })
})

describe('columnLabelForMode — issue #100 ② / #101', () => {
  it('Expert 模式沿用 COLUMN_LABELS,一個字不動', () => {
    expect(columnLabelForMode('unrealizedPnl', 'expert')).toBe(COLUMN_LABELS.unrealizedPnl)
    expect(columnLabelForMode('margin', 'expert')).toBe(COLUMN_LABELS.margin)
    expect(columnLabelForMode('asset', 'expert')).toBe(COLUMN_LABELS.asset)
  })

  it('Simple 模式換掉交易桌的字:未實現損益 → 持有期報酬、保證金 → 投入金額', () => {
    expect(columnLabelForMode('unrealizedPnl', 'simple')).toBe('持有期報酬')
    expect(columnLabelForMode('margin', 'simple')).toBe('投入金額')
  })

  it('Simple 模式沒有覆寫的欄位沿用同一份標籤（例如 asset / side）', () => {
    expect(columnLabelForMode('asset', 'simple')).toBe(COLUMN_LABELS.asset)
    expect(columnLabelForMode('side', 'simple')).toBe(COLUMN_LABELS.side)
  })

  it('Simple 模式的四欄都拿得到非空標籤', () => {
    for (const key of openPositionColumnsForMode('simple', true)) {
      expect(columnLabelForMode(key, 'simple').length).toBeGreaterThan(0)
    }
  })
})
