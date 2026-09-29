// 每個資產實際的交易參數（槓桿上限、交易費 bps）——以鏈上為準，讀不到才退回靜態表。
//
// 前端的碳分級表（carbon.ts 的 paramsFor）是 CarbonTiers 合約的鏡像，但鏡像會過期：
// owner 可以用 setMaxLeverageFor 收緊單一資產，ESGRegistry 未設定時合約走全域
// TRADING_FEE_BPS。PerpetualExchange 本身有 `maxLeverageForAsset(asset)` 與
// `tradingFeeBpsForAsset(asset)` 兩個 view，回傳的就是 openPosition 真正會用的數字
// （2026-09-29 以唯讀 eth_call 對線上 0x827eA0c6…124D 核對：兩者皆存在，例如 sAAPL
// 5× / 10 bps、sBTC 1× / 100 bps）。所以這裡先讀鏈上，讀不到才用靜態表，並把來源
// 標出來——畫面上的「≤5×」要讓人知道是合約說的，還是前端推估的。

export type ParamsSource = 'chain' | 'static'

export interface TradingParams {
  maxLeverage: number
  tradingFeeBps: number
  source: ParamsSource
}

export function resolveTradingParams(
  chain: { maxLeverage: bigint | null; tradingFeeBps: bigint | null } | null,
  fallback: { maxLeverage: number; tradingFeeBps: number }
): TradingParams {
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
