import { it, expect, describe } from 'vitest'

import { resolveTradingParams } from './tradingParams'

const fallback = { maxLeverage: 1, tradingFeeBps: 100 }

describe('resolveTradingParams', () => {
  it('鏈上兩個值都讀到 → 用鏈上，來源 chain', () => {
    expect(resolveTradingParams({ maxLeverage: 5n, tradingFeeBps: 10n }, fallback)).toEqual({
      maxLeverage: 5,
      tradingFeeBps: 10,
      source: 'chain',
    })
  })

  it('完全讀不到 → 靜態表，來源 static', () => {
    expect(resolveTradingParams(null, fallback)).toEqual({ ...fallback, source: 'static' })
  })

  it('只讀到一半也退回靜態表——不混用來源', () => {
    expect(resolveTradingParams({ maxLeverage: 5n, tradingFeeBps: null }, fallback).source).toBe('static')
    expect(resolveTradingParams({ maxLeverage: null, tradingFeeBps: 10n }, fallback).source).toBe('static')
  })

  it('還沒讀回來（settled=false）→ pending，上限鎖 1×，不先露出靜態表的上限', () => {
    const r = resolveTradingParams(null, { maxLeverage: 5, tradingFeeBps: 10 }, false)
    expect(r).toEqual({ maxLeverage: 1, tradingFeeBps: 10, source: 'pending' })
  })

  it('讀完但失敗（settled=true、chain=null）才退回靜態表', () => {
    expect(resolveTradingParams(null, { maxLeverage: 5, tradingFeeBps: 10 }, true).source).toBe('static')
  })

  it('鏈上回 0 倍槓桿視為異常，退回靜態表', () => {
    expect(resolveTradingParams({ maxLeverage: 0n, tradingFeeBps: 10n }, fallback).source).toBe('static')
  })
})

describe('staticTradingParams', () => {
  it('沒有碳資料 → 預設 5× 與 low 費率（未評等標籤）', async () => {
    const { staticTradingParams } = await import('./tradingParams')
    expect(staticTradingParams(undefined, Date.now())).toMatchObject({ tier: 'unrated', maxLeverage: 5 })
  })
})
