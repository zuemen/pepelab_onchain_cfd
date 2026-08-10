import { useState, useEffect, useCallback } from 'react'

// 使用者在鏈上的成交紀錄（開倉 / 平倉 / 被清算）。
//
// 資料來自 PerpetualExchange 的事件，owner 是 indexed 參數，所以可以直接用
// filter 只撈自己的，不必拉全網再過濾。
//
// 注意：src/pages/pepefi/HistoryPage.tsx 也在做同一件事（而且範圍更大，含 swap
// 與保證金進出）。這裡刻意寫一份精簡版而不是去改 HistoryPage——終端機要的是
// 「持倉表下面那一小塊最近成交」，跟一整頁的歷史查詢是不同東西。兩邊的事件解析
// 之後值得抽成共用 hook，但那是獨立的整理工作，不該混進這一版。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Contracts = any

/** 回溯多少個 block。Base Sepolia 約 2 秒一個 block，5000 ≈ 2.8 小時。 */
const FETCH_BLOCKS = 5_000

export type FillKind = 'opened' | 'closed' | 'liquidated'

export interface Fill {
  key: string
  kind: FillKind
  positionId: bigint
  /** 只有 opened 有標的資訊；closed/liquidated 事件不帶 asset。 */
  asset?: string
  isLong?: boolean
  price?: bigint
  margin?: bigint
  leverage?: bigint
  pnl?: bigint
  blockNumber: number
  txHash: string
}

export interface UserFills {
  fills: Fill[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useUserFills(contracts: Contracts, address: string | null): UserFills {
  const [fills, setFills] = useState<Fill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!contracts || !address) {
      setFills([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const ex = contracts.exchange
      const current = Number(await ex.runner.provider.getBlockNumber())
      const fromBlock = Math.max(0, current - FETCH_BLOCKS)

      // 三種事件各自查，其中一種失敗不該讓整張表空掉。
      const settled = await Promise.allSettled([
        ex.queryFilter(ex.filters.PositionOpened(null, address), fromBlock, 'latest'),
        ex.queryFilter(ex.filters.PositionClosed(null, address), fromBlock, 'latest'),
        ex.queryFilter(ex.filters.PositionLiquidated(null, address), fromBlock, 'latest'),
      ])

      const rows: Fill[] = []
      const kinds: FillKind[] = ['opened', 'closed', 'liquidated']

      settled.forEach((res, i) => {
        if (res.status !== 'fulfilled') return
        const kind = kinds[i]
        for (const log of res.value as {
          args: Record<string, unknown>
          blockNumber: number
          transactionHash: string
          index?: number
        }[]) {
          const a = log.args
          rows.push({
            key: `${log.transactionHash}-${log.index ?? 0}-${kind}`,
            kind,
            positionId: a.positionId as bigint,
            asset: kind === 'opened' ? (a.asset as string) : undefined,
            isLong: kind === 'opened' ? (a.isLong as boolean) : undefined,
            price: kind === 'opened' ? (a.entryPrice as bigint) : undefined,
            margin: kind === 'opened' ? (a.margin as bigint) : undefined,
            leverage: kind === 'opened' ? (a.leverage as bigint) : undefined,
            pnl: kind === 'opened' ? undefined : (a.pnl as bigint),
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
          })
        }
      })

      if (settled.every((r) => r.status === 'rejected')) {
        setError('無法讀取鏈上成交紀錄')
      }

      rows.sort((x, y) => y.blockNumber - x.blockNumber)
      setFills(rows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [contracts, address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { fills, loading, error, refresh }
}
