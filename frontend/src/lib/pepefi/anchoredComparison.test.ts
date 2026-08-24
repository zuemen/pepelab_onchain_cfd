import { describe, it, expect } from 'vitest'

import { earliestOpenedAt, toDateStr, notionalReturnPct } from './anchoredComparison'

describe('earliestOpenedAt', () => {
  it('空陣列 → null,不是 0 或現在時間', () => {
    expect(earliestOpenedAt([])).toBeNull()
  })

  it('取最早的開倉時間,不管在陣列裡的順序', () => {
    const rows = [{ openedAt: 300n }, { openedAt: 100n }, { openedAt: 200n }]
    expect(earliestOpenedAt(rows)).toBe(100n)
  })

  it('只有一筆時就是那一筆', () => {
    expect(earliestOpenedAt([{ openedAt: 42n }])).toBe(42n)
  })
})

describe('toDateStr', () => {
  it('unix 秒轉成 UTC 日期字串', () => {
    // 2026-07-12T03:00:00Z
    expect(toDateStr(1783825200n)).toBe('2026-07-12')
  })
})

describe('notionalReturnPct', () => {
  it('沒有部位 → null,不是 0%', () => {
    expect(notionalReturnPct([])).toBeNull()
  })

  it('用名目（margin × leverage）當分母,不是保證金', () => {
    // $100 保證金、5 倍槓桿 → 名目 $500；賺 $25 → 5%,不是以保證金計的 25%。
    const rows = [{ margin: 100n, leverage: 5n, unrealizedPnL: 25n }]
    expect(notionalReturnPct(rows)).toBeCloseTo(5)
  })

  it('這正是規格裡的例子:$100 保證金 5 倍槓桿,標的漲 5% → 名目報酬率 5%,不是 25%', () => {
    // 標的漲 5%、5 倍槓桿 → 保證金翻 25%,即損益 = 100 * 0.25 = 25。
    const rows = [{ margin: 100n, leverage: 5n, unrealizedPnL: 25n }]
    const pct = notionalReturnPct(rows)
    expect(pct).toBeCloseTo(5)
    expect(pct).not.toBeCloseTo(25)
  })

  it('多筆部位依名目加權彙總', () => {
    const rows = [
      { margin: 100n, leverage: 5n, unrealizedPnL: 50n },  // notional 500, pnl 50
      { margin: 100n, leverage: 1n, unrealizedPnL: -10n }, // notional 100, pnl -10
    ]
    // 總 notional 600、總 pnl 40 → 40/600 * 100 ≈ 6.67%
    expect(notionalReturnPct(rows)).toBeCloseTo((40 / 600) * 100)
  })

  it('虧損也算對,回傳負數', () => {
    const rows = [{ margin: 100n, leverage: 2n, unrealizedPnL: -20n }]
    expect(notionalReturnPct(rows)).toBeCloseTo(-10)
  })
})
