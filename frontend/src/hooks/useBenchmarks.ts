import { useEffect, useState } from 'react'

import {
  fetchBenchmarks,
  yesterdayUtc,
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

/**
 * 取得三個對照指數，並持續輪詢更新。不吃任何跟持倉相關的參數——這一列
 * 零持倉、甚至從未開過倉的使用者也照常顯示（issue #65）。
 */
export function useBenchmarks(): BenchmarksState {
  const [state, setState] = useState<BenchmarksState>({ benchmarks: null, loading: true, error: null })

  useEffect(() => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let hasData = false

    const load = async () => {
      try {
        const res = await fetchBenchmarks(yesterdayUtc(), ac.signal)
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

    void load()
    timer = setInterval(() => void load(), POLL_MS)

    return () => {
      ac.abort()
      if (timer) clearInterval(timer)
    }
  }, [])

  return state
}
