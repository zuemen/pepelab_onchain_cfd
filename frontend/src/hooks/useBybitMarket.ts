import { useRef, useState, useEffect } from 'react'

import {
  fetchOrderBook,
  fetchRecentTrades,
  type PublicTrade,
  type OrderBookSnapshot,
} from 'src/lib/pepefi/bybitMarket'

// 訂單簿與近期成交的輪詢。
//
// `enabled` 不是裝飾用的：訂單簿在窄版面是收在分頁裡的，沒展開時整條輪詢都不該
// 建立。用 CSS 藏起來的元件還是會照打 API，這裡從源頭關掉。

const BOOK_POLL_MS = 1_500
const TRADES_POLL_MS = 2_500

interface FeedState<T> {
  data: T
  error: string | null
  loading: boolean
}

/**
 * 共用的輪詢骨架：立刻抓一次，之後定時更新，卸載/切換時 abort。
 *
 * 失敗時保留既有資料——盤口閃成空白比停在一秒前的價格更糟。
 */
function usePolledFeed<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  initial: T,
  intervalMs: number,
  key: string | undefined,
  enabled: boolean,
): FeedState<T> {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!key || !enabled) {
      setData(initial)
      setError(null)
      setLoading(false)
      return undefined
    }

    const ac = new AbortController()
    let alive = true
    setLoading(true)
    setData(initial)

    const tick = async () => {
      try {
        const next = await fetcherRef.current(ac.signal)
        if (!alive || ac.signal.aborted) return
        setData(next)
        setError(null)
      } catch (err) {
        if ((err as Error).name === 'AbortError' || !alive) return
        setError((err as Error).message)
      } finally {
        if (alive && !ac.signal.aborted) setLoading(false)
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), intervalMs)

    return () => {
      alive = false
      ac.abort()
      clearInterval(timer)
    }
    // initial 是穩定的模組層常數，放進依賴只會讓 effect 每次重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, intervalMs])

  return { data, error, loading }
}

const EMPTY_BOOK: OrderBookSnapshot = { bids: [], asks: [] }
const EMPTY_TRADES: PublicTrade[] = []

export function useOrderBook(symbol: string | undefined, enabled: boolean) {
  return usePolledFeed<OrderBookSnapshot>(
    (signal) => fetchOrderBook(symbol!, 20, signal),
    EMPTY_BOOK,
    BOOK_POLL_MS,
    symbol,
    enabled,
  )
}

export function useRecentTrades(symbol: string | undefined, enabled: boolean) {
  return usePolledFeed<PublicTrade[]>(
    (signal) => fetchRecentTrades(symbol!, 30, signal),
    EMPTY_TRADES,
    TRADES_POLL_MS,
    symbol,
    enabled,
  )
}
