// 模擬交易者的績效資料（issue #309）——純函式加兩個讀取函式，不含 ethers 或 React。
//
// 資料由 heroes/ 的管線從本機鏈的事件算出來，放在 public/data/heroes/：一份索引（排行榜用）
// 加每位交易者一個詳細檔（個人頁用）。它只補鏈上讀不出來的歷史統計；跟隨者人數、質押、
// 聲譽、目前策略照舊直接讀鏈。
//
// 這份資料只屬於產生它的那條鏈：chainId 不符就當作沒有，畫面走原本的路徑。

import { computeTraderScore, type TraderCard } from './leaderboardMetrics'

/** 2：每位交易者多了 activeSince（排行榜用來判斷能不能列入排名）。 */
export const HERO_SCHEMA_VERSION = 2

export interface HeroWindow {
  pnlUsd: number
  marginUsd: number
  volumeUsd: number
  wins: number
  trades: number
}

export interface HeroSummary {
  address: string
  name: string
  rule: string
  totalReturnPct: number
  maxDrawdownPct: number
  sharpe: number
  /** 沒有任何平倉時為 null。 */
  winRatePct: number | null
  closedTrades: number
  esgScore: number | null
  window7d: HeroWindow
  window30d: HeroWindow
  sparkline: number[]
  /** 第一次發布策略的日期（YYYY-MM-DD）；從沒發布過時為 null。 */
  activeSince: string | null
}

export interface HeroIndex {
  schemaVersion: number
  chainId: number
  range: { from: string; to: string }
  traders: HeroSummary[]
}

export interface HeroLeg {
  asset: string
  weightBps: number
  isLong: boolean
  leverage: number
}

export interface HeroStrategyVersion {
  date: string
  versionId: number
  tx: string
  legs: HeroLeg[]
}

export interface HeroTrade {
  positionId: number
  asset: string
  isLong: boolean
  leverage: number
  marginUsd: number
  openTx: string
  openTime: number
  openPrice: number
  /** 以下五個欄位在部位還沒平倉時為 null。 */
  closeTx: string | null
  closeTime: number | null
  closePrice: number | null
  pnlUsd: number | null
  grossPnlUsd: number | null
  liquidated: boolean
}

export interface HeroDetail extends HeroSummary {
  equityCurve: { date: string; equity: number }[]
  monthlyReturns: { month: string; returnPct: number }[]
  exposure: { asset: string; weightPct: number; isLong: boolean; leverage: number }[]
  esgCorrelation: number | null
  avgHoldDays: number | null
  /** 1–10，最近 365 天日報酬的 95% 單日 VaR 分級；資料不足 30 天時為 null。 */
  riskScore: number | null
  /** 以下三個是正數表示的損失百分比。 */
  worstDayLossPct: number
  worstWeekLossPct: number
  maxDrawdown1yPct: number
  profitableWeeksPct: number | null
  tradesPerWeek: number
  topAssets: { asset: string; trades: number; sharePct: number }[]
  followerHistory: { month: string; followers: number }[]
  strategies: HeroStrategyVersion[]
  trades: HeroTrade[]
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x)
const WINDOW_KEYS = ['pnlUsd', 'marginUsd', 'volumeUsd', 'wins', 'trades'] as const
const isWindow = (x: unknown): boolean => isRecord(x) && WINDOW_KEYS.every((k) => isNum(x[k]))

const isSummary = (x: unknown): boolean =>
  isRecord(x) &&
  typeof x.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x.address) &&
  typeof x.name === 'string' && typeof x.rule === 'string' &&
  isNum(x.totalReturnPct) && isNum(x.maxDrawdownPct) && isNum(x.sharpe) &&
  isNumOrNull(x.winRatePct) && isNum(x.closedTrades) && isNumOrNull(x.esgScore) &&
  isWindow(x.window7d) && isWindow(x.window30d) &&
  Array.isArray(x.sparkline) && x.sparkline.every(isNum) &&
  (x.activeSince === null || typeof x.activeSince === 'string')

/** 只要有一筆不合格就整份不收：半份資料畫出來的排行榜比沒有資料更糟。 */
export function parseHeroIndex(raw: unknown, chainId: number | null): HeroIndex | null {
  if (!isRecord(raw) || raw.schemaVersion !== HERO_SCHEMA_VERSION) return null
  if (chainId === null || raw.chainId !== chainId) return null
  if (!isRecord(raw.range) || typeof raw.range.from !== 'string' || typeof raw.range.to !== 'string') return null
  if (!Array.isArray(raw.traders) || !raw.traders.every(isSummary)) return null
  return raw as unknown as HeroIndex
}

