import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import { ASSET_IDS } from 'src/contracts/addresses'
import { mapLimit, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

type AssetId = `0x${string}`

/**
 * 從 ASSET_IDS 推導，不要手寫清單。
 *
 * 舊版只列了四個標的，於是另外七個在 UI 上永遠顯示「—」或「尚無鏈上資料」——
 * 但鏈上其實有：實測 sMSFT 多單 1,360 / 空單 300、funding 47 bps，sGOLD 多單
 * 7,260。空白不是資料不存在，是前端沒去讀。新增標的時也不必再回來補這裡。
 */
const ASSETS: { label: string; id: AssetId }[] = Object.entries(ASSET_IDS).map(
  ([label, id]) => ({ label, id: id as AssetId }),
)

export interface FundingInfo {
  label:           string
  rate:            bigint   // signed BPS, e.g. 75 = 0.75%, positive = longs pay
  longOI:          bigint   // 18-dec notional
  shortOI:         bigint   // 18-dec notional
  lastSettled:     bigint   // unix timestamp (0 = never)
  canSettle:       boolean
  cumulativeIndex: bigint   // signed 18-dec
  interval:        bigint   // FUNDING_INTERVAL in seconds
}

export type FundingData = Record<string, FundingInfo>

export function useFundingData(exchange: Contract | null): FundingData {
  const [data, setData] = useState<FundingData>({})

  const fetchAll = useCallback(async () => {
    if (!exchange) return
    try {
      const now      = BigInt(Math.floor(Date.now() / 1000))
      const interval = (await exchange.FUNDING_INTERVAL()) as bigint

      // 逐個標的限流，而不是 11 個標的 × 5 個呼叫一次全部送出（= 55 個併發，
      // 落在公開 RPC 會開始丟包的區間）。每個標的內部的 5 個呼叫仍然併發，
      // 所以實際同時在飛的大約是 RPC_CONCURRENCY × 5。
      const entries = await mapLimit(
        ASSETS,
        Math.max(1, Math.floor(RPC_CONCURRENCY / 2)),
        async (a): Promise<[string, FundingInfo] | null> => {
          try {
            const [rate, longOI, shortOI, lastSettled, cumIdx] = await Promise.all([
              exchange.getFundingRate(a.id)           as Promise<bigint>,
              exchange.globalLongNotional(a.id)       as Promise<bigint>,
              exchange.globalShortNotional(a.id)      as Promise<bigint>,
              exchange.lastFundingUpdateAt(a.id)      as Promise<bigint>,
              exchange.cumulativeFundingIndex(a.id)   as Promise<bigint>,
            ])
            return [a.id, {
              label:           a.label,
              rate,
              longOI,
              shortOI,
              lastSettled,
              canSettle:       now >= lastSettled + interval,
              cumulativeIndex: cumIdx,
              interval,
            }]
          } catch { return null }
        },
      )
      setData(Object.fromEntries(entries.filter((e): e is [string, FundingInfo] => e !== null)))
    } catch (e) {
      console.error('[useFundingData]', e)
    }
  }, [exchange])

  useEffect(() => {
    void fetchAll()
    const timer = setInterval(() => { void fetchAll() }, 30_000)
    return () => clearInterval(timer)
  }, [fetchAll])

  return data
}
