import { it, expect, describe } from 'vitest'

import { FALLBACK_EXECUTION_FEE_WEI } from './useExecutionFee'

describe('useExecutionFee fallback', () => {
  it('後備值等於線上 exchange 的 executionFee()：0.0001 ETH（1e14 wei）', () => {
    expect(FALLBACK_EXECUTION_FEE_WEI).toBe(100_000_000_000_000n)
  })
})
