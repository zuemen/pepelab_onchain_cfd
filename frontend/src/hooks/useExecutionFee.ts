import type { Contract } from 'ethers'

import { useState, useEffect, useCallback } from 'react'

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
  /**
   * 重讀一次。owner 隨時可能 `setExecutionFee`，只在掛載時讀一次的話，停在頁面上的人看到的是舊費率——
   * 自動同步的「同意的費率」提示（ADR-024）就會說錯。重讀失敗時保留上一次讀到的值。
   */
  refresh: () => void
} {
  const [wei, setWei] = useState<bigint>(FALLBACK_WEI)
  const [loaded, setLoaded] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce(n => n + 1), [])

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
  }, [exchange, nonce])

  return { wei, loaded, eth: formatEth(wei), refresh }
}

/**
 * wei → 不捨入的 ETH 字串（最多 18 位小數，去掉尾隨 0）。給「你簽名同意的金額」這類必須一字不差的地方：
 * `formatEth` 只留 6 位，兩個只差 1 wei 的費率會顯示成同一個數字。
 */
export function formatEthExact(wei: bigint): string {
  const neg = wei < 0n
  const a = neg ? -wei : wei
  const frac = (a % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / 10n ** 18n}${frac ? `.${frac}` : ''}`
}

/** wei → 去掉尾隨 0 的 ETH 字串。`1000000000000000n` → `"0.001"`。 */
export function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6)
  return s.replace(/\.?0+$/, '') || '0'
}
