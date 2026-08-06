import type { Contract, BrowserProvider } from 'ethers'

import { useState, useEffect, useCallback } from 'react'

import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { avgBlockTime, scanFromBlock, queryLogsChunked } from 'src/lib/pepefi/chainLogs'

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

/**
 * 近期鯨魚開倉。
 *
 * 修掉兩件事：
 *  1. 舊版單發一次 50,000 塊的 `queryFilter`。公共節點的 getLogs 上限是 10,000
 *     塊，所以這一發在 Base Sepolia 上根本不會回資料，只會丟錯進 console，
 *     UI 靜靜地顯示「沒有鯨魚」。改用共用的 queryLogsChunked。
 *  2. `AVG_BLOCK_TIME = 12` 是 Ethereum 的出塊時間。Base 是 2 秒，於是每一筆
 *     事件的時間都被高估六倍——「10 分鐘前」的開倉會被顯示成「1 小時前」。
 *     現在依 chainId 查表。
 */
export function useWhaleAlerts(
  exchange: Contract | null,
  provider: BrowserProvider | null,
  limit    = 20,
  chainId: number | null = null,
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
      const fromBlock = scanFromBlock({ chainId, currentBlock: latestNum })
      const blockTime = avgBlockTime(chainId)

      const logs = await queryLogsChunked(
        exchange,
        exchange.filters.PositionOpened(),
        fromBlock,
        latestNum,
      )

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
          timestamp:   latestTs - blockOffset * blockTime,
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
  }, [exchange, provider, limit, chainId])

  useEffect(() => { void fetchAlerts() }, [fetchAlerts])

  return { alerts, loading, refetch: fetchAlerts }
}
