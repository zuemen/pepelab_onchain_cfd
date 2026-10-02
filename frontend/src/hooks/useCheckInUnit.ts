import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import { probeCheckInUnit, type CheckInUnit } from 'src/lib/pepefi/achievements'

// 每日簽到發的是 PEPE 還是成就點數（#169），由合約 bytecode 決定（見 probeCheckInUnit）。
//
// 已確定的結論放在模組層級、頁面之間共用，鍵是「chainId:合約位址」：
//   - 同一個部署者在兩條鏈用同一個 nonce 部署，位址會相同，所以鍵一定要帶 chainId
//     （PR #219 複審 B2）；換鏈或換位址就是另一個鍵，從「未知」重新判斷；
//   - 同一個鍵一旦確定是點數版就不再降級（PR #219 審查 B-F1）；
//   - 讀不到 bytecode 時沿用該鍵上一次確定的結論，不因 RPC 抖動改口；
//   - chainId 未知（null）時不寫入，也不讀取，免得把一條鏈的結論套到另一條鏈。
const settled = new Map<string, CheckInUnit>()

export function checkInUnitKey(chainId: number | null | undefined, addr: string): string | null {
  if (chainId === null || chainId === undefined) return null
  return `${chainId}:${addr.toLowerCase()}`
}

export function settledCheckInUnit(chainId: number | null | undefined, addr: string): CheckInUnit | null {
  const key = checkInUnitKey(chainId, addr)
  return key === null ? null : (settled.get(key) ?? null)
}

export function settleCheckInUnit(chainId: number | null | undefined, addr: string, unit: CheckInUnit): void {
  const key = checkInUnitKey(chainId, addr)
  if (key !== null) settled.set(key, unit)
}

/** 測試用：清掉模組層級的結論。 */
export function resetSettledCheckInUnits(): void {
  settled.clear()
}

/**
 * 只要單位、不要點數的頁面用這個（管理頁、PepeLab 的提示文案）。
 * null = 還不知道（合約不在、讀取失敗且沒有先前結論）；呼叫端要用不提單位的中性文案。
 */
export function useCheckInUnit(
  incentives: Contract | null | undefined,
  chainId: number | null | undefined,
): CheckInUnit | null {
  const [unit, setUnit] = useState<CheckInUnit | null>(null)

  useEffect(() => {
    setUnit(null)
    if (!incentives) return undefined
    let cancelled = false
    void (async () => {
      let addr: string
      try {
        addr = await incentives.getAddress()
      } catch {
        return
      }
      const prev = settledCheckInUnit(chainId, addr)
      if (!cancelled) setUnit(prev)
      const probe = await probeCheckInUnit(
        { getCode: () => incentives.getDeployedCode(), readPoints: () => Promise.resolve(null) },
        prev,
      )
      if (cancelled || probe.unit === null) return
      settleCheckInUnit(chainId, addr, probe.unit)
      setUnit(probe.unit)
    })()
    return () => {
      cancelled = true
    }
  }, [incentives, chainId])

  return unit
}
