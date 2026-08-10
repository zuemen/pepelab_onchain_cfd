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

      // 逐個標的限流，而不是 11 個標的 × 4 個呼叫一次全部送出（= 44 個併發，
      // 落在公開 RPC 會開始丟包的區間）。每個標的內部的呼叫仍然併發，所以實際
      // 同時在飛的大約是 RPC_CONCURRENCY × 4。
      //
      // 用 allSettled 而不是 all：任何一個讀取失敗都會讓整個標的被丟掉，UI 上
      // 顯示成「—」。這正是 2026-08-10 的實際災情——ABI 已更新成稽核後的版本
      // （cumulativeFundingIndex 被拆成 Long/Short），但鏈上跑的還是舊 bytecode，
      // 於是那一個呼叫必定 revert，連坐讓 **全部 11 個標的** 的 funding 與未平倉
      // 量都消失，儘管其餘四個值鏈上都讀得到（實測 sNVDA 多單 400 / 空單 1,060 /
      // funding -33bps）。一個不存在的方法不該讓四個好資料一起陪葬。
      const entries = await mapLimit(
        ASSETS,
        Math.max(1, Math.floor(RPC_CONCURRENCY / 2)),
        async (a): Promise<[string, FundingInfo] | null> => {
          const [rate, longOI, shortOI, lastSettled] = await Promise.allSettled([
            exchange.getFundingRate(a.id)      as Promise<bigint>,
            exchange.globalLongNotional(a.id)  as Promise<bigint>,
            exchange.globalShortNotional(a.id) as Promise<bigint>,
            exchange.lastFundingUpdateAt(a.id) as Promise<bigint>,
          ])
          // 未平倉量是這一格的重點；連它都讀不到才真的沒東西可顯示。
          if (longOI.status !== 'fulfilled' || shortOI.status !== 'fulfilled') return null

          const settled = lastSettled.status === 'fulfilled' ? lastSettled.value : 0n
          return [a.id, {
            label:       a.label,
            rate:        rate.status === 'fulfilled' ? rate.value : 0n,
            longOI:      longOI.value,
            shortOI:     shortOI.value,
            lastSettled: settled,
            canSettle:   settled > 0n && now >= settled + interval,
            interval,
          }]
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
