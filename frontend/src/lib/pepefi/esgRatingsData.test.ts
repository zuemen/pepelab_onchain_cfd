import { describe, it, expect } from 'vitest'

import { ESG_RATINGS } from './esgRatingsData'
import { ratingCell, LSEG_THEMES } from './esgRatings'

// issue #383：每一筆第三方評級都要查得回原始頁面，而且只能是評級機構自己公布的樣子。
// 這份測試不管值對不對（那要回原始頁面查），只管「一筆評級該有的東西有沒有齊、彼此有沒有矛盾」。

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const label = (r: (typeof ESG_RATINGS)[number]) => `${r.provider} ${r.asset.slice(0, 10)}`
const each = ESG_RATINGS.map((r) => [label(r), r] as const)

/** Sustainalytics 公布的風險區間：可忽略 0–9.99、低 10–19.99、中 20–29.99、高 30–39.99、嚴重 40+。 */
const SUSTAINALYTICS_BAND = (score: number) =>
  score < 10 ? 'negligible' : score < 20 ? 'low' : score < 30 ? 'medium' : score < 40 ? 'high' : 'severe'

describe('ESG_RATINGS', () => {
  it.each(each)('%s 附 https 出處與查詢日；評級日只有 LSEG 可以沒有', (_, r) => {
    expect(r.sourceUrl.startsWith('https://')).toBe(true)
    expect(r.retrievedOn).toMatch(ISO_DATE)
    if (r.ratedOn === null) {
      expect(r.detail?.kind, '沒有評級日時要有資料年度').toBe('lseg')
    } else {
      expect(r.ratedOn).toMatch(ISO_DATE)
      expect(r.ratedOn <= r.retrievedOn, '評級日不能晚於查詢日').toBe(true)
    }
  })

  it.each(each)('%s 的評級落在這家機構自己的尺度裡，細項也對得上', (_, r) => {
    const d = r.detail
    switch (r.provider) {
      case 'msci':
        expect(['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC']).toContain(r.rating)
        expect(d?.kind).toBe('msciFund')
        break
      case 'spGlobal':
        expect(r.rating).toMatch(/^\d{1,3}$/)
        expect(Number(r.rating)).toBeLessThanOrEqual(100)
        expect(d?.kind, 'S&P 頁面上的審查中、是否回覆問卷、CSA 分數要一起記').toBe('spGlobal')
        if (d?.kind !== 'spGlobal') break
        // 模型只補 CSA 算 0 分的題目，所以 ESG 分數不會低於 CSA 分數；卡片上「模型補上的分數」靠這點。
        expect(d.csaScore, 'CSA 分數不能高於 ESG 分數').toBeLessThanOrEqual(Number(r.rating))
        break
      case 'ccdata':
        expect(r.rating).toMatch(/^[A-E]{1,2}$/)
        break
      case 'sustainalytics':
        if (d?.kind === 'sustainalyticsCompany') {
          expect(d.category, '等級要落在 Sustainalytics 公布的分數區間').toBe(SUSTAINALYTICS_BAND(Number(r.rating)))
          expect(d.controversyAsOf).toMatch(ISO_DATE)
          expect(d.topIssues.length).toBeGreaterThan(0)
        } else {
          expect(d?.kind).toBe('morningstarFund')
          if (d?.kind === 'morningstarFund') expect(r.rating).toBe(`${d.globes}/5`)
        }
        break
      case 'lseg':
        expect(d?.kind).toBe('lseg')
        if (d?.kind !== 'lseg') break
        for (const v of [Number(r.rating), d.pillars.e, d.pillars.s, d.pillars.g]) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(5)
        }
        expect(Object.keys(d.themes).sort(), '12 個主題要齊').toEqual(Object.values(LSEG_THEMES).flat().sort())
        expect(d.rank).toBeLessThanOrEqual(d.rankOf)
        break
    }
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
