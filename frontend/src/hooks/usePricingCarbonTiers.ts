import type { Tier } from 'src/lib/pepefi/carbon'

import { Contract } from 'ethers'
import { useMemo, useState, useEffect } from 'react'

import { useCarbonTiers } from 'src/hooks/useCarbonTiers'
import ESGRegistryV2ABI from 'src/contracts/abi/ESGRegistryV2.json'
import { safeRead, isDeployed } from 'src/lib/pepefi/safeRead'

export interface PricingCarbonTiers {
  /** 資產 id（bytes32）的等級；讀不到（或這條鏈沒有碳定價）時為 null＝未知。 */
  tierOf: (assetId: string) => Tier | null
  loaded: boolean
}

/**
 * #333：交易所定價實際用的碳分級——exchange.esgRegistry() 的 medianCarbonTier。持倉的碳分級組成
 * 用它，所以畫面上的分級和手續費、槓桿上限讀的是同一份見證。讀不到的資產回 null（未知），
 * 不從靜態 metadata 補：那是另一個來源（見 useCarbonTiers 頂部註解）。
 */
export function usePricingCarbonTiers(exchange: Contract | null): PricingCarbonTiers {
  const [registry, setRegistry] = useState<Contract | null>(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (!exchange || !isDeployed(exchange.target)) {
      setRegistry(null)
      setResolved(true)
      return undefined
    }
    let cancelled = false
    setResolved(false)
    void (async () => {
      const addr = await safeRead<string | null>(exchange.esgRegistry() as Promise<string>, null)
      if (cancelled) return
      const runner = exchange.runner
      setRegistry(addr && isDeployed(addr) && runner ? new Contract(addr, ESGRegistryV2ABI, runner) : null)
      setResolved(true)
    })()
    return () => {
      cancelled = true
    }
  }, [exchange])

  const tiers = useCarbonTiers(registry)
  const tierOf = useMemo(() => {
    const data = tiers.data
    return (assetId: string): Tier | null => data[assetId.toLowerCase()]?.tier ?? null
  }, [tiers.data])

  return { tierOf, loaded: resolved && tiers.loaded }
}
