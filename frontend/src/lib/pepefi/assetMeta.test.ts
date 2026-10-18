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
  it('五檔個股與兩檔股票 ETF 的數字與分級對齊碳資料表', () => {
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
    // 兩檔 ETF 用 iShares 產品頁的 MSCI 持股加權碳強度（docs/data/carbon-tier-etf-waci.md）。
    expect_('sICLN', 241.74, 'high')
    expect_('sESGU', 71.05, 'high')
  })

  it('轉型揭露只轉述發行方資料：三檔 iShares 基金有，其餘沒有；出處一律是 ishares.com', () => {
    const withTransition = ALL_IDS.filter((id) => ASSET_META[id].transition).map((id) => ASSET_META[id].symbol)
    expect(withTransition.sort()).toEqual(['sBOND', 'sESGU', 'sICLN'])
    for (const sym of withTransition) {
      const tr = ASSET_META[ASSET_IDS[sym as keyof typeof ASSET_IDS]].transition!
      expect(tr.observed, sym).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(tr.sourceUrl, sym).toContain('ishares.com')
      // 沒有文字，身世卡會靜默略過這一塊——釘住 catalog 也有這一檔。
      const s = (t.tokens.provenance.transition.assets as Record<string, { text: string; source: string } | undefined>)[sym]
      expect(s?.text, sym).toBeTruthy()
      expect(s?.source, sym).toBeTruthy()
    }
  })

  it('crypto 的絕對排放量分級：BTC 高、ETH 低（工作量證明 vs 權益證明）', () => {
    expect(ASSET_META[ASSET_IDS.sBTC].carbon!.tier).toBe('high')
    expect(ASSET_META[ASSET_IDS.sETH].carbon!.tier).toBe('low')
  })

  it('sBOND 追蹤綠色債券 ETF（BGRN），碳分級為定性「低」（#106）', () => {
    const m = ASSET_META[ASSET_IDS.sBOND]
    expect(m.provenance!.priceSymbol).toBe('BGRN')
    expect(m.provenance!.referenceId).toContain('BGRN')
    const c = m.carbon!
    expect(c.basis).toBe('qualitative')
    expect(c.tier).toBe('low')
    expect(c.intensity).toBeNull()
    expect(c.observed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(c.sourceUrl).toContain('ishares.com')
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
