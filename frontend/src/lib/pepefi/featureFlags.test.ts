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
  it('GameFi、PEPE 獎勵、跟單預設都是關的——商業版不出現零售／遊戲化功能', () => {
    expect(FEATURE_GAMEFI).toBe(false)
    expect(FEATURE_PEPE_REWARDS).toBe(false)
    expect(FEATURE_COPY_TRADING).toBe(false)
    expect(FEATURES).toEqual(ALL_OFF)
  })

  it('旗標關閉時對應路由不可用（含子路徑與 query）', () => {
    expect(isPathEnabled('/pepe', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/pepe?tab=skins', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/rewards', ALL_OFF)).toBe(false)
    expect(isPathEnabled('/copy/0xabc', ALL_OFF)).toBe(false)
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
  it('槓桿與永續入口預設都是關的 —— 平台預設呈現的是現貨', () => {
    // 這兩個預設值是產品定位,不是實作細節:一進站就看到 5× 按鈕或永續終端,
    // 會讓人以為這是炒幣平台。要改預設值必須是一個有意識的決定。
    expect(SHOW_LEVERAGE).toBe(false)
    expect(SHOW_PERPETUALS).toBe(false)
  })
})
