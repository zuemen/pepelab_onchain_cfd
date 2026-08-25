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

export type BenchmarkKey = 'spx' | 'bond' | 'gold' | 'btc'

/**
 * 畫面上由左到右的顯示順序。這份清單就是唯一的順序來源——對照指數列與
 * 「你 vs 大盤」都照它迭代,改這裡兩邊會同步變動,後端不參與排序。
 */
export const BENCHMARK_KEYS: BenchmarkKey[] = ['btc', 'spx', 'gold', 'bond']

export interface BenchmarkPoint {
  value: number
  at: number
}

export interface BenchmarkAtDatePoint extends BenchmarkPoint {
  date: string
}

/** 走勢圖的一個點：unix 秒 + 收盤價。 */
export interface SeriesPoint {
  t: number
  c: number
}

export interface BenchmarkResult {
  ok: boolean
  key: BenchmarkKey
  name: string
  symbol: string
  current?: BenchmarkPoint
  /** 當日漲跌的基準：比 current 更早的那一根收盤。見後端同名欄位的註解。 */
  previousClose?: BenchmarkPoint
  /** 近一個月日收盤,舊→新。走勢圖用,帶時間戳供橫軸使用。 */
  series?: SeriesPoint[]
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
 * 抓對照指數。
 *
 * `date` 只給「你 vs 大盤」用——它是錨定日,後端會回該日或之前最近一個交易日
 * 的收盤（atDate）。省略時後端不做那次查詢:當日漲跌用的是 previousClose,
 * 已經包含在同一次回應裡,不需要再指定任何日期。
 */
export async function fetchBenchmarks(date?: string, signal?: AbortSignal): Promise<BenchmarksResponse> {
  const url = date
    ? `${BENCHMARKS_API_URL}/benchmarks?date=${encodeURIComponent(date)}`
    : `${BENCHMARKS_API_URL}/benchmarks`

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
 * 把 current 相對某個基準點的漲跌算成百分比。
 *
 * 基準點有兩種用途,型別刻意只要求 BenchmarkPoint（BenchmarkAtDatePoint 繼承
 * 它,所以兩種都收）:當日漲跌用 previousClose,「你 vs 大盤」用錨定日的
 * atDate。這個函式只讀 value,不在意基準是怎麼挑出來的。
 *
 * 任一項缺資料,或基準值是 0（不該發生,但除以 0 絕不能悄悄變成 Infinity
 * 顯示在畫面上）,回傳 null,由呼叫端顯示「—」而不是編一個假的百分比。
 */
export function pctChangeOf(current?: BenchmarkPoint, baseline?: BenchmarkPoint): number | null {
  if (!current || !baseline || baseline.value === 0) return null
  return ((current.value - baseline.value) / baseline.value) * 100
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

/**
 * 縱軸的價格刻度。四個指數的量級差三個數量級（美債 ~82、比特幣 ~80,000）,
 * 同一個格式套下去不是刻度擠成一團就是精度全失,所以依量級縮寫。
 *
 * 用 UTC 無關的純數值運算,結果只由輸入決定,可以被測試釘住。
 */
export function formatAxisPrice(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 10_000) return `${(value / 1000).toFixed(0)}k`
  if (abs >= 1_000) return `${(value / 1000).toFixed(1)}k`
  if (abs >= 100) return value.toFixed(0)
  return value.toFixed(1)
}

/**
 * 橫軸的日期刻度：unix 秒 → MM/DD。
 *
 * 固定用 UTC,不看瀏覽器時區——收盤時間戳本來就是以交易日為單位,讓它隨使用者
 * 時區前後跳一天，會出現「某一天憑空消失或重複」的刻度。
 */
export function formatAxisDate(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${mm}/${dd}`
}

/**
 * 走勢線本身的方向:月末收盤高於月初就是上漲。
 *
 * 圖的顏色跟著這個走,而不是跟著當日漲跌——線畫的是一個月,用「今天漲跌」
 * 決定整條線的顏色,會出現「綠色但整體向下」這種自我矛盾的圖。
 *
 * 資料不足兩點時回 null:一個點沒有方向可言,呼叫端應退回中性色而不是猜。
 */
export function seriesDirection(series: SeriesPoint[]): boolean | null {
  if (series.length < 2) return null
  return series[series.length - 1].c >= series[0].c
}

/**
 * 縱軸的範圍。刻意不從 0 起算:這是走勢圖不是量體圖,從 0 起算會把一個月的
 * 波動壓成一條直線。上下各留 5% 餘裕,線才不會貼著邊框。
 *
 * 整段價格完全沒動時(max === min)強制撐開一個區間,否則 recharts 會拿到
 * 上下界相同的 domain,整條線畫不出來。
 */
export function priceDomainOf(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1
    return [min - pad, max + pad]
  }
  const pad = (max - min) * 0.05
  return [min - pad, max + pad]
}
