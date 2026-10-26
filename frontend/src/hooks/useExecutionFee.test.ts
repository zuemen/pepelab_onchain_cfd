import { it, expect, describe } from 'vitest'

import { formatEth, formatEthExact, FALLBACK_EXECUTION_FEE_WEI } from './useExecutionFee'

describe('useExecutionFee fallback', () => {
  it('後備值等於線上 exchange 的 executionFee()：0.0001 ETH（1e14 wei）', () => {
    expect(FALLBACK_EXECUTION_FEE_WEI).toBe(100_000_000_000_000n)
  })
})

describe('formatEthExact', () => {
  it('keeps every wei that formatEth rounds away', () => {
    expect(formatEthExact(10n ** 14n + 1n)).toBe('0.000100000000000001')
    expect(formatEth(10n ** 14n + 1n)).toBe('0.0001')
    expect(formatEthExact(10n ** 14n)).toBe('0.0001')
    expect(formatEthExact(2n * 10n ** 18n)).toBe('2')
    expect(formatEthExact(0n)).toBe('0')
    expect(formatEthExact(1n)).toBe('0.000000000000000001')
  })
})
