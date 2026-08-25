import { useEffect, useState } from 'react'

import {
  fetchBenchmarks,
  type BenchmarkKey,
  type BenchmarkResult,
} from 'src/lib/pepefi/benchmarks'

/**
 * 輪詢間隔。後端把「當前值」快取 5 分鐘（agent/signal-api/src/benchmarks.ts
 * 的 CURRENT_TTL_MS）——比那個更密的輪詢只是白打 API、拿到同一份快取。這裡
 * 是行銷用的對照指數，不是交易決策依據，60 秒的解析度綽綽有餘。
 */
const POLL_MS = 60_000

export interface BenchmarksState {
  benchmarks: Record<BenchmarkKey, BenchmarkResult> | null
  loading: boolean
  /** 整個請求失敗（網路／非 2xx），不是個別指數各自的 error——那個在 BenchmarkResult.error。 */
  error: string | null
}

const IDLE: BenchmarksState = { benchmarks: null, loading: false, error: null }

/**
 * 取得三個對照指數，並持續輪詢更新。
 *
 * `date` 有三種意義,對應兩個呼叫端：
 *   - 省略（undefined）→ 不送 date,後端只回 current／previousClose／series
 *     （BenchmarkStrip，issue #65）。當日漲跌用 previousClose,不需要任何
 *     日期參數,所以也不該讓後端白跑一次 atDate 查詢。不吃任何跟持倉相關的
 *     參數，零持倉、甚至從未開過倉的使用者也照常顯示。
 *   - 一個固定的 YYYY-MM-DD → 「你 vs 大盤」的錨定日比較（issue #67），date
 *     變動（使用者的最早持倉換了）才重新抓，不是每次輪詢都换。
 *   - null → 沒有錨定日可比（零持倉）,完全不打 API,直接回 idle 狀態——這是
 *     跟「省略」刻意不同的第三種狀態,不能把「沒有錨定日」誤當成「不帶 date
 *     的一般查詢」，那會讓零持倉的使用者看到一個跟他無關的比較。
 */
export function useBenchmarks(date?: string | null): BenchmarksState {
  const [state, setState] = useState<BenchmarksState>(date === null ? IDLE : { ...IDLE, loading: true })

  useEffect(() => {
    if (date === null) {
      setState(IDLE)
      return
    }

    const ac = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let hasData = false

    const load = async () => {
      try {
        const res = await fetchBenchmarks(date, ac.signal)
        if (ac.signal.aborted) return
        setState({ benchmarks: res.benchmarks, loading: false, error: null })
        hasData = true
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // 輪詢失敗時保留畫面上既有的資料，只有初次載入失敗才顯示整列的錯誤
        // 狀態——跟 useCandles 同一個理由：一次暫時性的網路抖動不該讓已經
        // 顯示的數字消失、換成一整片錯誤畫面。
        if (!hasData) setState({ benchmarks: null, loading: false, error: (err as Error).message })
      }
    }

    setState((prev) => ({ ...prev, loading: true }))
    void load()
    timer = setInterval(() => void load(), POLL_MS)

    return () => {
      ac.abort()
      if (timer) clearInterval(timer)
    }
  }, [date])

  return state
}
