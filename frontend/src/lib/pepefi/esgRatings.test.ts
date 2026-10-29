import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import { ratingCell, hasThirdPartyRating } from './esgRatings'

// issue #383：平台不替資產評分，ESG 頁只轉述第三方評級。這份測試釘住「一格要畫成什麼」：
// 有評級、這家沒公開、這家根本不評這類資產，三種情況不能混成同一種。

describe('ratingCell', () => {
  it('MSCI 基金評級 A 屬於 Average 組，亮黃燈', () => {
    const cell = ratingCell(ASSET_IDS.sICLN, 'msci')
    expect(cell.kind).toBe('rated')
    if (cell.kind !== 'rated') return
    expect(cell.rating.rating).toBe('A')
    expect(cell.light).toBe('middle')
  })

  it('S&P Global 只給 0–100 的分數，沒有自己的分組，所以不上燈', () => {
    const cell = ratingCell(ASSET_IDS.sNVDA, 'spGlobal')
    expect(cell.kind).toBe('rated')
    if (cell.kind !== 'rated') return
    expect(cell.rating.rating).toBe('61')
    expect(cell.light).toBeNull()
  })

  it('MSCI 有評股票但不公開：標「未公開」，不能說成「未評等」', () => {
    expect(ratingCell(ASSET_IDS.sAAPL, 'msci')).toEqual({ kind: 'notPublic' })
  })

  it('這家根本不評這類資產：標「不適用」', () => {
    expect(ratingCell(ASSET_IDS.sBTC, 'spGlobal')).toEqual({ kind: 'notApplicable' })
    expect(ratingCell(ASSET_IDS.sGOLD, 'msci')).toEqual({ kind: 'notApplicable' })
    expect(ratingCell(ASSET_IDS.sICLN, 'ccdata')).toEqual({ kind: 'notApplicable' })
  })

  it('這家有評這類資產、也公開，但沒有評這一檔：標「未評等」', () => {
    expect(ratingCell(ASSET_IDS.sICLN, 'msci', [])).toEqual({ kind: 'unrated' })
  })
})

describe('ratingCell · 燈號只跟著評級機構自己的分組', () => {
  const lightOf = (asset: string, provider: Parameters<typeof ratingCell>[1]) => {
    const cell = ratingCell(asset, provider)
    return cell.kind === 'rated' ? cell.light : cell.kind
  }

  it('Sustainalytics 公司風險等級：可忽略與低風險亮綠燈，中風險亮黃燈', () => {
    expect(lightOf(ASSET_IDS.sNVDA, 'sustainalytics')).toBe('good')   // 14.01 低風險
    expect(lightOf(ASSET_IDS.sGOOGL, 'sustainalytics')).toBe('middle') // 20.91 中風險
  })

  it('Morningstar 基金的地球數：4 顆以上綠燈，3 顆黃燈', () => {
    expect(lightOf(ASSET_IDS.sICLN, 'sustainalytics')).toBe('good')
    expect(lightOf(ASSET_IDS.sBOND, 'sustainalytics')).toBe('middle')
  })

  it('LSEG 只給 0–5 分、沒有自己的分組，不上燈；也不評 ETF 與加密資產', () => {
    expect(lightOf(ASSET_IDS.sAAPL, 'lseg')).toBeNull()
    expect(lightOf(ASSET_IDS.sICLN, 'lseg')).toBe('notApplicable')
    expect(lightOf(ASSET_IDS.sBTC, 'lseg')).toBe('notApplicable')
  })
})

describe('hasThirdPartyRating', () => {
  it('黃金沒有任何一家評：整檔標未評等', () => {
    expect(hasThirdPartyRating(ASSET_IDS.sGOLD)).toBe(false)
  })

  it('只要有一家公開評了就算有（BTC 只有 CCData）', () => {
    expect(hasThirdPartyRating(ASSET_IDS.sBTC)).toBe(true)
  })

  it('MSCI 有評但不公開，不算有：畫面上沒有任何評級可看', () => {
    expect(hasThirdPartyRating(ASSET_IDS.sAAPL, [])).toBe(false)
  })
})
