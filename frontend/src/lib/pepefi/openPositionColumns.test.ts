import { describe, it, expect } from 'vitest'

import { COLUMN_LABELS, openPositionColumnsForMode } from './openPositionColumns'

describe('openPositionColumnsForMode', () => {
  it('simple 模式只留 Asset、Side、Value、Unr. PnL 四欄,順序照這樣', () => {
    expect(openPositionColumnsForMode('simple')).toEqual(['asset', 'side', 'value', 'unrealizedPnl'])
  })

  it('expert 模式維持現有全部 12 欄、原本的順序不變', () => {
    expect(openPositionColumnsForMode('expert')).toEqual([
      'asset', 'esg', 'side', 'entry', 'oracle', 'liveMarket',
      'margin', 'leverage', 'copiedFrom', 'unrealizedPnl', 'accruedFunding', 'value',
    ])
  })

  it('simple 是 expert 的子集,不會冒出一個 expert 沒有的欄位', () => {
    const expert = new Set(openPositionColumnsForMode('expert'))
    for (const key of openPositionColumnsForMode('simple')) {
      expect(expert.has(key)).toBe(true)
    }
  })
})

describe('COLUMN_LABELS', () => {
  it('每一欄都有標籤,跟 expert 的欄位一一對應', () => {
    for (const key of openPositionColumnsForMode('expert')) {
      expect(COLUMN_LABELS[key]).toBeTruthy()
    }
  })

  it('ESG 欄位標籤沒有因為 simple 模式而換過用字——用字跨模式不變', () => {
    expect(COLUMN_LABELS.unrealizedPnl).toBe('未實現 PnL')
  })
})
