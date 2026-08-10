import { useRef, useState, useEffect, useCallback } from 'react'

import {
  fetchCandles,
  INTERVAL_SECONDS,
  type Candle,
  type Interval,
  type SourceInfo,
} from 'src/lib/pepefi/candles'

/** 初次載入的根數。 */
const HISTORY_LIMIT = 300

/** 每次往回翻一頁的根數。 */
const PAGE_LIMIT = 300

/**
 * 記憶體裡最多保留幾根。
 *
 * 舊版是 300，而且合併時無條件 `slice(-300)`——那等於一邊往回抓、一邊把抓到的
 * 舊資料丟掉，永遠拉不遠。
 *
 * 仍然要有上限：setData 的成本跟陣列長度成正比，無上限會愈捲愈頓。但上限本身
 * 帶來一個陷阱——截斷是從**最舊**那端切的，所以一旦裝滿，剛往回抓來的資料會在
 * 合併時立刻被丟掉，游標退回原處、下次再抓同一段，變成對同一頁無限重抓。
 * loadOlder 因此必須在滿載時停手（見 atCapacity）。
 */
const MAX_BARS = 20_000

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
  /** 正在往回抓更早的資料。 */
  loadingOlder: boolean
  /** 已經沒有更早的資料了，圖表不必再問。 */
  exhausted: boolean
  /** 記憶體裡的蠟燭已達 MAX_BARS，不再往回抓（跟「沒有更早資料」是不同狀況）。 */
  atCapacity: boolean
  /** 圖表捲到最左邊時呼叫。重複呼叫是安全的，內部自己擋。 */
  loadOlder: () => void
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

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [atCapacity, setAtCapacity] = useState(false)

  // 讓輪詢讀得到「現在有沒有資料」，又不用把 candles 放進 effect 的依賴裡
  // （放進去每次更新都會重建 interval）。
  const hasData = useRef(false)
  // 往回翻頁用的即時狀態。用 ref 而不是 state，因為圖表的捲動回呼可能在同一幀
  // 內連續觸發好幾次，等 state 更新才擋已經太遲——會同時發出好幾個重複請求。
  const olderInFlight = useRef(false)
  const exhaustedRef = useRef(false)
  const oldestRef = useRef<number | undefined>(undefined)
  const countRef = useRef(0)
  // 每次換標的／時間框就 +1，讓還在飛的舊翻頁請求回來時知道自己過期了。
  const feedIdRef = useRef(0)

  const merge = useCallback((incoming: Candle[]) => {
    setCandles((prev) => {
      if (!prev.length) return incoming
      const byTime = new Map(prev.map((k) => [k.t, k]))
      // 同一根時間戳直接覆蓋——當前這根的 h/l/c/v 本來就會一直變。
      for (const k of incoming) byTime.set(k.t, k)
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t)
      const capped = merged.length > MAX_BARS ? merged.slice(-MAX_BARS) : merged
      oldestRef.current = capped[0]?.t
      countRef.current = capped.length
      return capped
    })
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined

    // 換標的 / 換時間框 = 完全不同的資料，先清空再抓，不要讓舊圖留在畫面上。
    hasData.current = false
    feedIdRef.current += 1
    olderInFlight.current = false
    exhaustedRef.current = false
    oldestRef.current = undefined
    countRef.current = 0
    setCandles([])
    setSource(null)
    setDegraded(false)
    setSourceError(undefined)
    setLoading(true)
    setError(null)
    setLoadingOlder(false)
    setExhausted(false)
    setAtCapacity(false)

    const load = async (tail: boolean) => {
      try {
        const res = await fetchCandles(
          symbol,
          interval,
          tail ? TAIL_LIMIT : HISTORY_LIMIT,
          ac.signal,
        )
        if (ac.signal.aborted) return
        if (tail) {
          merge(res.candles)
        } else {
          setCandles(res.candles)
          oldestRef.current = res.candles[0]?.t
          countRef.current = res.candles.length
        }
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

  /**
   * 往回抓一頁更早的資料。
   *
   * 圖表的捲動回呼會非常頻繁地觸發，所以這裡的防護全部用 ref 做即時判斷：
   *   - olderInFlight：同一時間只允許一個請求在飛
   *   - exhaustedRef：後端說沒有更早的了就永遠不再問
   *   - oldestRef：以目前最舊那根當游標；沒有資料時不該翻頁
   *
   * 這個函式刻意不放進 useEffect 的依賴，也不 abort——它抓到的是純歷史資料，
   * 就算使用者中途換了標的，回來的資料會被 feedId 擋掉而不是污染新的圖。
   */
  const loadOlder = useCallback(() => {
    if (olderInFlight.current || exhaustedRef.current) return
    // 滿載時停手。截斷是從最舊那端切的，繼續抓只會抓回來又被丟掉，對同一頁
    // 無限重試——實測會停在「根數不變、最舊時間不推進、但請求一直發」。
    if (countRef.current >= MAX_BARS) {
      setAtCapacity(true)
      return
    }
    const cursor = oldestRef.current
    if (!cursor || !hasData.current) return

    const myFeed = feedIdRef.current
    olderInFlight.current = true
    setLoadingOlder(true)

    void (async () => {
      try {
        const res = await fetchCandles(symbol, interval, PAGE_LIMIT, undefined, cursor)
        // 期間換過標的／時間框 → 這批資料已經不屬於現在這張圖，直接丟掉。
        if (myFeed !== feedIdRef.current) return

        if (res.exhausted || !res.candles.length) {
          exhaustedRef.current = true
          setExhausted(true)
          return
        }
        merge(res.candles)
      } catch {
        // 往回翻頁失敗不該影響已經畫出來的圖，也不該顯示成整張圖壞掉。
        // 不標 exhausted：使用者再捲一次還可以重試。
      } finally {
        if (myFeed === feedIdRef.current) setLoadingOlder(false)
        olderInFlight.current = false
      }
    })()
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
    loadingOlder,
    exhausted,
    atCapacity,
    loadOlder,
  }
}

/** 給呼叫端判斷「當前這根是否還在跳動」。 */
export function isCandleOpen(candle: Candle, interval: Interval): boolean {
  return Date.now() / 1000 < candle.t + INTERVAL_SECONDS[interval]
}
