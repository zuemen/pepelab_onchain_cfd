// 參考價多源見證看板（/oracle）的資料層。
//
// 兩個來源：
//   1. 鏈上：交易所讀的 oracle（MockOracle）的 getPrice → (price 8-dec, updatedAt)。
//      updatedAt 是**寫入時間**；MockOracle 不存來源的報價時間，畫面要照實說明。
//   2. 鏈下：signal-api 的免費唯讀端點 GET /reference-prices（瀏覽器直接打 Yahoo／Nasdaq
//      會被 CORS 擋，CoinGecko 有頻率限制；signal-api 本來就在 CSP connect-src 裡）。
// 價格年齡用最新區塊時間計算（與合約 _requireFresh 同一個時鐘）；讀不到才退回本機時鐘並標示。

import type { AssetSymbol } from 'src/contracts/addresses'

import { ASSET_IDS } from 'src/contracts/addresses'

import { withTimeout } from './safeRead'
import { mapLimit, RPC_CONCURRENCY } from './rpcBatch'

// ── 鏈上 ─────────────────────────────────────────────────────────────────────

export interface OnchainQuote {
  status: 'ok' | 'failed'
  /** USD（oracle 是 8 位小數）。 */
  price: number | null
  /** 寫入時間（unix 秒）。 */
  updatedAt: number | null
}

export interface OnchainDeps {
  getPrice: (assetId: string) => Promise<readonly [bigint, bigint] | { 0: bigint; 1: bigint }>
  /** 最新區塊的 timestamp（秒）。 */
  latestBlockTime: () => Promise<number>
  /** 合約的 maxPriceAge（秒）。 */
  maxPriceAge?: () => Promise<bigint | number>
  timeoutMs?: number
}

export interface OnchainSnapshot {
  quotes: Record<string, OnchainQuote>
  /** 最新區塊時間；讀不到為 null（呼叫端改用本機時鐘並標示）。 */
  blockTime: number | null
  maxPriceAge: number | null
}

export async function loadOnchainQuotes(deps: OnchainDeps, symbols: readonly AssetSymbol[]): Promise<OnchainSnapshot> {
  const ms = deps.timeoutMs ?? 8000
  const [blockTime, maxPriceAge, rows] = await Promise.all([
    withTimeout(deps.latestBlockTime(), ms).then(
      (v) => (Number.isFinite(v) && v > 0 ? v : null),
      () => null
    ),
    deps.maxPriceAge
      ? withTimeout(deps.maxPriceAge(), ms).then(
          (v) => Number(v),
          () => null
        )
      : Promise.resolve(null),
    mapLimit(symbols, RPC_CONCURRENCY, async (symbol) => {
      try {
        const r = await withTimeout(deps.getPrice(ASSET_IDS[symbol]), ms)
        const price8 = r[0]
        const updatedAt = Number(r[1])
        if (price8 <= 0n) return [symbol, { status: 'failed', price: null, updatedAt: null }] as const
        return [symbol, { status: 'ok', price: Number(price8) / 1e8, updatedAt }] as const
      } catch {
        return [symbol, { status: 'failed', price: null, updatedAt: null }] as const
      }
    }),
  ])
  return { quotes: Object.fromEntries(rows) as Record<string, OnchainQuote>, blockTime, maxPriceAge }
}

/** 價格年齡（秒）。任何一邊缺就是 null；時鐘偏差造成的負值算 0。 */
export function priceAgeSec(nowSec: number | null, updatedAt: number | null): number | null {
  if (nowSec === null || updatedAt === null || updatedAt <= 0) return null
  return Math.max(0, nowSec - updatedAt)
}

// ── 鏈下（signal-api /reference-prices）──────────────────────────────────────

export type RefProvider = 'coingecko' | 'yahoo' | 'coinbase' | 'nasdaq' | 'goldapi'
export type RefRole = 'keeper-primary' | 'keeper-secondary' | 'independent'

export interface RefSourceQuote {
  provider: RefProvider
  ticker: string
  role: RefRole
  price: number | null
  quoteTime: number | null
  quoteTimeText?: string
  fetchedAt: number
  error?: string
}

export interface RefAsset {
  symbol: string
  sources: RefSourceQuote[]
  singleSource: boolean
  okCount: number
  spreadBps: number | null
  note?: string
}

export interface RefReport {
  generatedAt: number
  assets: Record<string, RefAsset>
}

