import { t, interpolate } from 'src/locales'

import { SIGNAL_API_URL } from './signalApi'

// 對照指數（Benchmark，見 frontend/CONTEXT.md 的 Benchmark 詞條）API 的前端
// client。後端在 agent/signal-api/src/benchmarks.ts，端點
// GET /benchmarks?date=YYYY-MM-DD，跟 /candles 一樣不在付費牆後面。
//
// 開發時指向本機 signal-api，不是 SIGNAL_API_URL 的線上預設值——理由跟
// candles.ts 的 CANDLES_API_URL 完全一樣：/benchmarks 是後加的路由，部署到
// Vercel 前打線上端點只會拿到 404，而那個 404 對正在開發的人沒有指向性。
const DEV_API_URL = 'http://localhost:4021'
const BENCHMARKS_API_URL: string = (import.meta.env.VITE_SIGNAL_API_URL as string | undefined)
  ? SIGNAL_API_URL
  : import.meta.env.DEV
    ? DEV_API_URL
    : SIGNAL_API_URL

export type BenchmarkKey = 'spx' | 'gold' | 'btc'

/** 顯示順序,跟後端 BENCHMARK_KEYS 分開維護——兩個 workspace 沒有共用型別的管道。 */
export const BENCHMARK_KEYS: BenchmarkKey[] = ['spx', 'gold', 'btc']

export interface BenchmarkPoint {
  value: number
  at: number
}

export interface BenchmarkAtDatePoint extends BenchmarkPoint {
  date: string
}

export interface BenchmarkResult {
  ok: boolean
  key: BenchmarkKey
  name: string
  symbol: string
  current?: BenchmarkPoint
  atDate?: BenchmarkAtDatePoint
  error?: string
}

export interface BenchmarksResponse {
  ok: true
  asOf: number
  requestedDate: string | null
  benchmarks: Record<BenchmarkKey, BenchmarkResult>
}

export class BenchmarksFetchError extends Error {}

/**
 * 抓對照指數。`date` 是「當日漲跌」的比較基準——傳昨天，後端會退到當天或
 * 之前最近一個有收盤價的交易日（週末／假日自動處理，見後端 benchmarks.ts）。
 */
export async function fetchBenchmarks(date: string, signal?: AbortSignal): Promise<BenchmarksResponse> {
  const url = `${BENCHMARKS_API_URL}/benchmarks?date=${encodeURIComponent(date)}`

  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (err) {
    // AbortError 要原樣往上丟,呼叫端才分得出「被取消」與「真的失敗」。
    if ((err as Error).name === 'AbortError') throw err
    throw new BenchmarksFetchError(
      interpolate(
        import.meta.env.DEV
          ? t.portfolio.allocation.benchmark.unreachableDev
          : t.portfolio.allocation.benchmark.unreachable,
        { url: BENCHMARKS_API_URL },
      ),
    )
  }

  if (!res.ok) {
    // 錯誤訊息一定要帶出「打去哪裡」——少了它,404 看起來像前端路徑寫錯,
    // 實際上多半是那個部署還沒有這條路由。
    let msg = interpolate(
      res.status === 404
        ? t.portfolio.allocation.benchmark.httpError404
        : t.portfolio.allocation.benchmark.httpError,
      { status: res.status, url: BENCHMARKS_API_URL },
    )
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* 非 JSON 錯誤頁 */
    }
    throw new BenchmarksFetchError(msg)
  }

  return (await res.json()) as BenchmarksResponse
}

/**
 * 昨天的日期（UTC）,YYYY-MM-DD——當「當日漲跌」的比較基準:現價 vs 前一個
 * 交易日收盤。永遠嚴格早於現在,不會撞到後端 date 參數「不可為未來日期」的
 * 驗證,無論呼叫端在哪個時區。
 */
export function yesterdayUtc(now: number = Date.now()): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10)
}

/**
 * 把 current 相對 atDate 的漲跌算成百分比。任一項缺資料,或 atDate 是 0
 * （不該發生,但除以 0 絕不能悄悄變成 Infinity 顯示在畫面上）,回傳 null,
 * 由呼叫端顯示「—」而不是編一個假的百分比。
 */
export function pctChangeOf(current?: BenchmarkPoint, atDate?: BenchmarkAtDatePoint): number | null {
  if (!current || !atDate || atDate.value === 0) return null
  return ((current.value - atDate.value) / atDate.value) * 100
}

/**
 * 三個指數的顯示格式不一樣：S&P 500 是點數,不是錢；黃金與比特幣報價本來就
 * 是 USD。
 */
export function formatBenchmarkValue(key: BenchmarkKey, value: number): string {
  const num = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return key === 'spx' ? num : `$${num}`
}

/** 帶正負號的百分比,小數點後兩位——BenchmarkStrip 與「你 vs 大盤」共用同一種格式。 */
export function formatPct(pct: number): string {
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
}
