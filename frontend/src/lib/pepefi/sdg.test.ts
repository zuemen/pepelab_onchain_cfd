import { it, expect, describe } from 'vitest'

import { esg as esgEn } from 'src/locales/en/esg'
import { ASSET_IDS } from 'src/contracts/addresses'
import { esg as esgZh } from 'src/locales/zh-TW/esg'

import { ASSET_META } from './assetMeta'
import { ASSET_SDG, SDG_GOALS, sdgHoldings, sdgDistribution, hasPositiveExposure } from './sdg'

const SYMBOLS = Object.keys(ASSET_IDS)

describe('ASSET_SDG（團隊撰寫的 SDG 對應表）', () => {
  it('涵蓋 11 個資產，每個至少對應一個目標', () => {
    expect(SYMBOLS).toHaveLength(11)
    for (const symbol of SYMBOLS) {
      expect(ASSET_SDG[symbol]?.length ?? 0, symbol).toBeGreaterThan(0)
    }
  })

  it('目標只會是 1–17，同一資產不重複列同一個目標', () => {
    for (const [symbol, links] of Object.entries(ASSET_SDG)) {
      const goals = links.map((l) => l.goal)
      expect(new Set(goals).size, symbol).toBe(goals.length)
      for (const g of goals) expect(SDG_GOALS).toContain(g)
    }
  })

  it('每一筆對應在兩個語系都有一句理由', () => {
    for (const [symbol, links] of Object.entries(ASSET_SDG)) {
      for (const { goal } of links) {
        for (const cat of [esgZh, esgEn]) {
          const reason = (cat.sdg.reasons as Record<string, Record<number, string>>)[symbol]?.[goal]
          expect(reason?.trim().length ?? 0, `${symbol} SDG ${goal}`).toBeGreaterThan(8)
        }
      }
    }
  })

  it('每個出現的目標在兩個語系都有名稱', () => {
    const used = new Set(Object.values(ASSET_SDG).flatMap((links) => links.map((l) => l.goal)))
    for (const g of used) {
      for (const cat of [esgZh, esgEn]) {
        expect((cat.sdg.goalNames as Record<number, string>)[g]?.length ?? 0, `goal ${g}`).toBeGreaterThan(1)
      }
    }
  })

  it('對應表的鍵就是資產代號（和 ASSET_META 一致）', () => {
    for (const symbol of Object.keys(ASSET_SDG)) {
      const id = (ASSET_IDS as Record<string, string>)[symbol]
      expect(ASSET_META[id]?.symbol, symbol).toBe(symbol)
    }
  })
})

describe('sdgDistribution', () => {
  it('依權重：一個目標的比例是「有對應這個目標的資產」的權重佔比，正負分開', () => {
    // sICLN（7+、13+）60%，sBTC（7−、13−）40%
    const d = sdgDistribution([
      { symbol: 'sICLN', weight: 6_000 },
      { symbol: 'sBTC', weight: 4_000 },
    ])
    const g7 = d.goals.find((g) => g.goal === 7)!
    expect(g7.positivePct).toBeCloseTo(60)
    expect(g7.negativePct).toBeCloseTo(40)
    expect(d.unmappedPct).toBe(0)
  })

  it('依總曝險由大到小排序', () => {
    const d = sdgDistribution([
      { symbol: 'sICLN', weight: 1_000 },
      { symbol: 'sNVDA', weight: 9_000 },
    ])
    expect(d.goals[0].positivePct + d.goals[0].negativePct).toBeGreaterThanOrEqual(
      d.goals[d.goals.length - 1].positivePct + d.goals[d.goals.length - 1].negativePct,
    )
  })

  it('不在表裡的資產列為未對應，不當成中性分攤到各目標', () => {
    const d = sdgDistribution([
      { symbol: 'sICLN', weight: 5_000 },
      { symbol: 'PEPE', weight: 5_000 },
    ])
    expect(d.unmappedPct).toBeCloseTo(50)
    expect(d.goals.find((g) => g.goal === 7)!.positivePct).toBeCloseTo(50)
  })

  it('沒有權重時回空結果', () => {
    expect(sdgDistribution([])).toEqual({ goals: [], unmappedPct: 0, shortPct: 0 })
    expect(sdgDistribution([{ symbol: 'sBTC', weight: 0 }])).toEqual({ goals: [], unmappedPct: 0, shortPct: 0 })
  })
})

describe('hasPositiveExposure（排行榜的 SDG 篩選）', () => {
  it('策略裡有任何正向對應這個目標的資產才算', () => {
    expect(hasPositiveExposure([{ symbol: 'sICLN', weight: 1 }], 7)).toBe(true)
    // sBTC 對 SDG 7 是負向
    expect(hasPositiveExposure([{ symbol: 'sBTC', weight: 1 }], 7)).toBe(false)
    expect(hasPositiveExposure([{ symbol: 'sICLN', weight: 0 }], 7)).toBe(false)
  })
})

describe('空方部位（審查後補）', () => {
  it('放空不算支持這個目標：空方部位不進任何目標，另外回報比例', () => {
    // 放空 sICLN 60%、做多 sBTC 40%
    const d = sdgDistribution([
      { symbol: 'sICLN', weight: 6_000, isLong: false },
      { symbol: 'sBTC', weight: 4_000, isLong: true },
    ])
    const g7 = d.goals.find((g) => g.goal === 7)!
    expect(g7.positivePct).toBe(0)
    expect(g7.negativePct).toBeCloseTo(40)
    expect(d.shortPct).toBeCloseTo(60)
  })

  it('篩選只看做多的資產', () => {
    expect(hasPositiveExposure([{ symbol: 'sICLN', weight: 1, isLong: false }], 7)).toBe(false)
    expect(hasPositiveExposure([{ symbol: 'sICLN', weight: 1, isLong: true }], 7)).toBe(true)
  })
})

describe('sdgHoldings', () => {
  it('把鏈上的資產 id 換成代號，大小寫不影響', () => {
    const id = ASSET_IDS.sICLN
    expect(sdgHoldings([{ asset: id.toUpperCase().replace('0X', '0x'), weight: 5, isLong: true }])).toEqual([
      { symbol: 'sICLN', weight: 5, isLong: true },
    ])
  })

  it('認不得的 id 原樣留著，在分布裡算成未對應', () => {
    const d = sdgDistribution(sdgHoldings([{ asset: '0xdead', weight: 1 }]))
    expect(d.unmappedPct).toBe(100)
  })
})
