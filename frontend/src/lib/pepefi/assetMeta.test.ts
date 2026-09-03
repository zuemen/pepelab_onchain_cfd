import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import { t } from 'src/locales'

import { tierOf, type Tier } from './carbon'
import { ASSET_META, ASSETS_LIST } from './assetMeta'

// issue #100 ①：代號卡 → 身世卡。這份測試釘住「ASSET_IDS 裡的每一顆資產都有
// 完整的身世欄位」，並把碳強度數字與 docs/data/carbon-intensity.md 對齊——
// assetClass.test.ts 是逐資產斷言的先例。

const ALL_IDS = Object.values(ASSET_IDS)
const TIERS: Tier[] = ['unrated', 'low', 'mid', 'high']

describe('ASSET_META · 身世（provenance）', () => {
  it.each(ALL_IDS)('%s 有可查證的識別碼與價格來源', (id) => {
    const p = ASSET_META[id]?.provenance
    expect(p, `${ASSET_META[id]?.symbol} 缺 provenance`).toBeDefined()
    expect(p!.referenceId.length).toBeGreaterThan(0)
    expect(['coingecko', 'yahoo']).toContain(p!.priceFeed)
    expect(p!.priceSymbol.length).toBeGreaterThan(0)
  })

  it('加密資產走 CoinGecko，其餘走 Yahoo chart——對齊 agent/keeper/feeds.ts 的 SOURCES', () => {
    for (const id of ALL_IDS) {
      const m = ASSET_META[id]
      const expected = m.category === 'crypto' ? 'coingecko' : 'yahoo'
      expect(m.provenance!.priceFeed, m.symbol).toBe(expected)
    }
  })
})

describe('ASSET_META · 碳強度（carbon）', () => {
  it.each(ALL_IDS)('%s 有碳分級、出處網址與見證日', (id) => {
    const c = ASSET_META[id]?.carbon
    expect(c, `${ASSET_META[id]?.symbol} 缺 carbon`).toBeDefined()
    expect(TIERS).toContain(c!.tier)
    expect(['revenue', 'absolute', 'qualitative']).toContain(c!.basis)
    expect(c!.sourceUrl).toMatch(/^https:\/\//)
    expect(c!.observed).toMatch(/^(\d{4}-\d{2}-\d{2}|—)$/)
  })

  it('每一顆資產在 catalog 都有標的說明、出處名稱與一句已知限制——carbon-intensity.md 要求限制與數字一起顯示', () => {
    for (const id of ALL_IDS) {
      const sym = ASSET_META[id].symbol as keyof typeof t.tokens.provenance.assets
      const s = t.tokens.provenance.assets[sym]
      expect(s, sym).toBeDefined()
      expect(s.underlying.length, sym).toBeGreaterThan(0)
      expect(s.carbonSource.length, sym).toBeGreaterThan(0)
      expect(s.carbonCaveat.length, sym).toBeGreaterThan(0)
    }
  })

  it('營收基準的資產：tier 必須等於 tierOf(intensity)——兩邊不能各說各話', () => {
    for (const id of ALL_IDS) {
      const c = ASSET_META[id].carbon!
      if (c.basis !== 'revenue') continue
      expect(typeof c.intensity, ASSET_META[id].symbol).toBe('number')
      expect(tierOf(c.intensity as number, true), ASSET_META[id].symbol).toBe(c.tier)
    }
  })

  it('非營收基準（絕對排放量 / 質性判定）的資產：intensity 為 null，不硬塞一個誤導的數字', () => {
    for (const id of ALL_IDS) {
      const c = ASSET_META[id].carbon!
      if (c.basis === 'revenue') continue
      expect(c.intensity, ASSET_META[id].symbol).toBeNull()
    }
  })

  // 直接把 docs/data/carbon-intensity.md 的「Proposed carbon tiers」釘進斷言。
  it('五檔個股與 sESGU 的數字與分級對齊碳資料表', () => {
    const expect_ = (sym: keyof typeof ASSET_IDS, intensity: number, tier: Tier) => {
      const c = ASSET_META[ASSET_IDS[sym]].carbon!
      expect(c.intensity, sym).toBeCloseTo(intensity, 3)
      expect(c.tier, sym).toBe(tier)
    }
    expect_('sAAPL', 0.150, 'low')
    expect_('sNVDA', 0.099, 'low')
    expect_('sGOOGL', 8.949, 'high')
    expect_('sTSLA', 10.021, 'high')
    expect_('sMSFT', 10.226, 'high')
    expect_('sESGU', 4.34, 'mid')
  })

  it('crypto 的絕對排放量分級：BTC 高、ETH 低（工作量證明 vs 權益證明）', () => {
    expect(ASSET_META[ASSET_IDS.sBTC].carbon!.tier).toBe('high')
    expect(ASSET_META[ASSET_IDS.sETH].carbon!.tier).toBe('low')
  })

  it('sBOND 尚無可稽核來源 → 見證日為破折號、落到未評等最保守級', () => {
    const c = ASSET_META[ASSET_IDS.sBOND].carbon!
    expect(c.observed).toBe('—')
    expect(c.tier).toBe('unrated')
    expect(c.basis).toBe('qualitative')
  })
})

describe('ASSET_META · KYC 閘門', () => {
  it('受監管類別（股 / ETF / 債）需要 KYC，加密與黃金不需要', () => {
    for (const id of ALL_IDS) {
      const m = ASSET_META[id]
      const shouldGate = m.category === 'equity' || m.category === 'etf' || m.category === 'bond'
      expect(m.regulated, m.symbol).toBe(shouldGate)
    }
  })
})

describe('ASSETS_LIST（既有 API 不受影響）', () => {
  it('仍然只涵蓋 ASSET_IDS 的可交易市場，且每筆都帶上 provenance / carbon', () => {
    expect(ASSETS_LIST).toHaveLength(ALL_IDS.length)
    for (const a of ASSETS_LIST) {
      expect(a.provenance).toBeDefined()
      expect(a.carbon).toBeDefined()
      expect(a.requiresKYC).toBe(a.regulated)
    }
  })
})
