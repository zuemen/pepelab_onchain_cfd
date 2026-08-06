import { describe, it, expect } from 'vitest'

import { estimateLiquidationPrice, DEFAULT_MAINTENANCE_BPS, DEFAULT_TRADING_FEE_BPS } from './liquidation'

const E18 = 10n ** 18n
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n // 18-dec

describe('estimateLiquidationPrice', () => {
  const entry = 50_000n * E18 // $50,000

  it('多單的清算價在進場價之下,空單在之上', () => {
    const long = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n })
    const short = estimateLiquidationPrice({ entryPrice: entry, isLong: false, leverage: 5n })
    expect(long).toBeLessThan(entry)
    expect(short).toBeGreaterThan(entry)
  })

  it('5× 多單：−20% 再加回 5.1% 的維持保證金 + 平倉費 buffer', () => {
    // 10000 − 2000 + 510 = 8510 bps → $42,550
    const liq = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n })
    expect(liq).toBe((entry * 8510n) / 10000n)
    expect(Number(liq) / 1e18).toBeCloseTo(42_550, 0)
  })

  it('5× 空單：+20% 再扣掉同一個 buffer', () => {
    // 10000 + 2000 − 510 = 11490 bps → $57,450
    const liq = estimateLiquidationPrice({ entryPrice: entry, isLong: false, leverage: 5n })
    expect(liq).toBe((entry * 11490n) / 10000n)
  })

  it('buffer 就是合約的 maintenance + trading fee', () => {
    expect(DEFAULT_MAINTENANCE_BPS + DEFAULT_TRADING_FEE_BPS).toBe(510n)
  })

  it('含 buffer 的估算比「entry ± entry/leverage」更保守', () => {
    // 終端機舊版少算 buffer，算出來的多單清算價更低——會讓人以為還有空間。
    const naive = entry - entry / 2n
    const real = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 2n })
    expect(real).toBeGreaterThan(naive)
  })

  it('槓桿越高清算價越靠近進場價', () => {
    const l1 = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 1n })
    const l2 = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 2n })
    const l5 = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n })
    expect(l1).toBeLessThan(l2)
    expect(l2).toBeLessThan(l5)
  })

  it('entryPrice 為 0 回 0,而不是印出一個看起來很權威的 $0.00 估算', () => {
    expect(estimateLiquidationPrice({ entryPrice: 0n, isLong: true, leverage: 5n })).toBe(0n)
  })

  it('槓桿為 0 不會除以零', () => {
    expect(estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 0n })).toBe(0n)
  })

  it('接受 number 型別的槓桿（UI 的 state 是 number）', () => {
    expect(estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5 })).toBe(
      estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n }),
    )
  })

  it('可以覆寫 per-asset 的維持保證金', () => {
    const tight = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n, maintenanceBps: 1000n })
    const std = estimateLiquidationPrice({ entryPrice: entry, isLong: true, leverage: 5n })
    // 維持保證金越高 → 多單越早被清算 → 清算價越高
    expect(tight).toBeGreaterThan(std)
  })

  it('小額標的也不會因為整數除法歸零', () => {
    const cheap = usd(14) // sICLN ≈ $14
    const liq = estimateLiquidationPrice({ entryPrice: cheap, isLong: true, leverage: 2n })
    expect(liq).toBeGreaterThan(0n)
    // 2× 多單：1 − 1/2 + 0.051 = 0.551 → $7.714
    expect(Number(liq) / 1e18).toBeCloseTo(14 * 0.551, 3)
  })
})
