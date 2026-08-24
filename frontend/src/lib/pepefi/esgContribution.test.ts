import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'
import type { ESGInfo } from 'src/hooks/useESG'

import { esgContributionOf } from './esgContribution'

const esgOf = (composite: number, rating: string): ESGInfo => ({
  environmental: composite,
  social: composite,
  governance: composite,
  composite,
  rating,
})

describe('esgContributionOf', () => {
  it('空陣列或全部市值為 0 → 空陣列', () => {
    expect(esgContributionOf([], {})).toEqual([])
    expect(esgContributionOf([{ asset: ASSET_IDS.sBTC, currentValue: 0n }], {})).toEqual([])
  })

  it('單一標的佔 100%', () => {
    const rows = [{ asset: ASSET_IDS.sBTC, currentValue: 100n * 10n ** 18n }]
    const esg = { [ASSET_IDS.sBTC]: esgOf(38, 'CCC') }
    const out = esgContributionOf(rows, esg)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'sBTC', weightPct: 100, composite: 38, rating: 'CCC' })
  })

  it('依市值算佔比,不是簡單平分', () => {
    const rows = [
      { asset: ASSET_IDS.sBTC, currentValue: 300n * 10n ** 18n },
      { asset: ASSET_IDS.sAAPL, currentValue: 100n * 10n ** 18n },
    ]
    const esg = { [ASSET_IDS.sBTC]: esgOf(38, 'CCC'), [ASSET_IDS.sAAPL]: esgOf(72, 'AA') }
    const out = esgContributionOf(rows, esg)
    const btc = out.find((c) => c.symbol === 'sBTC')!
    const aapl = out.find((c) => c.symbol === 'sAAPL')!
    expect(btc.weightPct).toBeCloseTo(75)
    expect(aapl.weightPct).toBeCloseTo(25)
  })

  it('同一標的的多筆部位合併成一筆,不是分開列兩次', () => {
    const rows = [
      { asset: ASSET_IDS.sBTC, currentValue: 60n * 10n ** 18n },
      { asset: ASSET_IDS.sBTC, currentValue: 40n * 10n ** 18n },
    ]
    const esg = { [ASSET_IDS.sBTC]: esgOf(38, 'CCC') }
    const out = esgContributionOf(rows, esg)
    expect(out).toHaveLength(1)
    expect(out[0].weightPct).toBeCloseTo(100)
  })

  it('依市值由大到小排序', () => {
    const rows = [
      { asset: ASSET_IDS.sAAPL, currentValue: 10n * 10n ** 18n },
      { asset: ASSET_IDS.sBTC, currentValue: 90n * 10n ** 18n },
    ]
    const esg = { [ASSET_IDS.sBTC]: esgOf(38, 'CCC'), [ASSET_IDS.sAAPL]: esgOf(72, 'AA') }
    const out = esgContributionOf(rows, esg)
    expect(out.map((c) => c.symbol)).toEqual(['sBTC', 'sAAPL'])
  })
})
