import { describe, it, expect } from 'vitest'

import { PEPE_LABEL, withStable, STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL } from './tokenLabel'

describe('token labels', () => {
  it('平台保證金畫面顯示為 USDC（鏈上 symbol 仍是 mUSDC，這是刻意的顯示層決定）', () => {
    expect(STABLE_LABEL).toBe('USDC')
  })

  it('x402 結算幣永遠是「官方 USDC」,不能被 STABLE_LABEL 取代', () => {
    // x402 走 Circle 官方 USDC（EIP-3009），那是真錢。把它和測試用的平台保證金
    // 講成同一個東西，使用者會以為 402 challenge 也可以用水龍頭領的幣付。
    expect(X402_STABLE_LABEL).toBe('官方 USDC')
    expect(X402_STABLE_LABEL).not.toBe(STABLE_LABEL)
  })

  it('三顆幣的標籤兩兩不同', () => {
    const labels = [STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL]
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('平台幣是 PEPE', () => {
    expect(PEPE_LABEL).toBe('PEPE')
  })

  it('withStable 產生「數字 + 空白 + 標籤」', () => {
    expect(withStable('123.45')).toBe('123.45 USDC')
    expect(withStable(0)).toBe('0 USDC')
  })
})