const PROVIDERS: readonly RefProvider[] = ['coingecko', 'yahoo', 'coinbase', 'nasdaq', 'goldapi']
const ROLES: readonly RefRole[] = ['keeper-primary', 'keeper-secondary', 'independent']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 防禦式解析：伺服器回什麼都不信，形狀不對的來源整筆丟掉。整份不像報表回 null。 */
export function parseReferenceReport(json: unknown): RefReport | null {
  if (!isObj(json) || !isObj(json.assets)) return null
  const generatedAt = numOrNull(json.generatedAt)
  if (generatedAt === null) return null
  const assets: Record<string, RefAsset> = {}
  for (const [symbol, raw] of Object.entries(json.assets)) {
    if (!isObj(raw) || !Array.isArray(raw.sources)) continue
    const sources: RefSourceQuote[] = []
    for (const s of raw.sources) {
      if (!isObj(s)) continue
      if (!PROVIDERS.includes(s.provider as RefProvider) || !ROLES.includes(s.role as RefRole)) continue
      const price = numOrNull(s.price)
      sources.push({
        provider: s.provider as RefProvider,
        ticker: typeof s.ticker === 'string' ? s.ticker : '',
        role: s.role as RefRole,
        price: price !== null && price > 0 ? price : null,
        quoteTime: numOrNull(s.quoteTime),
        ...(typeof s.quoteTimeText === 'string' ? { quoteTimeText: s.quoteTimeText } : {}),
        fetchedAt: numOrNull(s.fetchedAt) ?? generatedAt,
        ...(typeof s.error === 'string' ? { error: s.error } : {}),
      })
    }
    assets[symbol] = {
      symbol,
      sources,
      singleSource: raw.singleSource === true || sources.length < 2,
      okCount: sources.filter((s) => s.price !== null).length,
      spreadBps: numOrNull(raw.spreadBps),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    }
  }
  return { generatedAt, assets }
}

export type RefFetchResult = { status: 'ok'; report: RefReport } | { status: 'failed'; reason: string }

/** 抓 /reference-prices。網路錯誤、非 2xx、形狀不對都回 failed（附短原因），永遠不 throw。 */
export async function fetchReferencePrices(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 12_000
): Promise<RefFetchResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/reference-prices`
  try {
    const res = await withTimeout(fetchImpl(url, { headers: { Accept: 'application/json' } }), timeoutMs)
    if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` }
    const report = parseReferenceReport(await withTimeout(res.json() as Promise<unknown>, timeoutMs))
    return report ? { status: 'ok', report } : { status: 'failed', reason: 'bad response' }
  } catch (e) {
    const msg = (e as { message?: string } | null)?.message ?? ''
    return { status: 'failed', reason: msg.includes('timeout') ? 'timeout' : 'network' }
  }
}

// ── 合成 ─────────────────────────────────────────────────────────────────────

/** 相對鏈上價格的偏離（bps，帶正負號：來源比鏈上高為正）。任一邊缺為 null。 */
export function deviationBps(onchain: number | null, ref: number | null): number | null {
  if (onchain === null || ref === null || !(onchain > 0) || !(ref > 0)) return null
  return Math.round(((ref - onchain) / onchain) * 10_000)
}

export type DeviationLevel = 'ok' | 'warn' | 'alert'

/** < 50 bps 一致；< 200 bps 偏離；以上偏離過大。keeper 的寫價門檻是 10 bps，熔斷是 2,000 bps。 */
export function deviationLevel(bps: number | null): DeviationLevel | null {
  if (bps === null) return null
  const a = Math.abs(bps)
  if (a < 50) return 'ok'
  if (a < 200) return 'warn'
  return 'alert'
}

export interface WitnessSource extends RefSourceQuote {
  deviationBps: number | null
}

export interface WitnessRow {
  symbol: AssetSymbol
  onchain: OnchainQuote
  ageSec: number | null
  /** null = 鏈下報表沒有這檔（或整份讀不到）。 */
  sources: WitnessSource[] | null
  singleSource: boolean
  okCount: number
  totalSources: number
  spreadBps: number | null
  /** 與鏈上偏離最大的那個來源（絕對值）。 */
  maxDeviationBps: number | null
  note?: string
}

export function buildWitnessRows(
  symbols: readonly AssetSymbol[],
  onchain: OnchainSnapshot | null,
  ref: RefReport | null,
  localNowSec: number
): WitnessRow[] {
  const now = onchain?.blockTime ?? localNowSec
  return symbols.map((symbol) => {
    const q: OnchainQuote = onchain?.quotes[symbol] ?? { status: 'failed', price: null, updatedAt: null }
    const a = ref?.assets[symbol]
    const sources = a ? a.sources.map((s) => ({ ...s, deviationBps: deviationBps(q.price, s.price) })) : null
    const devs = (sources ?? []).map((s) => s.deviationBps).filter((d): d is number => d !== null)
    const maxDeviationBps = devs.length ? devs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m)) : null
    return {
      symbol,
      onchain: q,
      ageSec: priceAgeSec(now, q.updatedAt),
      sources,
      singleSource: a ? a.singleSource : false,
      okCount: a?.okCount ?? 0,
      totalSources: a?.sources.length ?? 0,
      spreadBps: a?.spreadBps ?? null,
      maxDeviationBps,
      ...(a?.note ? { note: a.note } : {}),
    }
  })
}

/** 秒數 → 粗略的人類可讀單位（給 catalog 的 {n} 用）。 */
export function ageUnit(sec: number): { unit: 'seconds' | 'minutes' | 'hours' | 'days'; n: number } {
  if (sec < 120) return { unit: 'seconds', n: Math.round(sec) }
  if (sec < 2 * 3600) return { unit: 'minutes', n: Math.round(sec / 60) }
  if (sec < 2 * 86_400) return { unit: 'hours', n: Math.round((sec / 3600) * 10) / 10 }
  return { unit: 'days', n: Math.round((sec / 86_400) * 10) / 10 }
}
