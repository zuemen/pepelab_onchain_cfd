import type { Contract } from 'ethers'
import type { TradingParams } from 'src/lib/pepefi/tradingParams'

import { useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { resolveTradingParams } from 'src/lib/pepefi/tradingParams'

/**
 * 讀 exchange 的 `maxLeverageForAsset(asset)` / `tradingFeeBpsForAsset(asset)`。
 * 讀不到（舊合約、RPC 失敗、還沒連線）時回靜態表，`source` 標成 'static'。
 */
export function useAssetTradingParams(
  exchange: Contract | null | undefined,
  asset: string,
  fallback: { maxLeverage: number; tradingFeeBps: number }
): TradingParams {
  const [chain, setChain] = useState<{ asset: string; maxLeverage: bigint | null; tradingFeeBps: bigint | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    setChain(null)
    if (!exchange) return undefined
    void (async () => {
      const [maxLeverage, tradingFeeBps] = await Promise.all([
        safeRead<bigint | null>(exchange.maxLeverageForAsset(asset) as Promise<bigint>, null),
        safeRead<bigint | null>(exchange.tradingFeeBpsForAsset(asset) as Promise<bigint>, null),
      ])
      if (!cancelled) setChain({ asset, maxLeverage, tradingFeeBps })
    })()
    return () => {
      cancelled = true
    }
  }, [exchange, asset])

  // 換資產的那一刻 state 還是上一檔的值——只接受同一檔的結果。還沒讀回來（settled =
  // false）時回 pending：槓桿上限先鎖在 1×，不先露出靜態表的上限、讀到後再往下修。
  // 沒有 exchange（未連線、未部署）就不會有鏈上值，直接視為讀完、退回靜態表。
  const mine = chain && chain.asset === asset ? chain : null
  const settled = !exchange || mine !== null
  return resolveTradingParams(mine, fallback, settled)
}
