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
 * 顯示順序,跟後端 BENCHMARK_KEYS 分開維護——兩個 workspace 沒有共用型別的管道。
 * 順序刻意對齊四個 Asset Class（股債金幣）。
 */
export const BENCHMARK_KEYS: BenchmarkKey[] = ['spx', 'bond', 'gold', 'btc']

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
  /** 當日漲跌的基準：比 current 更早的那一根收盤。見後端同名欄位的註解。 */
  previousClose?: BenchmarkPoint
  /** 近一個月日收盤,舊→新。走勢縮圖用。 */
  series?: number[]
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
 * 把一串收盤價轉成 SVG polyline 的 points 字串。
 *
 * 走勢縮圖只有一條線,沒有座標軸、tooltip、legend,所以不走 recharts——那些
 * 功能在這裡的價值是零,而純 SVG 讓「幾何怎麼算」變成一個可以被測試釘住的
 * 純函式,跟這個目錄其他計算一致。
 *
 * 空序列回空字串（呼叫端據此不畫圖）。整段價格完全沒動時(max === min)畫在
 * 垂直正中央,而不是讓 (v - min) / 0 變成 NaN 汙染整條路徑。
 */
export function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return ''
  if (values.length === 1) {
    const mid = height / 2
    return `0,${mid} ${width},${mid}`
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const stepX = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * stepX
      // SVG 的 y 軸向下,所以價格高 = y 小。
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}
