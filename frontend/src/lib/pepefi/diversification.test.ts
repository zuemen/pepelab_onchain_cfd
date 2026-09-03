import { describe, it, expect } from 'vitest'

import { diversification, diversificationByValue } from './diversification'

describe('diversification', () => {
  it('沒有任何正權重:全為 0,不會除以零變 NaN', () => {
    expect(diversification([])).toEqual({ hhi: 0, effectiveAssets: 0, score: 0 })
    expect(diversification([0, 0])).toEqual({ hhi: 0, effectiveAssets: 0, score: 0 })
  })

  it('單一資產:HHI 1、等效 1 個資產、分數 0', () => {
    const d = diversification([10000])
    expect(d.hhi).toBe(1)
    expect(d.effectiveAssets).toBe(1)
    expect(d.score).toBe(0)
  })

  it('兩個資產均分:HHI 0.5、等效 2、分數 1', () => {
    const d = diversification([5000, 5000])
    expect(d.hhi).toBeCloseTo(0.5, 12)
    expect(d.effectiveAssets).toBeCloseTo(2, 12)
    expect(d.score).toBeCloseTo(1, 12)
  })

  it('Allocation 三資產均分（3334/3333/3333 bps）:分數 ≈ 1', () => {
    const d = diversification([3334, 3333, 3333])
    expect(d.effectiveAssets).toBeCloseTo(3, 3)
    expect(d.score).toBeCloseTo(1, 3)
  })

  it('三資產但集中（5000/3000/2000）:分數低於均分,等效資產數 < 3', () => {
    const d = diversification([5000, 3000, 2000])
    // HHI = 0.25 + 0.09 + 0.04 = 0.38 → 等效 ≈ 2.63
    expect(d.hhi).toBeCloseTo(0.38, 12)
    expect(d.effectiveAssets).toBeCloseTo(1 / 0.38, 10)
    expect(d.score).toBeLessThan(1)
    expect(d.score).toBeGreaterThan(0)
  })

  it('刻度無關:bps 與百分比算出同一個結果', () => {
    expect(diversification([2500, 2500, 2500, 2500])).toEqual(diversification([25, 25, 25, 25]))
  })

  it('零權重的項目被略過,不灌水等效資產數', () => {
    expect(diversification([5000, 5000, 0, 0])).toEqual(diversification([5000, 5000]))
  })

  it('一個資產近乎全押:分數趨近 0', () => {
    const d = diversification([9900, 50, 50])
    expect(d.score).toBeLessThan(0.1)
  })
})

describe('diversificationByValue', () => {
  const one = (n: bigint) => n * 10n ** 18n

  it('空持倉:全為 0', () => {
    expect(diversificationByValue([])).toEqual({ hhi: 0, effectiveAssets: 0, score: 0 })
  })

  it('與 number 版一致:均分三筆市值 → 分數 ≈ 1', () => {
    const d = diversificationByValue([one(1000n), one(1000n), one(1000n)])
    expect(d.effectiveAssets).toBeCloseTo(3, 3)
    expect(d.score).toBeCloseTo(1, 3)
  })

  it('超過 2^53 的市值仍然不掉精度到影響結果', () => {
    const huge = one(80_000_000n)
    const d = diversificationByValue([huge, huge])
    expect(d.score).toBeCloseTo(1, 6)
  })

  it('負值被當成「沒有這個部位」略過', () => {
    const d = diversificationByValue([one(100n), -5n, one(100n)])
    expect(d.effectiveAssets).toBeCloseTo(2, 6)
  })
})
