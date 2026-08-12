import type { Contract } from 'ethers'

import { useRef, useMemo, useState, useEffect, useCallback } from 'react'

import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

// 各市場的多空未平倉分布（open interest）。
//
// 這一份**直接問合約**，不是從事件推的。PerpetualExchange 自己維護
// `globalLongNotional` / `globalShortNotional`，開倉時加、平倉與清算時減，
// 所以它是全站的即時真相，涵蓋掃描視窗之前就開著的倉——那些倉的
// PositionOpened 事件早就掉出 7 天視窗了，任何用事件推的版本都看不到它們，
// 會把「市場現在站在哪一邊」算成只有這一週新開的部位。
//
// 同一組數字也是合約算 funding rate 的輸入（見 _accrueFunding），所以
// 這裡顯示的失衡與使用者實際被收的資金費是同一件事。

export interface AssetSentiment {
  asset:      string
  label:      string
  icon:       string
  long:       bigint
  short:      bigint
  total:      bigint
  /** 0–1。多方佔這個市場未平倉名目的比例。 */
  longShare:  number
}

export interface MarketSentiment {
  /** 只含有未平倉的市場，依總量由大到小。 */
  rows:    AssetSentiment[]
  long:    bigint
  short:   bigint
  total:   bigint
  longShare: number
  /** 讀不到的市場數。RPC 限流不該被靜默翻譯成「這個市場沒有部位」。 */
  missing: number
  loading: boolean
  error:   string | null
  refetch: () => void
}

const EMPTY: Omit<MarketSentiment, 'refetch'> = {
  rows: [], long: 0n, short: 0n, total: 0n, longShare: 0.5,
  missing: 0, loading: false, error: null,
}

export function useMarketSentiment(exchange: Contract | null): MarketSentiment {
  const [rows,    setRows]    = useState<AssetSentiment[]>([])
  const [missing, setMissing] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const runId = useRef(0)

  const fetchSentiment = useCallback(async () => {
    if (!exchange) return

    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun

    setLoading(true)
    setError(null)

    try {
      // 兩個 eth_call × 11 個市場。
      //
      // 這裡原本在 mapLimit 的 worker 裡再包一層 `Promise.all([long, short])`，
      // 於是實際在飛的請求是 6 × 2 = 12，剛好是 rpcBatch.ts 量出來會被公開節點
      // 丟掉的區間——實測 11 個市場有 5 個讀不到。兩個 call 改成依序 await，
      // 併發才真的是 RPC_CONCURRENCY 說的那個數字。
      const results = await mapLimit(ASSETS_LIST, RPC_CONCURRENCY, async (a) => {
        try {
          const long  = await withRetry(() => exchange.globalLongNotional(a.id))  as bigint
          const short = await withRetry(() => exchange.globalShortNotional(a.id)) as bigint
          return { asset: a.id as string, label: a.symbol, icon: a.icon, long, short }
        } catch {
          return null
        }
      })
      if (isStale()) return

      const ok = results.filter((r): r is NonNullable<typeof r> => r !== null)

      setMissing(ASSETS_LIST.length - ok.length)
      setRows(
        ok
          .map(r => {
            const total = r.long + r.short
            return {
              ...r,
              total,
              // total 為 0 的市場會被下面濾掉，這裡給 0.5 只是避免 NaN 流進樣式寬度
              longShare: total === 0n ? 0.5 : Number(r.long) / Number(total),
            }
          })
          .filter(r => r.total > 0n)
          .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)),
      )
    } catch (e) {
      console.error('[useMarketSentiment]', e)
      if (runId.current === myRun) setError('Could not read open interest from the exchange.')
    } finally {
      if (runId.current === myRun) setLoading(false)
    }
  }, [exchange])

  useEffect(() => { void fetchSentiment() }, [fetchSentiment])

  const totals = useMemo(() => {
    const long  = rows.reduce((acc, r) => acc + r.long, 0n)
    const short = rows.reduce((acc, r) => acc + r.short, 0n)
    const total = long + short
    return { long, short, total, longShare: total === 0n ? 0.5 : Number(long) / Number(total) }
  }, [rows])

  if (!exchange) return { ...EMPTY, refetch: fetchSentiment }

  return { rows, ...totals, missing, loading, error, refetch: fetchSentiment }
}
