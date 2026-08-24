import { describe, it, expect } from 'vitest'

import { pctChangeOf, formatBenchmarkValue, yesterdayUtc } from './benchmarks'

describe('pctChangeOf', () => {
  it('漲跌算對:現價高於前收 → 正百分比', () => {
    const pct = pctChangeOf({ value: 110, at: 100 }, { value: 100, at: 0, date: '2026-07-10' })
    expect(pct).toBeCloseTo(10)
  })

  it('現價低於前收 → 負百分比', () => {
    const pct = pctChangeOf({ value: 90, at: 100 }, { value: 100, at: 0, date: '2026-07-10' })
    expect(pct).toBeCloseTo(-10)
  })

  it('current 缺資料 → null,不是 0 或 NaN', () => {
    expect(pctChangeOf(undefined, { value: 100, at: 0, date: '2026-07-10' })).toBeNull()
  })

  it('atDate 缺資料 → null', () => {
    expect(pctChangeOf({ value: 100, at: 0 }, undefined)).toBeNull()
  })

  // 這是最重要的一條:atDate.value === 0 直接除下去會是 Infinity,絕不能算出來
  // 顯示在畫面上當成一個看似真實的百分比。
  it('atDate 是 0 → null,不是 Infinity', () => {
    const pct = pctChangeOf({ value: 100, at: 0 }, { value: 0, at: 0, date: '2026-07-10' })
    expect(pct).toBeNull()
  })
})

describe('formatBenchmarkValue', () => {
  it('spx 不帶錢字元——指數點數,不是 USD', () => {
    expect(formatBenchmarkValue('spx', 7674.37)).toBe('7,674.37')
  })

  it('gold 帶 $', () => {
    expect(formatBenchmarkValue('gold', 4695.8)).toBe('$4,695.80')
  })

  it('btc 帶 $ 且千分位正確', () => {
    expect(formatBenchmarkValue('btc', 77105.95)).toBe('$77,105.95')
  })
})

describe('yesterdayUtc', () => {
  it('永遠早於傳入的 now,不會撞到後端「不可為未來日期」的驗證', () => {
    const now = Date.UTC(2026, 6, 12, 3, 0, 0) // 2026-07-12 03:00 UTC
    expect(yesterdayUtc(now)).toBe('2026-07-11')
  })

  it('跨月邊界算對', () => {
    const now = Date.UTC(2026, 7, 1, 0, 30, 0) // 2026-08-01 00:30 UTC
    expect(yesterdayUtc(now)).toBe('2026-07-31')
  })

  it('跨年邊界算對', () => {
    const now = Date.UTC(2027, 0, 1, 0, 0, 0) // 2027-01-01 00:00 UTC
    expect(yesterdayUtc(now)).toBe('2026-12-31')
  })
})
