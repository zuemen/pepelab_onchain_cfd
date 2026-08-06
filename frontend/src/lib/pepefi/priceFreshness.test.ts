import { describe, it, expect } from 'vitest'

import { classifyFreshness } from './priceFreshness'

describe('classifyFreshness', () => {
  const maxPriceAgeSec = 21600 // Base Sepolia 交易所實際值：6 小時
  // 真實的時間戳。不要用 0 當基準 —— 鏈上的 updatedAt 為 0 代表「從未寫入」，
  // 分級必須回 unknown 而不是拿它當紀元起點算年齡。
  const BASE = 1785000000

  it('沒有 updatedAt 時回 unknown,而不是假裝是 live', () => {
    const r = classifyFreshness({ updatedAtSec: undefined, nowSec: BASE, maxPriceAgeSec })
    expect(r.level).toBe('unknown')
    expect(r.ageSec).toBeNull()
  })

  it('updatedAt 為 0 代表鏈上從未寫入,同樣是 unknown', () => {
    const r = classifyFreshness({ updatedAtSec: 0, nowSec: BASE, maxPriceAgeSec })
    expect(r.level).toBe('unknown')
    expect(r.ageSec).toBeNull()
  })

  it('剛更新的價格是 live', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 60, maxPriceAgeSec })
    expect(r.level).toBe('live')
    expect(r.ageSec).toBe(60)
  })

  it('超過一半 maxPriceAge 進入 aging', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 12000, maxPriceAgeSec })
    expect(r.level).toBe('aging')
  })

  it('超過 maxPriceAge 就是 stale —— 這時合約會 revert StalePrice', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 21601, maxPriceAgeSec })
    expect(r.level).toBe('stale')
  })

  it('2026-08-06 的線上情況：9.5 天前的 sBTC 必須是 stale', () => {
    const r = classifyFreshness({ updatedAtSec: 1785162620, nowSec: 1785982648, maxPriceAgeSec })
    expect(r.level).toBe('stale')
    expect(r.label).toContain('9.5')
  })

  it('未來時間戳不會產生負數年齡', () => {
    const r = classifyFreshness({ updatedAtSec: BASE + 1000, nowSec: BASE, maxPriceAgeSec })
    expect(r.ageSec).toBe(0)
    expect(r.level).toBe('live')
  })

  it('label 對不同量級用不同單位', () => {
    const at = (offset: number) =>
      classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + offset, maxPriceAgeSec }).label
    expect(at(60)).toBe('60 秒前')
    expect(at(600)).toBe('10.0 分鐘前')
    expect(at(7200)).toBe('2.0 小時前')
    expect(at(172800)).toBe('2.0 天前')
  })
})
