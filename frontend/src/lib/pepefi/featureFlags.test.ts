import { describe, it, expect } from 'vitest'

import {
  __test__,
  FEATURES,
  isPathEnabled,
  mockWalletEnabled,
  FIXED_LEVERAGE,
  SHOW_LEVERAGE,
  FEATURE_GAMEFI,
  SHOW_PERPETUALS,
  FEATURE_COPY_TRADING,
  FEATURE_PEPE_REWARDS,
} from './featureFlags'

describe('mockWalletEnabled', () => {
  it('開發環境一律開', () => {
    expect(mockWalletEnabled(true, undefined)).toBe(true)
  })
  it('正式 build 預設關，只有明確設旗標才開', () => {
    expect(mockWalletEnabled(false, undefined)).toBe(false)
    expect(mockWalletEnabled(false, '')).toBe(false)
    expect(mockWalletEnabled(false, 'yes')).toBe(false)
    expect(mockWalletEnabled(false, '1')).toBe(true)
  })
})

const ALL_OFF = { gamefi: false, pepeRewards: false, copyTrading: false }
const ALL_ON = { gamefi: true, pepeRewards: true, copyTrading: true }

describe('商業版功能旗標', () => {
  it('平台預設：GameFi 開（2026-10-12 恢復）、跟單開（#331）；PEPE 獎勵仍預設關', () => {
    expect(FEATURE_GAMEFI).toBe(true)
    expect(FEATURE_PEPE_REWARDS).toBe(false)
    expect(FEATURE_COPY_TRADING).toBe(true)
    expect(FEATURES).toEqual({ ...ALL_OFF, gamefi: true, copyTrading: true })
  })

  it('旗標關閉時對應路由不可用（含子路徑與 query）', () => {
    expect(isPathEnabled('/pepe', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/pepe?tab=skins', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/rewards', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/copy/0xabc', ALL_OFF)).toBe(false)
    // 交易員信譽質押是配置市集發布策略的前提（ADR-007），不屬於跟單——旗標全關也要到得了。
    expect(isPathEnabled('/stake', ALL_OFF)).toBe(true)
  })

  it('旗標打開時路由恢復', () => {
    expect(isPathEnabled('/pepe', ALL_ON)).toBe(true)
    expect(isPathEnabled('/rewards', ALL_ON)).toBe(true)
    expect(isPathEnabled('/copy/0xabc', ALL_ON)).toBe(true)
  })

  it('每個旗標只管自己的路徑', () => {
    const onlyGame = { ...ALL_OFF, gamefi: true }
    expect(isPathEnabled('/pepe', onlyGame)).toBe(true)
    expect(isPathEnabled('/rewards', onlyGame)).toBe(false)
    expect(isPathEnabled('/copy/0x1', onlyGame)).toBe(false)
  })

  it('商業版頁面不受影響；比對到路徑段為止', () => {
    for (const p of ['/', '/portfolio', '/tokens', '/marketplace', '/trader', '/trader/0x1', '/sessions', '/pepelab', '/copyright']) {
      expect(isPathEnabled(p, ALL_OFF), p).toBe(true)
    }
  })
})

const { readFlag } = __test__

describe('readFlag', () => {
  it('未設定時用預設值', () => {
    expect(readFlag(undefined, false)).toBe(false)
    expect(readFlag(undefined, true)).toBe(true)
    expect(readFlag('', false)).toBe(false)
  })

  it('1 / true / on 算開，不分大小寫與前後空白', () => {
    expect(readFlag('1', false)).toBe(true)
    expect(readFlag('true', false)).toBe(true)
    expect(readFlag(' TRUE ', false)).toBe(true)
    expect(readFlag('on', false)).toBe(true)
  })

  it('其餘字串一律算關——包含看起來像開的 yes/enabled', () => {
    expect(readFlag('0', true)).toBe(false)
    expect(readFlag('false', true)).toBe(false)
    expect(readFlag('yes', true)).toBe(false)
    expect(readFlag('enabled', true)).toBe(false)
  })
})

describe('FIXED_LEVERAGE', () => {
  it('旗標關閉時的槓桿必須是 1×（現貨等價）', () => {
    expect(FIXED_LEVERAGE).toBe(1)
  })
})

describe('預設值', () => {
  it('default 租戶的槓桿與永續入口預設是開的（#344）', () => {
    // 這兩個預設值是產品定位，不是實作細節。2026-10-16 的決定（#344）：評審上公開站看模擬交易者、
    // 跟單槓桿交易者，永續與槓桿要看得到。以前預設關（一進站就看到 5× 像炒幣平台）；要再改回去
    // 必須是一個有意識的決定。
    expect(SHOW_LEVERAGE).toBe(true)
    expect(SHOW_PERPETUALS).toBe(true)
  })
})
