import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import { probeCheckInUnit, type CheckInUnit } from 'src/lib/pepefi/achievements'

// 每日簽到發的是 PEPE 還是成就點數（#169），由合約 bytecode 決定（見 probeCheckInUnit）。
//
// 已確定的結論以「合約位址」為鍵、放在模組層級，頁面之間共用：
//   - 換鏈或換位址就是另一個鍵，重新判斷；
//   - 同一個位址一旦確定是點數版就不再降級（PR #219 審查 B-F1）；
//   - 讀不到 bytecode 時沿用上一次確定的結論，不因 RPC 抖動改口。
const settled = new Map<string, CheckInUnit>()

export function settledCheckInUnit(addr: string): CheckInUnit | null {
  return settled.get(addr.toLowerCase()) ?? null
}

export function settleCheckInUnit(addr: string, unit: CheckInUnit): void {
  settled.set(addr.toLowerCase(), unit)
}

/**
 * 只要單位、不要點數的頁面用這個（管理頁、PepeLab 的提示文案）。
 * null = 還不知道（合約不在、讀取失敗且沒有先前結論）；呼叫端照舊版文案顯示。
 */
export function useCheckInUnit(incentives: Contract | null | undefined): CheckInUnit | null {
  const [unit, setUnit] = useState<CheckInUnit | null>(null)

  useEffect(() => {
    if (!incentives) {
      setUnit(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      let addr: string
      try {
        addr = await incentives.getAddress()
      } catch {
        return
      }
      const prev = settledCheckInUnit(addr)
      if (!cancelled) setUnit(prev)
      const probe = await probeCheckInUnit(
        { getCode: () => incentives.getDeployedCode(), readPoints: () => Promise.resolve(null) },
        prev,
      )
      if (cancelled || probe.unit === null) return
      settleCheckInUnit(addr, probe.unit)
      setUnit(probe.unit)
    })()
    return () => {
      cancelled = true
    }
  }, [incentives])

  return unit
}