const DETAIL_LISTS = ['equityCurve', 'monthlyReturns', 'exposure', 'strategies', 'trades'] as const

export function parseHeroDetail(raw: unknown, address: string): HeroDetail | null {
  if (!isSummary(raw)) return null
  const record = raw as Record<string, unknown>
  if ((record.address as string).toLowerCase() !== address.toLowerCase()) return null
  if (!DETAIL_LISTS.every((k) => Array.isArray(record[k]))) return null
  if (!isNumOrNull(record.esgCorrelation) || !isNumOrNull(record.avgHoldDays)) return null
  if (!isNumOrNull(record.riskScore) || !isNumOrNull(record.profitableWeeksPct)) return null
  if (!['worstDayLossPct', 'worstWeekLossPct', 'maxDrawdown1yPct', 'tradesPerWeek'].every((k) => isNum(record[k]))) return null
  if (!Array.isArray(record.topAssets) || !Array.isArray(record.followerHistory)) return null
  return raw as HeroDetail
}

// ── 讀取 ─────────────────────────────────────────────────────────────────────

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const fileUrl = (name: string) => `${import.meta.env.BASE_URL}data/heroes/${name}`

/** 讀不到（404、不是 JSON、離線）一律是 null。SPA 的 fallback 會對不存在的檔回 index.html，所以 json() 失敗是常態。 */
async function readJson(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url)
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

export async function fetchHeroIndex(chainId: number | null, fetchImpl: FetchLike = fetch): Promise<HeroIndex | null> {
  if (chainId === null) return null
  return parseHeroIndex(await readJson(fileUrl('index.json'), fetchImpl), chainId)
}

export async function fetchHeroDetail(
  address: string,
  chainId: number | null,
  fetchImpl: FetchLike = fetch,
): Promise<HeroDetail | null> {
  const index = await fetchHeroIndex(chainId, fetchImpl)
  if (!index || !heroByAddress(index).has(address.toLowerCase())) return null
  return parseHeroDetail(await readJson(fileUrl(`${address.toLowerCase()}.json`), fetchImpl), address)
}

export const heroByAddress = (index: HeroIndex): Map<string, HeroSummary> =>
  new Map(index.traders.map((t) => [t.address.toLowerCase(), t]))

// ── 併進排行榜 ────────────────────────────────────────────────────────────────

/** 美元 → 18 位小數的 wei。先乘到百萬分之一再取整，避免 123.45 × 1e18 的浮點誤差。 */
export const usdToWei = (usd: number): bigint => BigInt(Math.round(usd * 1e6)) * 10n ** 12n

/**
 * 用績效資料取代瀏覽器掃事件得到的那幾個欄位。近期視窗取 30 天：策略以週到月為單位調整，
 * 7 天內的平倉常不足以通過「至少 5 筆」的樣本門檻。欄位名稱（pnl7d）是既有的，
 * 這裡不改名；畫面上的標題由呼叫端換成 30 天。
 * 從鏈上讀到的（跟隨者、質押、聲譽、罰沒、策略）原樣保留。
 */
export function applyHeroSummary(card: TraderCard, hero: HeroSummary): TraderCard {
  const recent = hero.window30d
  const pnl = usdToWei(recent.pnlUsd)
  const margin = usdToWei(recent.marginUsd)
  return {
    ...card,
    totalVolume: usdToWei(recent.volumeUsd),
    pnl7d: pnl,
    marginDeployed: margin,
    wins: recent.wins,
    trades: recent.trades,
    equityCurve: hero.sparkline.length < 2 ? [] : hero.sparkline.map((v) => usdToWei(v - hero.sparkline[0])),
    score: computeTraderScore({
      pnl7d: pnl,
      marginDeployed: margin,
      wins: recent.wins,
      trades: recent.trades,
      stake: card.stake,
      reputation: card.reputation,
      totalSlashed: card.totalSlashed,
    }),
    hero,
  }
}

// ── 顯示 ─────────────────────────────────────────────────────────────────────

type Maybe = number | null | undefined
const missing = (v: Maybe): v is null | undefined => v === null || v === undefined

/** 「+12.3%」/「-4.2%」。符號永遠顯示；缺資料給破折號，不是 0。 */
export const fSignedPct = (v: Maybe): string => (missing(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)

/** 回撤存的是正數（8.9 代表從高點跌了 8.9%），顯示成損失。 */
export const fDrawdown = (v: Maybe): string => (missing(v) ? '—' : v === 0 ? '0.0%' : `-${v.toFixed(1)}%`)

export const fRatio = (v: Maybe): string => (missing(v) ? '—' : v.toFixed(2))

export const fUsd = (v: Maybe): string =>
  missing(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
