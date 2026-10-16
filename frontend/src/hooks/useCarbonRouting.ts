import type { Provider } from 'ethers'

import { Contract } from 'ethers'
import { useState, useEffect } from 'react'

import { getAddresses } from 'src/contracts/deployment'
import { safeRead } from 'src/lib/pepefi/safeRead'
import {
  COPY_FEE_ABI,
  FEE_SPLITTER_ABI,
  FEE_ROUTER_PAYEE_ABI,
  CARBON_RETIREMENT_ABI,
  CARBON_ERC20_DECIMALS_ABI,
} from 'src/contracts/carbonRetirement'

/** 跟單費 → 平台份額 → 退役預算這條路上每一個寫死在合約裡的數字（#333）。 */
export interface CarbonRouting {
  splitter: string
  retirement: string
  /** CopyTracker.COPY_FEE_BPS；讀不到時為 null（畫面不顯示估算）。 */
  copyFeeBps: bigint | null
  platformShareBps: bigint
  carbonShareBps: bigint
  pricePerTonne: bigint
  /** 結算幣 decimals；讀不到時為 null。 */
  decimals: number | null
}

const isAddr = (a: unknown): a is string =>
  typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)

/**
 * 從這條鏈的 FeeRouter 找出分流與退役合約，讀出比例與模擬價格。FeeRouter 的平台收款人
 * 不是分流合約（例如 cutover 前的 Base Sepolia，收款人是 EOA）就回 null——這條鏈沒有碳權退役，
 * 畫面上相關的區塊整塊不顯示。全部唯讀。
 */
export function useCarbonRouting(
  provider: Provider | null,
  chainId: number | null,
): { routing: CarbonRouting | null; loaded: boolean } {
  const [routing, setRouting] = useState<CarbonRouting | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const addr = getAddresses(chainId)
    if (!provider || !addr || !isAddr(addr.FeeRouter)) {
      setRouting(null)
      setLoaded(true)
      return undefined
    }
    let cancelled = false
    setLoaded(false)

    void (async () => {
      const router = new Contract(addr.FeeRouter, FEE_ROUTER_PAYEE_ABI, provider)
      const [payee, platformShareBps] = await Promise.all([
        safeRead<string | null>(router.platformTreasury() as Promise<string>, null),
        safeRead<bigint | null>(router.PLATFORM_SHARE_BPS() as Promise<bigint>, null),
      ])
      let found: CarbonRouting | null = null
      if (isAddr(payee) && platformShareBps !== null) {
        const splitter = new Contract(payee, FEE_SPLITTER_ABI, provider)
        const [retirement, carbonShareBps] = await Promise.all([
          safeRead<string | null>(splitter.carbonRetirement() as Promise<string>, null),
          safeRead<bigint | null>(splitter.carbonShareBps() as Promise<bigint>, null),
        ])
        if (isAddr(retirement) && carbonShareBps !== null) {
          const r = new Contract(retirement, CARBON_RETIREMENT_ABI, provider)
          const [pricePerTonne, usdc, copyFeeBps] = await Promise.all([
            safeRead<bigint | null>(r.pricePerTonne() as Promise<bigint>, null),
            safeRead<string | null>(r.usdc() as Promise<string>, null),
            isAddr(addr.CopyTracker)
              ? safeRead<bigint | null>(
                  new Contract(addr.CopyTracker, COPY_FEE_ABI, provider).COPY_FEE_BPS() as Promise<bigint>,
                  null,
                )
              : Promise.resolve(null),
          ])
          const decimals = isAddr(usdc)
            ? await safeRead<number | null>(
                new Contract(usdc, CARBON_ERC20_DECIMALS_ABI, provider).decimals().then(Number),
                null,
              )
            : null
          if (pricePerTonne !== null) {
            found = {
              splitter: payee,
              retirement,
              copyFeeBps,
              platformShareBps,
              carbonShareBps,
              pricePerTonne,
              decimals,
            }
          }
        }
      }
      if (cancelled) return
      setRouting(found)
      setLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [provider, chainId])

  return { routing, loaded }
}
