import { describe, it, expect } from 'vitest'

import {
  isOracleStale,
  priceImpactBps,
  minOutWithSlippage,
  DEFAULT_SLIPPAGE_BPS,
} from './ammQuote'

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n

// 模擬合約的恆定乘積報價（含 0.3% 手續費），用來產生真實的 quote 值。
function cpQuote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const inWithFee = amountIn * 997n
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee)
}

describe('priceImpactBps', () => {
  const reserveEth = E(100)
  const reserveUsdc = E(300_000)

  it('金額越大，價格衝擊越大（恆定乘積的核心性質）', () => {
    const small = priceImpactBps({
      amountIn: E(1),
      amountOut: cpQuote(E(1), reserveEth, reserveUsdc),
      reserveIn: reserveEth,
      reserveOut: reserveUsdc,
    })
    const big = priceImpactBps({
      amountIn: E(20),
      amountOut: cpQuote(E(20), reserveEth, reserveUsdc),
      reserveIn: reserveEth,
      reserveOut: reserveUsdc,
    })
    expect(small).not.toBeNull()
    expect(big).not.toBeNull()
    expect(big!).toBeGreaterThan(small!)
  })

  it('極小額的衝擊趨近於手續費（約 30 bps），不會是 0', () => {
    const impact = priceImpactBps({
      amountIn: E(1) / 1000n,
      amountOut: cpQuote(E(1) / 1000n, reserveEth, reserveUsdc),
      reserveIn: reserveEth,
      reserveOut: reserveUsdc,
    })
    expect(impact).toBeGreaterThanOrEqual(29)
    expect(impact).toBeLessThanOrEqual(35)
  })

  it('大額換匯的滑點遠超過 UI 的 0.5% buffer —— 正是舊版 minOut 會 revert 的原因', () => {
    const amountIn = E(20) // 池子 20% 的深度
    const impact = priceImpactBps({
      amountIn,
      amountOut: cpQuote(amountIn, reserveEth, reserveUsdc),
      reserveIn: reserveEth,
      reserveOut: reserveUsdc,
    })
    expect(impact!).toBeGreaterThan(DEFAULT_SLIPPAGE_BPS)
    expect(impact!).toBeGreaterThan(1000) // > 10%
  })

  it('缺儲備／缺報價時回 null，而不是假裝 0', () => {
    expect(priceImpactBps({ amountIn: 0n, amountOut: E(1), reserveIn: E(1), reserveOut: E(1) })).toBeNull()
    expect(priceImpactBps({ amountIn: E(1), amountOut: 0n, reserveIn: E(1), reserveOut: E(1) })).toBeNull()
    expect(priceImpactBps({ amountIn: E(1), amountOut: E(1), reserveIn: 0n, reserveOut: E(1) })).toBeNull()
    expect(priceImpactBps({ amountIn: E(1), amountOut: E(1), reserveIn: E(1), reserveOut: 0n })).toBeNull()
  })

  it('報價優於中價時夾到 0，不顯示負滑點', () => {
    expect(priceImpactBps({
      amountIn: E(1), amountOut: E(4), reserveIn: E(1), reserveOut: E(3),
    })).toBe(0)
  })
})

describe('minOutWithSlippage', () => {
  it('以 quote 為基準扣掉容忍度', () => {
    expect(minOutWithSlippage(E(1000), 50)).toBe(E(995))
  })

  it('預設是 0.5%', () => {
    expect(minOutWithSlippage(E(1000))).toBe(minOutWithSlippage(E(1000), DEFAULT_SLIPPAGE_BPS))
  })

  it('minOut 永遠不大於 quote —— 否則合約必定 revert InsufficientOutput', () => {
    const quoted = cpQuote(E(5), E(100), E(300_000))
    expect(minOutWithSlippage(quoted)).toBeLessThan(quoted)
  })

  it('0 報價回 0，不會產生負數', () => {
    expect(minOutWithSlippage(0n)).toBe(0n)
  })

  it('容忍度被夾在 0–10000 bps', () => {
    expect(minOutWithSlippage(E(100), -5)).toBe(E(100))
    expect(minOutWithSlippage(E(100), 999_999)).toBe(0n)
  })
})

describe('isOracleStale', () => {
  const now = 1_800_000_000
  const HOUR = 3600n

  it('超過 maxOracleAge 就是過期（合約會 revert StaleOraclePrice）', () => {
    expect(isOracleStale(BigInt(now - 7200), HOUR, now)).toBe(true)
  })

  it('在期限內不算過期', () => {
    expect(isOracleStale(BigInt(now - 60), HOUR, now)).toBe(false)
  })

  it('剛好等於 maxOracleAge 不算過期（合約用的是 >）', () => {
    expect(isOracleStale(BigInt(now - 3600), HOUR, now)).toBe(false)
  })

  it('maxAge / updatedAt 還沒讀到時不擋 —— RPC 抖動不該把兌換卡片鎖死', () => {
    expect(isOracleStale(BigInt(now - 999_999), 0n, now)).toBe(false)
    expect(isOracleStale(0n, HOUR, now)).toBe(false)
  })
})
