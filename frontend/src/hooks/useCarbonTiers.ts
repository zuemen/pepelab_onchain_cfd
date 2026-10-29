import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import { ASSET_IDS } from 'src/contracts/addresses'
import { safeRead, isDeployed } from 'src/lib/pepefi/safeRead'

import type { Tier } from 'src/lib/pepefi/carbon'

/**
 * 一檔資產的**見證碳等級**——ESGRegistryV2.medianCarbonTier 的鏈上結果。
 *
 * 這和 /tokens 表格上那個 tier 不是同一個東西,兩者刻意不合併（見 #152）：
 *  - `assetRows.tierForAsset()` 讀的是本機靜態 metadata（`assetMeta` 的碳強度
 *    與觀測日期）,在前端判斷是否過期。那是「這個 demo 打算怎麼定價」。
 *  - 這裡讀的是鏈上多方見證的中位數,附帶見證數量與離散度。那是「鏈上實際
 *    見證到什麼」,而 AssetVaultV2 的鑄造手續費用的正是它（ADR-006）。
 *
 * 兩者通常一致；不一致本身就是有意義的資訊,所以畫面上分開標示來源,不做
 * 任何一方覆蓋另一方的處理。
 */
export interface AttestedTier {
  tier: Tier
  /** 目前仍新鮮的見證筆數。0 筆即未評等。 */
  count: number
  /**
   * 見證之間的離散度（等級序數的全距）。0 代表所有見證者講同一件事。
   *
   * 這是攤開來給人看的數字,不是要被平均掉的誤差——評等機構對同一檔資產
   * 講不同的話,正是這個平台想讓人看見的狀況（見 frontend/CONTEXT.md 的
   * Dispersion 詞條）。
   */
  dispersion: number
  /** false = Unrated Asset：從未見證,或所有見證都已過期。 */
  isRated: boolean
}

export interface UseCarbonTiersResult {
  data: Record<string, AttestedTier>
  /** 這輪讀取已經結束（不論成功與否）。 */
  loaded: boolean
  error: boolean
  /** 本鏈沒有 ESGRegistryV2。和「讀失敗」是兩件事,畫面上的講法也不同。 */
  unavailable: boolean
}

const ASSETS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sAAPL,
  ASSET_IDS.sTSLA,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sBOND,
  ASSET_IDS.sNVDA,
  ASSET_IDS.sMSFT,
  ASSET_IDS.sGOOGL,
  ASSET_IDS.sICLN,
  ASSET_IDS.sESGU,
]

/**
 * CarbonTiers.Tier 的序數對應。合約端是 `enum Tier { Unrated, Low, Mid, High }`
 * （contracts/src/CarbonTiers.sol:65）,前端的字面量型別同序,所以用索引對應而
 * 不是再寫一次 switch——合約那邊插入新等級時,這個陣列是唯一要改的地方。
 */
const TIER_BY_ORDINAL: readonly Tier[] = ['unrated', 'low', 'mid', 'high']

type TierTuple = {
  tier: bigint
  count: bigint
  dispersion: bigint
  isRated: boolean
}

/**
 * 讀 11 檔資產的見證碳等級。
 *
 * 兩件事是刻意的（沿用已移除的 useESG 學到的教訓，#383）：
 *  1. 0x0 守衛：登記位址是 0x0 時一次 RPC 都不發，直接回 unavailable。否則每次呼叫都在
 *     內部被 catch 吃掉，loaded 永遠表達不了「這條鏈沒有見證登記」，畫面就卡在載入中。
 *  2. 並行 + 逾時：11 次 await 串起來，任何一次慢就整串慢；改成 allSettled + safeRead。
 */
export function useCarbonTiers(registry: Contract | null): UseCarbonTiersResult {
  const [data, setData] = useState<Record<string, AttestedTier>>({})
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!registry) {
      // 這條鏈沒有 V2 stack。和「有合約但讀失敗」不同,畫面要講得出差別。
      setData({})
      setUnavailable(true)
      setError(false)
      setLoaded(true)
      return
    }

    if (!isDeployed(registry.target)) {
      setData({})
      setUnavailable(true)
      setError(false)
      setLoaded(true)
      return
    }

    let cancelled = false
    setLoaded(false)
    setError(false)
    setUnavailable(false)

    void (async () => {
      const rows = await Promise.all(
        ASSETS.map(async id => {
          const d = await safeRead<TierTuple | null>(
            registry.medianCarbonTier(id) as Promise<TierTuple>,
            null,
          )
          return { id, d }
        }),
      )
      if (cancelled) return

      const out: Record<string, AttestedTier> = {}
      let anyRead = false
      for (const { id, d } of rows) {
        if (!d) continue // 這一筆讀失敗——留空,不要塞一個看起來像答案的預設值
        anyRead = true
        const ordinal = Number(d.tier)
        out[id] = {
          // 合約回了預期外的序數時退回 unrated,而不是 undefined 流到畫面上。
          tier: TIER_BY_ORDINAL[ordinal] ?? 'unrated',
          count: Number(d.count),
          dispersion: Number(d.dispersion),
          isRated: d.isRated,
        }
      }
      setData(out)
      setLoaded(true)
      setError(!anyRead)
    })()

    return () => {
      cancelled = true
    }
  }, [registry])

  return { data, loaded, error, unavailable }
}
