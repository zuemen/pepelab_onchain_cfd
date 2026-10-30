// 策略實驗室的資料（issue #332）——純函式加兩個讀取函式，不含 ethers 或 React。
//
// 資料由 heroes/build_lab.py 用真實歷史價格預先算好，放在 public/data/lab/：一份索引（策略、參數格點、
// 標的、資料期間），加上每一組（策略、參數、標的）一個結果檔。前端只讀檔、不計算，也不讀鏈，
// 所以這份資料不綁定任何鏈，公開展示站也看得到。
//
// 唯一和鏈有關的是「相近的模擬交易者」：那些交易者只存在本機鏈，判斷沿用 heroData 的規則
// （chainId 不符、未連錢包就當作沒有），沒有就整塊不顯示。

import { heroDataUrl, parseHeroIndex, type HeroSummary } from './heroData'
import { isHiddenTrader } from './hiddenTraders'

export const LAB_SCHEMA_VERSION = 1

export type LabStrategyKind = 'single' | 'portfolio'

export interface LabParam {
  key: string
  values: number[]
}

export interface LabStrategy {
  id: string
  kind: LabStrategyKind
  /** 持倉組合類用的規則（heroes/herolab/rules.py）；逐筆策略為 null。 */
  rule: string | null
  params: LabParam[]
}

export interface LabAsset {
  id: string
  carbonTier: string
  feeBps: number
  borrowBpsPerHour: number
  maxLeverage: number
}

export interface LabIndex {
  schemaVersion: number
  range: { from: string; to: string }
  capitalUsd: number
  martingaleBasePct: number
  forecast: { horizonDays: number; paths: number; blockDays: number; seed: number; percentiles: number[] }
  assets: LabAsset[]
  baskets: { id: string; assets: string[] }[]
  strategies: LabStrategy[]
}

export type LabAction = 'open' | 'close' | 'liquidated'

export interface LabTrade {
  /** 從回測第一天起算的第幾天。 */
  day: number
  asset: string
  action: LabAction
  isLong: boolean
  price: number
  marginUsd: number
  /** 只有平倉與清算有：退回 − 保證金 − 開倉手續費。 */
  pnlUsd: number | null
}

export interface LabMetrics {
  totalReturnPct: number
  maxDrawdownPct: number
  sharpe: number
  /** 沒有任何平倉時為 null。 */
  winRatePct: number | null
  closedTrades: number
  trades: number
  /** 1–10；不到 30 個日報酬時為 null。 */
  riskScore: number | null
}

export interface LabForecast {
  from: string
  percentiles: { p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] }
  lossProbPct: number
  halfLossProbPct: number
}

