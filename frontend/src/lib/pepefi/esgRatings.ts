import { ASSET_META, type AssetCategory } from './assetMeta'
import { ESG_RATINGS } from './esgRatingsData'

// issue #383：平台不替資產評分。這裡只回答「某檔資產在某家評級機構那一格要畫成什麼」。

/** 表格欄位的順序也就是這個順序。 */
export type EsgProvider = 'msci' | 'sustainalytics' | 'lseg' | 'spGlobal' | 'ccdata'

export const ESG_PROVIDERS: readonly EsgProvider[] = ['msci', 'sustainalytics', 'lseg', 'spGlobal', 'ccdata']

/**
 * 燈號。只在評級機構自己有定義分組時才有（MSCI 的 Leader／Average／Laggard、Sustainalytics 的
 * 五個風險等級、Morningstar 基金的地球數），平台不替只給分數的機構（LSEG、S&P）切門檻。
 */
export type EsgLight = 'good' | 'middle' | 'poor'

/** Sustainalytics 公布的五個風險等級，分數越低風險越低。 */
export type SustainalyticsCategory = 'negligible' | 'low' | 'medium' | 'high' | 'severe'

/** LSEG 2026 年版 ESG Scores 的 12 個主題，依 E、S、G 的順序。 */
export const LSEG_THEMES = {
  e: ['climateTransition', 'energyResourceUse', 'biodiversity', 'waterUse', 'wastePollution'],
  s: ['labourRelations', 'healthSafety', 'humanRightsCommunity'],
  g: ['boardManagement', 'shareholderRights', 'conductAntiCorruption', 'taxTransparency'],
} as const
export type LsegTheme = (typeof LSEG_THEMES)[keyof typeof LSEG_THEMES][number]

/** Sustainalytics 頁面上的重大議題與爭議領域；名稱在 catalog 的 esg.thirdParty.sustainalytics。 */
export type SustainalyticsIssue =
  | 'humanCapital' | 'businessEthics' | 'dataPrivacy' | 'productGovernance' | 'carbonProducts'
export type SustainalyticsArea = 'customer' | 'societyCommunity' | 'operations' | 'businessEthics' | 'employee'

/**
 * 原始頁面上評級以外的細項，依評級機構分開。產業名稱是評級機構自己的分類，照原文保留。
 */
export type EsgRatingDetail =
  | {
      kind: 'msciFund'
      /** MSCI ESG Quality Score（0–10）。 */
      qualityScore: number
      /** 在同類基金中的百分位與同類基金數。 */
      peerPercentile: number
      peerCount: number
      /** MSCI 持股加權碳強度（tCO2e／每百萬美元營收）與涵蓋率。 */
      waci: number
      /** MSCI Implied Temperature Rise，照頁面原文。 */
      impliedTemperatureRise: string
      coveragePct: number
    }
  | {
      kind: 'sustainalyticsCompany'
      category: SustainalyticsCategory
      /** 最高爭議等級，1 = 低、5 = 嚴重；以及它的評估日。 */
      controversyLevel: 1 | 2 | 3 | 4 | 5
      controversyAsOf: string
      controversyAreas: SustainalyticsArea[]
      /** 頁面上的前三大重大議題，依頁面順序。 */
      topIssues: SustainalyticsIssue[]
    }
  | {
      kind: 'morningstarFund'
      /** Morningstar 投資組合 ESG 風險評級（地球數，1–5，5 最好），跟同類基金比。 */
      globes: 1 | 2 | 3 | 4 | 5
      /** 投資組合的企業 ESG 風險分數（0–50，越低越好）：目前與 12 個月平均。 */
      corporateRiskScore: number
      corporateRiskScoreHistorical: number
      /** 有 Sustainalytics 評分的資產佔基金規模的比例。 */
      aumCoveragePct: number
    }
  | {
      kind: 'lseg'
      /** 依據的公司自行揭露資料年度。 */
      fiscalYear: number
      pillars: { e: number; s: number; g: number }
      themes: Record<LsegTheme, number>
      industry: string
      rank: number
      rankOf: number
    }
  | {
      kind: 'spGlobal'
      underReview: boolean
      csaRespondent: boolean
      /** 不含模型推估的 CSA 分數。 */
      csaScore: number
      industry: string
    }

