import { describe, it, expect } from 'vitest'

import { ESG_RATINGS } from './esgRatingsData'
import { ratingCell } from './esgRatings'

// issue #383：每一筆第三方評級都要查得回原始頁面，而且只能是評級機構自己公布的樣子。
// 這份測試不管值對不對（那要回原始頁面查），只管「一筆評級該有的東西有沒有齊」。

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const label = (r: (typeof ESG_RATINGS)[number]) => `${r.provider} ${r.asset.slice(0, 10)}`

describe('ESG_RATINGS', () => {
  it.each(ESG_RATINGS.map((r) => [label(r), r] as const))('%s 附 https 出處、評級日與查詢日', (_, r) => {
    expect(r.sourceUrl.startsWith('https://')).toBe(true)
    expect(r.ratedOn).toMatch(ISO_DATE)
    expect(r.retrievedOn).toMatch(ISO_DATE)
    expect(r.ratedOn <= r.retrievedOn, '評級日不能晚於查詢日').toBe(true)
  })

  it.each(ESG_RATINGS.map((r) => [label(r), r] as const))('%s 的評級落在這家機構自己的尺度裡', (_, r) => {
    if (r.provider === 'msci') expect(['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC']).toContain(r.rating)
    if (r.provider === 'spGlobal') {
      expect(r.rating).toMatch(/^\d{1,3}$/)
      expect(Number(r.rating)).toBeLessThanOrEqual(100)
      expect(r.spGlobal, 'S&P 頁面上的審查中、是否回覆問卷要一起記').toBeDefined()
    }
    if (r.provider === 'ccdata') expect(r.rating).toMatch(/^[A-E]{1,2}$/)
  })

  it('同一檔資產在同一家機構只有一筆', () => {
    const keys = ESG_RATINGS.map((r) => `${r.asset}|${r.provider}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('每一筆都畫得出來：不會放在「不適用」或「未公開」的格子裡', () => {
    for (const r of ESG_RATINGS) {
      expect(ratingCell(r.asset, r.provider).kind, label(r)).toBe('rated')
    }
  })
})