export interface LabResult {
  strategy: string
  target: string
  params: Record<string, number>
  start: string
  equity: number[]
  benchmark: number[]
  trades: LabTrade[]
  metrics: LabMetrics
  benchmarkMetrics: LabMetrics
  forecast: LabForecast
  /** 單一資產策略有槓桿參數時才有：碳分級上限比參數低時是上限。 */
  effectiveLeverage?: number
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isNumList = (x: unknown): x is number[] => Array.isArray(x) && x.every(isNum)

const isStrategy = (x: unknown): boolean =>
  isRecord(x) && isStr(x.id) && (x.kind === 'single' || x.kind === 'portfolio') &&
  (x.rule === null || isStr(x.rule)) &&
  Array.isArray(x.params) && x.params.length > 0 &&
  x.params.every((p) => isRecord(p) && isStr(p.key) && isNumList(p.values) && p.values.length > 0)

const isAsset = (x: unknown): boolean =>
  isRecord(x) && isStr(x.id) && isStr(x.carbonTier) &&
  isNum(x.feeBps) && isNum(x.borrowBpsPerHour) && isNum(x.maxLeverage)

/** 格式版本不符或缺任何欄位就整份不收：畫面寧可顯示「—」，也不畫半份資料。 */
export function parseLabIndex(raw: unknown): LabIndex | null {
  if (!isRecord(raw) || raw.schemaVersion !== LAB_SCHEMA_VERSION) return null
  if (!isRecord(raw.range) || !isStr(raw.range.from) || !isStr(raw.range.to)) return null
  if (!isNum(raw.capitalUsd) || !isNum(raw.martingaleBasePct)) return null
  const f = raw.forecast
  if (!isRecord(f) || !['horizonDays', 'paths', 'blockDays', 'seed'].every((k) => isNum(f[k])) || !isNumList(f.percentiles)) return null
  if (!Array.isArray(raw.assets) || raw.assets.length === 0 || !raw.assets.every(isAsset)) return null
  if (!Array.isArray(raw.baskets) || !raw.baskets.every((b) => isRecord(b) && isStr(b.id) && Array.isArray(b.assets) && b.assets.every(isStr))) return null
  if (!Array.isArray(raw.strategies) || raw.strategies.length === 0 || !raw.strategies.every(isStrategy)) return null
  return raw as unknown as LabIndex
}

const ACTIONS: readonly string[] = ['open', 'close', 'liquidated']

/** 結果檔裡一筆交易是陣列，欄位依序是 heroes/herolab/labdata.py 的 TRADE_FIELDS。 */
function parseTrade(x: unknown): LabTrade | null {
  if (!Array.isArray(x) || x.length !== 7) return null
  const [day, asset, action, isLong, price, marginUsd, pnlUsd] = x
  if (!isNum(day) || !isStr(asset) || !isStr(action) || !ACTIONS.includes(action)) return null
  if (typeof isLong !== 'boolean' || !isNum(price) || !isNum(marginUsd) || !isNumOrNull(pnlUsd)) return null
  return { day, asset, action: action as LabAction, isLong, price, marginUsd, pnlUsd }
}

const isMetrics = (x: unknown): boolean =>
  isRecord(x) &&
  ['totalReturnPct', 'maxDrawdownPct', 'sharpe', 'closedTrades', 'trades'].every((k) => isNum(x[k])) &&
  isNumOrNull(x.winRatePct) && isNumOrNull(x.riskScore)

const BANDS = ['p5', 'p25', 'p50', 'p75', 'p95'] as const

const isForecast = (x: unknown): boolean =>
  isRecord(x) && isStr(x.from) && isNum(x.lossProbPct) && isNum(x.halfLossProbPct) &&
  isRecord(x.percentiles) && BANDS.every((k) => isNumList((x.percentiles as Record<string, unknown>)[k]))

export function parseLabResult(raw: unknown, strategy: string, target: string): LabResult | null {
  if (!isRecord(raw) || raw.schemaVersion !== LAB_SCHEMA_VERSION) return null
  if (raw.strategy !== strategy || raw.target !== target) return null
  if (!isRecord(raw.params) || !Object.values(raw.params).every(isNum) || !isStr(raw.start)) return null
  if (!isNumList(raw.equity) || !isNumList(raw.benchmark) || raw.equity.length !== raw.benchmark.length) return null
  if (!isMetrics(raw.metrics) || !isMetrics(raw.benchmarkMetrics) || !isForecast(raw.forecast)) return null
  if (raw.effectiveLeverage !== undefined && !isNum(raw.effectiveLeverage)) return null
  if (!Array.isArray(raw.trades)) return null
  const trades = raw.trades.map(parseTrade)
  if (trades.some((tr) => tr === null)) return null
  return { ...(raw as unknown as LabResult), trades: trades as LabTrade[] }
}

// ── 讀取 ─────────────────────────────────────────────────────────────────────

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

// 固定從根目錄讀，理由同 heroDataUrl。
const fileUrl = (name: string) => `/data/lab/${name}`

/** 結果檔名：與 heroes/herolab/labdata.py 的 result_name 相同（參數值用 String() 串起來）。 */
export const labResultFile = (strategy: string, target: string, values: number[]): string =>
  `${strategy}__${target}__${values.map(String).join('_')}.json`

/** 讀不到（404、不是 JSON、離線）一律是 null。SPA 的 fallback 會對不存在的檔回 index.html，所以 json() 失敗是常態。 */
async function readJson(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url)
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

export async function fetchLabIndex(fetchImpl: FetchLike = fetch): Promise<LabIndex | null> {
  return parseLabIndex(await readJson(fileUrl('index.json'), fetchImpl))
}

export async function fetchLabResult(
  strategy: string,
  target: string,
  values: number[],
  fetchImpl: FetchLike = fetch,
): Promise<LabResult | null> {
  return parseLabResult(await readJson(fileUrl(labResultFile(strategy, target, values)), fetchImpl), strategy, target)
}

// ── 相近的模擬交易者 ──────────────────────────────────────────────────────────

/**
 * 用同一條規則操作的模擬交易者。只有持倉組合類策略有對應；逐筆策略在鏈上無法被跟單，沒有對應的交易者。
 *
 * rawHeroIndex 是 public/data/heroes/index.json 讀回來的內容，chainId 是目前連線的鏈（未連錢包為 null）。
 * 資料不屬於這條鏈、沒有資料、未連錢包，或資料裡沒有這條規則的交易者，都回傳空陣列——畫面上整塊不顯示。
 */
export function similarTraders(
  strategy: LabStrategy | undefined,
  rawHeroIndex: unknown,
  chainId: number | null,
): HeroSummary[] {
  if (!strategy || strategy.kind !== 'portfolio' || strategy.rule === null) return []
  const heroes = parseHeroIndex(rawHeroIndex, chainId)
  if (!heroes) return []
  return heroes.traders.filter((h) => h.rule === strategy.rule && !isHiddenTrader(chainId, h.address))
}

/**
 * 讀 #309 的績效資料索引，挑出相近的模擬交易者。讀不到就是空陣列。
 * timeCompressed 跟著回傳：公開站的資料是時間壓縮的回放，揭露要用另一段（#344）。
 */
export async function fetchSimilarTraders(
  strategy: LabStrategy | undefined,
  chainId: number | null,
  fetchImpl: FetchLike = fetch,
): Promise<{ traders: HeroSummary[]; timeCompressed: boolean }> {
  if (!strategy || strategy.kind !== 'portfolio' || chainId === null) return { traders: [], timeCompressed: false }
  const raw = await readJson(heroDataUrl(chainId, 'index.json'), fetchImpl)
  const index = parseHeroIndex(raw, chainId)
  return { traders: similarTraders(strategy, raw, chainId), timeCompressed: index?.timeCompressed ?? false }
}

/** 依索引裡的參數格點，把每個參數夾回合法值（網址帶進來的值不在格點上時用第一個值）。 */
export function snapParams(strategy: LabStrategy, wanted: Record<string, number | undefined>): number[] {
  return strategy.params.map((p) => {
    const v = wanted[p.key]
    return v !== undefined && p.values.includes(v) ? v : p.values[0]
  })
}

/** 回測第 day 天的日期（YYYY-MM-DD）。資料是每個日曆日一筆。 */
export function dayToDate(start: string, day: number): string {
  const d = new Date(`${start}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + day)
  return d.toISOString().slice(0, 10)
}
