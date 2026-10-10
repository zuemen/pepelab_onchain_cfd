import type { RawRetirement, RetirementSummary, RawRetirementState } from 'src/lib/pepefi/carbonRetirement'

import { Contract } from 'ethers'
import { useMemo, useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { useReadChain } from 'src/hooks/useRwaTransparency'
import {
  RECENT_LIMIT,
  summarizeRetirements,
  retirementReadFailed,
  simulationFlagContradicts,
} from 'src/lib/pepefi/carbonRetirement'
import {
  CARBON_RETIREMENT_ABI,
  CARBON_ERC20_DECIMALS_ABI,
  getCarbonRetirementAddress,
} from 'src/contracts/carbonRetirement'

export interface UseCarbonRetirementResult {
  /** 這個 build／這條鏈沒有 CarbonRetirement（或還沒有可讀的節點）：整個區塊不顯示。 */
  unavailable: boolean
  /** 這輪讀取已經結束（不論成功與否）。 */
  loaded: boolean
  /** 位址有設但讀不到，或讀到的合約自稱不是模擬：畫面說「暫時無法確認」。 */
  error: boolean
  summary: RetirementSummary | null
  address: string | null
}

type RawTuple = { amount: bigint; tonnesCO2e: bigint; timestamp: bigint; retiredBy: string }

/**
 * 讀 CarbonRetirement 的累計退役量、預算與最近幾筆退役。全部唯讀。
 *
 * 讀哪條鏈沿用 RWA 透明度頁的 useReadChain：錢包在部署鏈上就用錢包，否則用公開節點，
 * 所以沒連錢包也看得到。每個欄位各自 safeRead，一筆失敗不拖垮其他欄位。
 */
export function useCarbonRetirement(): UseCarbonRetirementResult {
  const { chainId, provider } = useReadChain()
  const address = useMemo(() => getCarbonRetirementAddress(chainId), [chainId])

  const [summary, setSummary] = useState<RetirementSummary | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  const unavailable = address === null || provider === null

  useEffect(() => {
    if (address === null || provider === null) {
      setSummary(null)
      setError(false)
      setLoaded(true)
      return undefined
    }

    let cancelled = false
    setLoaded(false)
    setError(false)

    const c = new Contract(address, CARBON_RETIREMENT_ABI, provider)

    void (async () => {
      const [simulated, usdc, budget, totalRetiredTonnes, totalSpent, count, recentRaw] = await Promise.all([
        safeRead<boolean | null>(c.SIMULATED() as Promise<boolean>, null),
        safeRead<string | null>(c.usdc() as Promise<string>, null),
        safeRead<bigint | null>(c.budget() as Promise<bigint>, null),
        safeRead<bigint | null>(c.totalRetiredTonnes() as Promise<bigint>, null),
        safeRead<bigint | null>(c.totalSpent() as Promise<bigint>, null),
        safeRead<bigint | null>(c.retirementCount() as Promise<bigint>, null),
        safeRead<RawTuple[] | null>(c.getRecentRetirements(0n, BigInt(RECENT_LIMIT)) as Promise<RawTuple[]>, null),
      ])
      const decimals =
        usdc === null
          ? null
          : await safeRead<number | null>(
              new Contract(usdc, CARBON_ERC20_DECIMALS_ABI, provider).decimals().then(Number),
              null,
            )
      if (cancelled) return

      const recent: RawRetirement[] | null =
        recentRaw === null
          ? null
          : recentRaw.map((r) => ({
              amount: BigInt(r.amount),
              tonnesCO2e: BigInt(r.tonnesCO2e),
              timestamp: BigInt(r.timestamp),
              retiredBy: String(r.retiredBy),
            }))

      const raw: RawRetirementState = { simulated, decimals, totalRetiredTonnes, totalSpent, budget, count, recent }
      const failed = retirementReadFailed(raw) || simulationFlagContradicts(raw)
      setSummary(failed ? null : summarizeRetirements(raw))
      setError(failed)
      setLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [address, provider])

  return { unavailable, loaded, error, summary, address }
}
