import { useState, useEffect, useCallback } from 'react'
import type { Contract, BrowserProvider } from 'ethers'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'

export interface WhaleAlert {
  txHash:      string
  blockNumber: number
  timestamp:   number   // estimated unix seconds
  owner:       string
  asset:       string
  assetLabel:  string
  isLong:      boolean
  margin:      bigint
  leverage:    bigint
  notional:    bigint   // margin × leverage, 18-dec
}

// 5,000 mUSDC notional = whale threshold
export const WHALE_THRESHOLD = 5_000n * 10n ** 18n
const FETCH_BLOCKS   = 50_000
const AVG_BLOCK_TIME = 12   // Sepolia ~12s per block

export function useWhaleAlerts(
  exchange: Contract | null,
  provider: BrowserProvider | null,
  limit    = 20,
): { alerts: WhaleAlert[]; loading: boolean; refetch: () => void } {
  const [alerts,  setAlerts]  = useState<WhaleAlert[]>([])
  const [loading, setLoading] = useState(false)

  const fetchAlerts = useCallback(async () => {
    if (!exchange || !provider) return
    setLoading(true)
    try {
      const latestBlock = await provider.getBlock('latest')
      if (!latestBlock) return
      const { number: latestNum, timestamp: latestTs } = latestBlock
      const fromBlock = Math.max(0, latestNum - FETCH_BLOCKS)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logs = await exchange.queryFilter(exchange.filters.PositionOpened(), fromBlock, 'latest') as any[]

      const whales: WhaleAlert[] = []
      for (const log of logs) {
        const margin   = log.args.margin   as bigint
        const leverage = log.args.leverage as bigint
        const notional = margin * leverage
        if (notional < WHALE_THRESHOLD) continue

        const blockOffset = latestNum - (log.blockNumber as number)
        whales.push({
          txHash:      log.transactionHash as string,
          blockNumber: log.blockNumber     as number,
          timestamp:   latestTs - blockOffset * AVG_BLOCK_TIME,
          owner:       log.args.owner      as string,
          asset:       log.args.asset      as string,
          assetLabel:  ASSET_LABEL[log.args.asset as string] ?? '?',
          isLong:      log.args.isLong     as boolean,
          margin,
          leverage,
          notional,
        })
      }
      whales.sort((a, b) => b.blockNumber - a.blockNumber)
      setAlerts(whales.slice(0, limit))
    } catch (e) {
      console.error('[useWhaleAlerts]', e)
    } finally { setLoading(false) }
  }, [exchange, provider, limit])

  useEffect(() => { void fetchAlerts() }, [fetchAlerts])

  return { alerts, loading, refetch: fetchAlerts }
}
