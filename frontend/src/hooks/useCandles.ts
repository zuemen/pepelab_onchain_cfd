import { useRef, useState, useEffect, useCallback } from 'react'

import {
  fetchCandles,
  INTERVAL_SECONDS,
  type Candle,
  type Interval,
  type SourceInfo,
} from 'src/lib/pepefi/candles'

const HISTORY_LIMIT = 300

/**
 * 輪詢間隔：跟著時間框走。
 *
 * 1m 線每分鐘才會有「新的一根」，但當前那根的最高/最低/收盤一直在動，所以更新
 * 頻率要看的是「使用者多久能看到最新價」，不是「多久出現新蠟燭」。
 *
 * 後端 TTL 設成這裡的一半（見 candles.ts 的 TTL_MS），所以最差情況的資料延遲
 * 約是 POLL_MS × 1.5。輪詢只抓尾巴 3 根，單次成本很低。
 *
 * 再快就該換 WebSocket 了——REST 輪詢每秒好幾次只是在燒 serverless invocation，
 * 而且仍然是拉取式的，不會比推送即時。
 */
const POLL_MS: Record<Interval, number> = {
  '1m': 6_000,
  '5m': 10_000,
  '15m': 20_000,
  '1h': 30_000,
  '4h': 60_000,
  '1d': 120_000,
}

/** 輪詢時只要最後幾根：新的一根 + 還在動的當前根，多抓沒有意義。 */
const TAIL_LIMIT = 3

export interface CandleFeed {
  candles: Candle[]
  source: SourceInfo | null
  degraded: boolean
  sourceError?: string
  underlying: string
  loading: boolean
  error: string | null
  /** 最後一根的收盤價，也就是圖上最右邊那個價。 */
  last?: number
}

/**
 * 取得某標的 / 時間框的 K 線，並持續更新最後幾根。
 *
 * 兩件刻意的設計：
 *   1. 輪詢只抓尾巴（TAIL_LIMIT 根）再併回既有陣列，不整段重抓 300 根。
 *   2. 換標的或時間框時 abort 掉還在飛的請求——不然慢的那個回來會蓋掉新的，
 *      圖表會閃一下別的標的的資料。
 */
export function useCandles(symbol: string, interval: Interval): CandleFeed {
  const [candles, setCandles] = useState<Candle[]>([])
  const [source, setSource] = useState<SourceInfo | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [sourceError, setSourceError] = useState<string | undefined>()
  const [underlying, setUnderlying] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 讓輪詢讀得到「現在有沒有資料」，又不用把 candles 放進 effect 的依賴裡
  // （放進去每次更新都會重建 interval）。
  const hasData = useRef(false)

  const merge = useCallback((incoming: Candle[]) => {
    setCandles((prev) => {
      if (!prev.length) return incoming
      const byTime = new Map(prev.map((k) => [k.t, k]))
      // 同一根時間戳直接覆蓋——當前這根的 h/l/c/v 本來就會一直變。
      for (const k of incoming) byTime.set(k.t, k)
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t)
      return merged.slice(-HISTORY_LIMIT)
    })
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined

    // 換標的 / 換時間框 = 完全不同的資料，先清空再抓，不要讓舊圖留在畫面上。
    hasData.current = false
    setCandles([])
    setSource(null)
    setDegraded(false)
    setSourceError(undefined)
    setLoading(true)
    setError(null)

    const load = async (tail: boolean) => {
      try {
        const res = await fetchCandles(
          symbol,
          interval,
          tail ? TAIL_LIMIT : HISTORY_LIMIT,
          ac.signal,
        )
        if (ac.signal.aborted) return
        if (tail) merge(res.candles)
        else setCandles(res.candles)
        setSource(res.source)
        setDegraded(!!res.degraded)
        setSourceError(res.sourceError)
        setUnderlying(res.underlying)
        setError(null)
        hasData.current = true
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // 輪詢失敗時保留畫面上既有的圖，只有初次載入失敗才顯示錯誤。
        if (!hasData.current) setError((err as Error).message)
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }

    void load(false)
    timer = setInterval(() => {
      // 初次載入還沒成功就重試整段，不要用尾巴模式補一個空陣列。
      void load(hasData.current)
    }, POLL_MS[interval])

    return () => {
      ac.abort()
      if (timer) clearInterval(timer)
    }
  }, [symbol, interval, merge])

  const lastCandle = candles.length ? candles[candles.length - 1] : undefined

  return {
    candles,
    source,
    degraded,
    sourceError,
    underlying,
    loading,
    error,
    last: lastCandle?.c,
  }
}

/** 給呼叫端判斷「當前這根是否還在跳動」。 */
export function isCandleOpen(candle: Candle, interval: Interval): boolean {
  return Date.now() / 1000 < candle.t + INTERVAL_SECONDS[interval]
}