export interface EsgRating {
  asset: string
  provider: EsgProvider
  /** 評級機構公布的原樣：字母、分數或「4/5」這類寫法。 */
  rating: string
  /**
   * 評級機構標示的評級日，ISO `YYYY-MM-DD`。頁面上沒有日期時是 null（LSEG 只標資料年度，
   * 在 detail.fiscalYear）——不拿查詢日去填，那會讓人以為是評級日。
   */
  ratedOn: string | null
  /** 我們查詢原始頁面的日期，ISO `YYYY-MM-DD`。 */
  retrievedOn: string
  sourceUrl: string
  detail?: EsgRatingDetail
}

export type RatingCell =
  | { kind: 'rated'; rating: EsgRating; light: EsgLight | null }
  /** 這家有評這類資產，但個別評級沒有公開（MSCI 的公司評級）。不是「未評等」。 */
  | { kind: 'notPublic' }
  /** 這家有評這類資產、也公開，但沒有評這一檔。 */
  | { kind: 'unrated' }
  /** 這家根本不評這類資產（例如 S&P 不評加密資產）。 */
  | { kind: 'notApplicable' }

/**
 * 每家評級機構評哪幾類資產、公開與否。沒列的類別就是這家不評。
 * sBOND 歸在 bond，但它追蹤的 BGRN 是基金，所以兩家的基金評級也涵蓋 bond。
 */
const COVERAGE: Record<EsgProvider, Partial<Record<AssetCategory, 'public' | 'notPublic'>>> = {
  msci:           { equity: 'notPublic', etf: 'public', bond: 'public' },
  sustainalytics: { equity: 'public', etf: 'public', bond: 'public' },
  lseg:           { equity: 'public' },
  spGlobal:       { equity: 'public' },
  ccdata:         { crypto: 'public' },
}

const MSCI_GROUP: Record<string, EsgLight> = {
  AAA: 'good', AA: 'good',
  A: 'middle', BBB: 'middle', BB: 'middle',
  B: 'poor', CCC: 'poor',
}

const SUSTAINALYTICS_GROUP: Record<SustainalyticsCategory, EsgLight> = {
  negligible: 'good', low: 'good', medium: 'middle', high: 'poor', severe: 'poor',
}

/** Morningstar 的地球數：5、4 高於平均，3 平均，2、1 低於平均。 */
const GLOBE_GROUP: Record<number, EsgLight> = { 5: 'good', 4: 'good', 3: 'middle', 2: 'poor', 1: 'poor' }

function lightOf(r: EsgRating): EsgLight | null {
  if (r.provider === 'msci') return MSCI_GROUP[r.rating] ?? null
  if (r.detail?.kind === 'sustainalyticsCompany') return SUSTAINALYTICS_GROUP[r.detail.category]
  if (r.detail?.kind === 'morningstarFund') return GLOBE_GROUP[r.detail.globes] ?? null
  return null
}

/** `ratings` 預設是進版控的那份資料；測試可以換成別的。 */
export function ratingCell(
  assetId: string,
  provider: EsgProvider,
  ratings: readonly EsgRating[] = ESG_RATINGS,
): RatingCell {
  const category = ASSET_META[assetId]?.category
  const coverage = category ? COVERAGE[provider][category] : undefined
  if (coverage === undefined) return { kind: 'notApplicable' }
  if (coverage === 'notPublic') return { kind: 'notPublic' }
  const rating = ratings.find((r) => r.asset === assetId && r.provider === provider)
  if (!rating) return { kind: 'unrated' }
  return { kind: 'rated', rating, light: lightOf(rating) }
}

/** 至少有一家公開了這檔的評級。沒有的整檔標「未評等」。 */
export function hasThirdPartyRating(assetId: string, ratings: readonly EsgRating[] = ESG_RATINGS): boolean {
  return ESG_PROVIDERS.some((p) => ratingCell(assetId, p, ratings).kind === 'rated')
}
