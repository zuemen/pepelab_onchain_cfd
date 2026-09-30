import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'

/**
 * 讀不到時的顯示值，只是後備。對齊線上 PerpetualExchange（0x827eA0c6…124D）的
 * `executionFee()`：2026-09-29 唯讀 eth_call 讀到 100000000000000 wei = 0.0001 ETH。
 * 原本寫 0.001 ETH，是鏈上實際值的 10 倍。
 */
export const FALLBACK_EXECUTION_FEE_WEI = 10n ** 14n // 0.0001 ETH
const FALLBACK_WEI = FALLBACK_EXECUTION_FEE_WEI

/**
 * PerpetualExchange.executionFee()。
 *
 * UI 之前把「0.001 ETH」寫死在文案裡，送單時卻是讀鏈上值——owner 一改
 * `setExecutionFee`，畫面上的數字就開始說謊，而且是關於使用者要付多少錢。
 * 顯示與送出必須讀同一個來源。
 */
export function useExecutionFee(exchange: Contract | null): {
  wei: bigint
  /** 已經讀到鏈上值（false = 還在用後備值顯示）。 */
  loaded: boolean
  /** `0.001` —— 直接給文案用。 */
  eth: string
} {
  const [wei, setWei] = useState<bigint>(FALLBACK_WEI)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!exchange) return
    let cancelled = false
    void (async () => {
      const v = await safeRead<bigint | null>(exchange.executionFee() as Promise<bigint>, null)
      if (cancelled || v === null) return
      setWei(v)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [exchange])

  return { wei, loaded, eth: formatEth(wei) }
}

/** wei → 去掉尾隨 0 的 ETH 字串。`1000000000000000n` → `"0.001"`。 */
export function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6)
  return s.replace(/\.?0+$/, '') || '0'
}
