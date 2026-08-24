import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import { assetClassOf, ASSET_CLASSES, ASSET_CLASS_CONFIG, groupMarginByAssetClass } from './assetClass'

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

describe('groupMarginByAssetClass', () => {
  it('空陣列時四類都在,皆為 0——RWA 配置區塊零持倉要顯示四類皆 $0,不是整塊消失', () => {
    const out = groupMarginByAssetClass([])
    expect(out.crypto).toEqual({ margin: 0n, pnl: 0n })
    expect(out.equity).toEqual({ margin: 0n, pnl: 0n })
    expect(out.commodity).toEqual({ margin: 0n, pnl: 0n })
    expect(out.bond).toEqual({ margin: 0n, pnl: 0n })
  })

  it('同一類的多筆部位會加總', () => {
    const out = groupMarginByAssetClass([
      { asset: ASSET_IDS.sAAPL, margin: 100n, unrealizedPnL: 10n },
      { asset: ASSET_IDS.sTSLA, margin: 200n, unrealizedPnL: -5n },
    ])
    expect(out.equity).toEqual({ margin: 300n, pnl: 5n })
  })

  it('ETF 部位併入 equity 的加總,不是 commodity', () => {
    const out = groupMarginByAssetClass([
      { asset: ASSET_IDS.sAAPL, margin: 100n, unrealizedPnL: 0n },
      { asset: ASSET_IDS.sICLN, margin: 50n, unrealizedPnL: 0n },
    ])
    expect(out.equity.margin).toBe(150n)
    expect(out.commodity.margin).toBe(0n)
  })

  it('不同類互不污染', () => {
    const out = groupMarginByAssetClass([
      { asset: ASSET_IDS.sBTC, margin: 100n, unrealizedPnL: 1n },
      { asset: ASSET_IDS.sGOLD, margin: 50n, unrealizedPnL: -1n },
      { asset: ASSET_IDS.sBOND, margin: 25n, unrealizedPnL: 0n },
    ])
    expect(out.crypto).toEqual({ margin: 100n, pnl: 1n })
    expect(out.commodity).toEqual({ margin: 50n, pnl: -1n })
    expect(out.bond).toEqual({ margin: 25n, pnl: 0n })
    expect(out.equity).toEqual({ margin: 0n, pnl: 0n })
  })
})
