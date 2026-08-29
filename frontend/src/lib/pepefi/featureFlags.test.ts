import { describe, it, expect } from 'vitest'

import { __test__, FIXED_LEVERAGE, SHOW_LEVERAGE, SHOW_PERPETUALS } from './featureFlags'

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
