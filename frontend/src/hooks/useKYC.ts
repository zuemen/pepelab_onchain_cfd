import type { Contract } from 'ethers'

import { useState, useEffect, useCallback } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * KYC 狀態。五種是刻意分開的，因為它們要引導的行為完全不同：
 *  - `verified`     已通過，可以交易受管制資產
 *  - `pending`      **已送出申請、等待人工審核**——不要再叫他重送一次表單
 *  - `unverified`   鏈上明確說「沒送過也沒通過」→ 引導去做 KYC
 *  - `not-required` 這條鏈上沒有 KYCRegistry（位址 0x0）→ 沒有這道閘門
 *  - `unknown`      RPC 讀取失敗／逾時 → **不知道**，不是「沒問題」
 */
export type KYCStatus = 'verified' | 'pending' | 'unverified' | 'not-required' | 'unknown'

export interface UseKYCResult {
  /** 只有在確定通過（或本鏈沒有這道閘門）時才是 true。 */
  isVerified: boolean
  status: KYCStatus
  /** 讀不到鏈上狀態。UI 要說「無法確認」而不是「未驗證」——兩者的行動不同。 */
  isUnknown: boolean
  /** 申請已送出、待審核。UI 要說「審核中」而不是「去做 KYC」。 */
  isPending: boolean
  refetch: () => Promise<void>
}

/**
 * 合規閘門必須 fail-closed。
 *
 * 舊版的預設值和 catch 分支都是 `setIsVerified(true)`：RPC 抖一下、節點限流、
 * registry 換位址，任何一種情況都會讓「未通過 KYC 的使用者」在 UI 上被當成已通過
 * 而放行去交易 RWA。合規控制不能因為讀不到就自動放行。
 *
 * 現在讀不到就是 `unknown` → `isVerified === false` → 擋住，並由 UI 說明是
 * 「無法確認」而不是「你沒做 KYC」。
 *
 * KYCRegistry 這一輪改成審核制：`submitKYC` 只是送出申請（emit KYCSubmitted），
 * 要等 verifier 呼叫 `approveKYC` 才會 `isVerified`。所以「沒通過」現在有兩種
 * 完全不同的情況——還沒送 vs 送了在等——UI 必須分得出來，否則使用者會一直重送
 * 同一份表單、以為自己操作失敗。
 */
export function useKYC(kycRegistry: Contract | null, userAddress: string | null): UseKYCResult {
  const [status, setStatus] = useState<KYCStatus>('unknown')

  const refetch = useCallback(async () => {
    // 還沒連錢包／合約還沒建好：這不是讀取失敗，只是還沒到能判斷的時候。
    // 一樣不放行（isVerified=false），但頁面在沒連錢包時本來就不會讓人下單。
    if (!kycRegistry || !userAddress) {
      setStatus('unknown')
      return
    }
    const addr = String(kycRegistry.target).toLowerCase()
    if (addr === ZERO) {
      // 本鏈沒部署 KYCRegistry = 這條鏈上沒有 KYC 閘門，不是「讀不到」。
      setStatus('not-required')
      return
    }
    // safeRead 用 null 當哨兵：任何錯誤／逾時都落到 unknown，不會變成 true。
    const v = await safeRead<boolean | null>(
      kycRegistry.isVerified(userAddress) as Promise<boolean>,
      null,
    )
    if (v === null) {
      setStatus('unknown')
      return
    }
    if (v) {
      setStatus('verified')
      return
    }
    // 還沒通過 → 分辨「送出待審」與「根本沒送」。isPending 讀不到就退回
    // unverified：它只影響文案，不影響放行，所以不需要 fail-closed 到 unknown。
    const p = await safeRead<boolean | null>(
      kycRegistry.isPending(userAddress) as Promise<boolean>,
      null,
    )
    setStatus(p === true ? 'pending' : 'unverified')
  }, [kycRegistry, userAddress])

  useEffect(() => { void refetch() }, [refetch])

  return {
    isVerified: status === 'verified' || status === 'not-required',
    status,
    isUnknown: status === 'unknown',
    isPending: status === 'pending',
    refetch,
  }
}
