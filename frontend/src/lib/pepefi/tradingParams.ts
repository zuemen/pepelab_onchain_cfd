// 每個資產實際的交易參數（槓桿上限、交易費 bps）——以鏈上為準，讀不到才退回靜態表。
//
// 前端的碳分級表（carbon.ts 的 paramsFor）是 CarbonTiers 合約的鏡像，但鏡像會過期：
// owner 可以用 setMaxLeverageFor 收緊單一資產，ESGRegistry 未設定時合約走全域
// TRADING_FEE_BPS。PerpetualExchange 本身有 `maxLeverageForAsset(asset)` 與
// `tradingFeeBpsForAsset(asset)` 兩個 view，回傳的就是 openPosition 真正會用的數字
// （2026-09-29 以唯讀 eth_call 對線上 0x827eA0c6…124D 核對：兩者皆存在，例如 sAAPL
// 5× / 10 bps、sBTC 1× / 100 bps）。所以這裡先讀鏈上，讀不到才用靜態表，並把來源
// 標出來——畫面上的「≤5×」要讓人知道是合約說的，還是前端推估的。

import type { AssetMeta } from './assetMeta'

import { paramsFor, attestationExpired, type Tier } from './carbon'

/** chain = 鏈上讀到；static = 讀不到、退回碳分級靜態表；pending = 還在讀。 */
export type ParamsSource = 'chain' | 'static' | 'pending'

/** 讀取中的槓桿上限：最保守的 1×，不先露出靜態表的上限再往下修。 */
export const PENDING_MAX_LEVERAGE = 1

export interface TradingParams {
  maxLeverage: number
  tradingFeeBps: number
  source: ParamsSource
}

export function resolveTradingParams(
  chain: { maxLeverage: bigint | null; tradingFeeBps: bigint | null } | null,
  fallback: { maxLeverage: number; tradingFeeBps: number },
  /** 讀取是否已經結束（成功或失敗）。false 時一律回保守的 pending。 */
  settled = true
): TradingParams {
  if (!settled) {
    return { maxLeverage: PENDING_MAX_LEVERAGE, tradingFeeBps: fallback.tradingFeeBps, source: 'pending' }
  }
  // 兩個都要讀到才算鏈上來源；混用一半鏈上、一半靜態會讓來源標示說謊。
  if (chain && chain.maxLeverage !== null && chain.tradingFeeBps !== null && chain.maxLeverage > 0n) {
    return {
      maxLeverage: Number(chain.maxLeverage),
      tradingFeeBps: Number(chain.tradingFeeBps),
      source: 'chain',
    }
  }
  return { ...fallback, source: 'static' }
}

/** 碳分級靜態表（carbon.ts 的鏡像）給出的參數與分級；見證過期一律當未評等。 */
export function staticTradingParams(meta: AssetMeta | undefined, nowMs: number): {
  tier: Tier
  maxLeverage: number
  tradingFeeBps: number
} {
  if (!meta?.carbon) {
    return { tier: 'unrated', maxLeverage: 5, tradingFeeBps: paramsFor('low').tradingFeeBps }
  }
  const tier: Tier = attestationExpired(meta.carbon.observed, nowMs) ? 'unrated' : meta.carbon.tier
  const p = paramsFor(tier)
  return { tier, maxLeverage: p.maxLeverage, tradingFeeBps: p.tradingFeeBps }
}
