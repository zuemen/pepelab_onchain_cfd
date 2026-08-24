import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import { assetClassOf, ASSET_CLASSES, ASSET_CLASS_CONFIG } from './assetClass'

describe('assetClassOf', () => {
  it('crypto 資產歸 crypto', () => {
    expect(assetClassOf(ASSET_IDS.sBTC)).toBe('crypto')
    expect(assetClassOf(ASSET_IDS.sETH)).toBe('crypto')
  })

  it('equity 資產歸 equity', () => {
    expect(assetClassOf(ASSET_IDS.sAAPL)).toBe('equity')
    expect(assetClassOf(ASSET_IDS.sTSLA)).toBe('equity')
  })

  it('bond 資產歸 bond', () => {
    expect(assetClassOf(ASSET_IDS.sBOND)).toBe('bond')
  })

  it('commodity（黃金）歸 commodity', () => {
    expect(assetClassOf(ASSET_IDS.sGOLD)).toBe('commodity')
  })

  // 這是這張票的核心行為變更：ETF 從「金」改歸「股」。
  it('ETF 併入 equity,不是 commodity', () => {
    expect(assetClassOf(ASSET_IDS.sICLN)).toBe('equity')
    expect(assetClassOf(ASSET_IDS.sESGU)).toBe('equity')
  })

  it('查無分類的資產 id 退回 crypto（沿用改版前的行為）', () => {
    expect(assetClassOf('0xdeadbeef')).toBe('crypto')
  })
})

describe('ASSET_CLASSES / ASSET_CLASS_CONFIG', () => {
  it('每個 AssetClass 都有對應的 config', () => {
    for (const cls of ASSET_CLASSES) {
      expect(ASSET_CLASS_CONFIG[cls]).toBeDefined()
      expect(ASSET_CLASS_CONFIG[cls].label.length).toBeGreaterThan(0)
    }
  })

  it('剛好四類,沒有多也沒有少', () => {
    expect(ASSET_CLASSES).toEqual(['crypto', 'equity', 'commodity', 'bond'])
  })
})
