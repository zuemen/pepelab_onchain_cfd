import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import {
  assetClassOf,
  ASSET_CLASSES,
  ASSET_CLASS_CONFIG,
  groupMarginByAssetClass,
  groupByAssetClass,
  holdingValue,
} from './assetClass'

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
    expect(out.crypto).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
    expect(out.equity).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
    expect(out.commodity).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
    expect(out.bond).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
  })

  it('同一類的多筆部位會加總', () => {
    const out = groupMarginByAssetClass([
      { asset: ASSET_IDS.sAAPL, margin: 100n, unrealizedPnL: 10n },
      { asset: ASSET_IDS.sTSLA, margin: 200n, unrealizedPnL: -5n },
    ])
    expect(out.equity).toEqual({ margin: 300n, holdings: 0n, pnl: 5n, value: 300n })
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
    expect(out.crypto).toEqual({ margin: 100n, holdings: 0n, pnl: 1n, value: 100n })
    expect(out.commodity).toEqual({ margin: 50n, holdings: 0n, pnl: -1n, value: 50n })
    expect(out.bond).toEqual({ margin: 25n, holdings: 0n, pnl: 0n, value: 25n })
    expect(out.equity).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
  })
})

describe('holdingValue', () => {
  const one = (n: bigint) => n * 10n ** 18n

  it('1 顆 $100 的代幣 = $100(18-dec)', () => {
    // price 是 8-dec:$100 → 100e8
    expect(holdingValue({ asset: ASSET_IDS.sGOLD, balance: one(1n), price: 100n * 10n ** 8n }))
      .toBe(one(100n))
  })

  it('零餘額或零價格都是 0,不會變成 NaN 或負數', () => {
    expect(holdingValue({ asset: ASSET_IDS.sBTC, balance: 0n, price: 100n * 10n ** 8n })).toBe(0n)
    expect(holdingValue({ asset: ASSET_IDS.sBTC, balance: one(5n), price: 0n })).toBe(0n)
  })

  it('大到超過 2^53 仍然精確 —— 這個值會拿去算佔比,掉精度會讓百分比對不起來', () => {
    // 1,000 顆 × $80,000 = $80,000,000
    const v = holdingValue({ asset: ASSET_IDS.sBTC, balance: one(1_000n), price: 80_000n * 10n ** 8n })
    expect(v).toBe(one(80_000_000n))
    // Number 化會掉精度,所以刻意不用 Number 比較
    expect(v > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})

describe('groupByAssetClass · 帶持倉', () => {
  const one = (n: bigint) => n * 10n ** 18n
  const px = (n: bigint) => n * 10n ** 8n

  it('沒有任何部位、只有代幣持倉時,配置圖仍然有數字', () => {
    // 這正是平台改成現貨門面之後的一般使用者:買了 sGOLD 與 sBOND,一張永續都沒開。
    const out = groupByAssetClass([], [
      { asset: ASSET_IDS.sGOLD, balance: one(2n), price: px(2_000n) },
      { asset: ASSET_IDS.sBOND, balance: one(10n), price: px(80n) },
    ])
    expect(out.commodity.holdings).toBe(one(4_000n))
    expect(out.bond.holdings).toBe(one(800n))
    expect(out.commodity.value).toBe(one(4_000n))
    expect(out.crypto.value).toBe(0n)
  })

  it('保證金與持倉相加進 value,但各自也留著', () => {
    const out = groupByAssetClass(
      [{ asset: ASSET_IDS.sBTC, margin: one(100n), unrealizedPnL: one(5n) }],
      [{ asset: ASSET_IDS.sBTC, balance: one(1n), price: px(50n) }],
    )
    expect(out.crypto.margin).toBe(one(100n))
    expect(out.crypto.holdings).toBe(one(50n))
    expect(out.crypto.value).toBe(one(150n))
    expect(out.crypto.pnl).toBe(one(5n))
  })

  it('持倉不產生損益 —— 現貨沒有鏈上成本基礎可算', () => {
    const out = groupByAssetClass([], [{ asset: ASSET_IDS.sAAPL, balance: one(3n), price: px(200n) }])
    expect(out.equity.holdings).toBe(one(600n))
    expect(out.equity.pnl).toBe(0n)
  })

  it('四類永遠都在,兩邊都空也一樣', () => {
    const out = groupByAssetClass([], [])
    expect(Object.keys(out).sort()).toEqual(['bond', 'commodity', 'crypto', 'equity'])
    for (const cls of ASSET_CLASSES) {
      expect(out[cls]).toEqual({ margin: 0n, holdings: 0n, pnl: 0n, value: 0n })
    }
  })

  it('ETF 的持倉跟著 assetClassOf 歸股,不是商品', () => {
    const out = groupByAssetClass([], [{ asset: ASSET_IDS.sICLN, balance: one(1n), price: px(30n) }])
    expect(out.equity.holdings).toBe(one(30n))
    expect(out.commodity.holdings).toBe(0n)
  })
})
