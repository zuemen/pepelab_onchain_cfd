import { ASSET_META, type AssetCategory } from './assetMeta'
import { ESG_RATINGS } from './esgRatingsData'

// issue #383：平台不替資產評分。這裡只回答「某檔資產在某家評級機構那一格要畫成什麼」。

export type EsgProvider = 'msci' | 'spGlobal' | 'ccdata'

/** 燈號只用評級機構自己定義的分組（MSCI 的 Leader／Average／Laggard），平台不替它切門檻。 */
export type EsgLight = 'leader' | 'average' | 'laggard'

export interface EsgRating {
  asset: string
  provider: EsgProvider
  /** 評級機構公布的原樣：MSCI 是字母、S&P 是 0–100 的整數字串、CCData 是字母。 */
  rating: string
  /** 評級機構標示的評級日，ISO `YYYY-MM-DD`。 */
  ratedOn: string
  /** 我們查詢原始頁面的日期，ISO `YYYY-MM-DD`。 */
  retrievedOn: string
  sourceUrl: string
  /** S&P Global 頁面上另外標示的兩件事，畫面照實轉述。 */
  spGlobal?: { underReview: boolean; csaRespondent: boolean }
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
 * sBOND 歸在 bond，但它追蹤的 BGRN 是基金，所以 MSCI 的基金評級也涵蓋 bond。
 */
const COVERAGE: Record<EsgProvider, Partial<Record<AssetCategory, 'public' | 'notPublic'>>> = {
  msci:     { equity: 'notPublic', etf: 'public', bond: 'public' },
  spGlobal: { equity: 'public' },
  ccdata:   { crypto: 'public' },
}

const MSCI_GROUP: Record<string, EsgLight> = {
  AAA: 'leader', AA: 'leader',
  A: 'average', BBB: 'average', BB: 'average',
  B: 'laggard', CCC: 'laggard',
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
  return { kind: 'rated', rating, light: provider === 'msci' ? (MSCI_GROUP[rating.rating] ?? null) : null }
}

export const ESG_PROVIDERS: readonly EsgProvider[] = ['msci', 'spGlobal', 'ccdata']

/** 至少有一家公開了這檔的評級。沒有的整檔標「未評等」。 */
export function hasThirdPartyRating(assetId: string, ratings: readonly EsgRating[] = ESG_RATINGS): boolean {
  return ESG_PROVIDERS.some((p) => ratingCell(assetId, p, ratings).kind === 'rated')
}
