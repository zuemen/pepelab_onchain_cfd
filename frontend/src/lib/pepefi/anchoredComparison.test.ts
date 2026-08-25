import { describe, it, expect } from 'vitest'

import {
  earliestOpenedAt,
  toDateStr,
  notionalReturnPct,
  daysSince,
  beatCountOf,
  divergingBarOf,
  comparisonScaleOf,
} from './anchoredComparison'

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

describe('daysSince', () => {
  it('整天數無條件捨去', () => {
    const anchor = 1000n
    expect(daysSince(anchor, 1000 + 86400 * 3 + 3600)).toBe(3)
  })

  it('不足一天 → 0,不是負數也不是四捨五入成 1', () => {
    expect(daysSince(1000n, 1000 + 3600)).toBe(0)
  })

  it('時鐘偏差導致 now 早於錨定日 → 夾到 0,不出現負天數', () => {
    expect(daysSince(1000n, 500)).toBe(0)
  })
})

describe('beatCountOf', () => {
  it('贏過的個數算對', () => {
    expect(beatCountOf(24.21, [23.1, -1.35, 7.86, -0.24])).toEqual({ beat: 4, total: 4 })
  })

  it('輸給其中一個就不算進 beat', () => {
    expect(beatCountOf(10, [23.1, -1.35, 7.86])).toEqual({ beat: 2, total: 3 })
  })

  // 抓不到的指數不能算進分母——那等於宣稱一場沒有發生的比較。
  it('抓不到的指數不進分母', () => {
    expect(beatCountOf(10, [23.1, null, 7.86, null])).toEqual({ beat: 1, total: 2 })
  })

  it('使用者報酬率算不出來 → beat 0,分母仍只算已知的指數', () => {
    expect(beatCountOf(null, [1, 2, null])).toEqual({ beat: 0, total: 2 })
  })

  it('打平不算贏（嚴格大於）', () => {
    expect(beatCountOf(5, [5])).toEqual({ beat: 0, total: 1 })
  })
})

describe('comparisonScaleOf', () => {
  it('刻度一定包含 0,負報酬才長得出左邊那一段', () => {
    const [lo, hi] = comparisonScaleOf([10, 20, 30])
    expect(lo).toBeLessThanOrEqual(0)
    expect(hi).toBeGreaterThan(30)
  })

  it('全為負值時上界仍含 0', () => {
    const [lo, hi] = comparisonScaleOf([-5, -10])
    expect(hi).toBeGreaterThanOrEqual(0)
    expect(lo).toBeLessThan(-10)
  })

  it('全部都是 0 → 回一個安全區間,不是零寬度', () => {
    expect(comparisonScaleOf([0, 0])).toEqual([0, 1])
  })
})

describe('divergingBarOf', () => {
  it('正值從零線往右長', () => {
    const { leftPct, widthPct } = divergingBarOf(50, -100, 100)
    expect(leftPct).toBeCloseTo(50) // 零線在正中央
    expect(widthPct).toBeCloseTo(25)
  })

  it('負值從數值端長到零線,不是負寬度', () => {
    const { leftPct, widthPct } = divergingBarOf(-50, -100, 100)
    expect(leftPct).toBeCloseTo(25)
    expect(widthPct).toBeCloseTo(25)
    expect(widthPct).toBeGreaterThan(0)
  })

  it('0 → 寬度 0,停在零線上', () => {
    const { widthPct } = divergingBarOf(0, -100, 100)
    expect(widthPct).toBeCloseTo(0)
  })

  // 零寬度刻度會讓 (v - lo) / 0 變成 NaN 或 Infinity,長條寬度就壞了。
  it('刻度零寬度 → 寬度 0,不是 NaN', () => {
    const { leftPct, widthPct } = divergingBarOf(5, 3, 3)
    expect(Number.isFinite(leftPct)).toBe(true)
    expect(widthPct).toBe(0)
  })
})
