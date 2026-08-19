import { describe, it, expect } from 'vitest'

import { PEPE_LABEL, withStable, STABLE_LABEL, ALT_STABLE_LABEL, X402_STABLE_LABEL } from './tokenLabel'

describe('token labels', () => {
  it('平台保證金畫面顯示為 USDC（鏈上 symbol 仍是 mUSDC，這是刻意的顯示層決定）', () => {
    expect(STABLE_LABEL).toBe('USDC')
  })

  it('x402 結算幣永遠帶發行方名字,不能被 STABLE_LABEL 取代', () => {
    // x402 走 Circle 官方 USDC（EIP-3009），那是真錢。平台保證金畫面上也叫
    // 「USDC」，兩者唯一分得開的就是「Circle」這個字——少了它，使用者會以為
    // 402 challenge 也可以用水龍頭領的幣付。見 ADR-0002 規則 1。
    expect(X402_STABLE_LABEL).toBe('Circle USDC')
    expect(X402_STABLE_LABEL).toContain('Circle')
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
