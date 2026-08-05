import { SIGNAL_API_URL } from './signalApi'

/**
 * K 線 API 的實際位址。
 *
 * 開發時預設指向本機的 signal-api，而不是沿用 SIGNAL_API_URL 的線上預設值。
 *
 * 原因：SIGNAL_API_URL 的預設是已上線的 Vercel 部署，那份不一定跟著本機的
 * src/ 同步——/candles 是後加的路由，還沒重新部署前打過去只會拿到 404，而
 * 「404」對正在開發的人完全沒有指向性（看起來像前端寫錯路徑，實際上是後端
 * 沒有那條路由）。指向本機至少失敗訊息會是「連不上，請先啟動 signal-api」，
 * 是可以照著做的事。
 *
 * 其他頁面（x402 文件、agent 監控、試買）仍然共用 SIGNAL_API_URL 的行為，
 * 不受影響——它們打的端點線上早就有了。
 *
 * 三種情況都能覆寫：設 VITE_SIGNAL_API_URL 就一律照它走。
 */
const DEV_API_URL = 'http://localhost:4021'
const CANDLES_API_URL: string = (import.meta.env.VITE_SIGNAL_API_URL as string | undefined)
  ? SIGNAL_API_URL
  : import.meta.env.DEV
    ? DEV_API_URL
    : SIGNAL_API_URL

// K 線 API 的前端 client。後端在 agent/signal-api/src/candles.ts，
// 端點 GET /candles/:symbol?interval=&limit=，與 x402 付費端點共用同一個服務
// 但不在付費牆後面。

/** 時間單位是「秒」——lightweight-charts 的 UTCTimestamp 就是秒。 */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type SourceKind = 'exchange' | 'delayed' | 'simulated'

export interface SourceInfo {
  kind: SourceKind
  name: string
  url: string
  attribution: string
  reference: string
  fetchedAt: number
}

export interface CandleResponse {
  ok: true
  symbol: string
  assetId?: string
  underlying: string
  interval: Interval
  candles: Candle[]
  source: SourceInfo
  /** 沒拿到第一順位來源，已退到下一級。 */
  degraded?: boolean
  sourceError?: string
  disclaimer: string
}

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]

/** 每個時間框一根蠟燭幾秒。用來判斷最後一根是否已經收掉。 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

export const DEFAULT_INTERVAL: Interval = '1h'

export class CandleFetchError extends Error {}

/**
 * 抓 K 線。
 *
 * @param symbol 合成資產代號或 bytes32 assetId，後端兩種都收
 * @param signal 換標的 / 換時間框時用來取消還在飛的請求——否則慢的那個回來會蓋掉快的
 */
export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit: number,
  signal?: AbortSignal,
): Promise<CandleResponse> {
  const url = `${CANDLES_API_URL}/candles/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}`

  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (err) {
    // AbortError 要原樣往上丟，呼叫端才分得出「被取消」與「真的失敗」。
    if ((err as Error).name === 'AbortError') throw err
    throw new CandleFetchError(
      `無法連線到行情 API（${CANDLES_API_URL}）。` +
        (import.meta.env.DEV ? '請先啟動 signal-api：cd agent/signal-api && npx tsx src/index.ts' : ''),
    )
  }

  if (!res.ok) {
    // 錯誤訊息一定要帶出「打去哪裡」。少了它，404 看起來像前端路徑寫錯，
    // 實際上多半是那個部署還沒有這條路由。
    let msg = `行情 API 回 ${res.status}（${CANDLES_API_URL}）`
    if (res.status === 404) {
      msg += ' — 該部署可能尚未包含 /candles 路由，需重新部署 signal-api'
    }
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* 非 JSON 錯誤頁 */
    }
    throw new CandleFetchError(msg)
  }

  return (await res.json()) as CandleResponse
}
