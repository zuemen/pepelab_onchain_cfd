import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import { ASSET_IDS } from 'src/contracts/addresses'

type AssetId = `0x${string}`

const ASSETS: { label: string; id: AssetId }[] = [
  { label: 'sBTC',  id: ASSET_IDS.sBTC  },
  { label: 'sETH',  id: ASSET_IDS.sETH  },
  { label: 'sAAPL', id: ASSET_IDS.sAAPL },
  { label: 'sTSLA', id: ASSET_IDS.sTSLA },
]

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

      const entries = await Promise.all(
        ASSETS.map(async (a): Promise<[string, FundingInfo] | null> => {
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
        })
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
