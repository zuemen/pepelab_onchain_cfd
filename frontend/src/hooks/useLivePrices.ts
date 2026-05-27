import { useState, useEffect } from 'react'

import { useContracts } from 'src/hooks/useContracts'
import { useWalletContext } from 'src/contexts/wallet-context'
import { ASSET_IDS } from 'src/contracts/addresses'

const MOCK_INITIAL: Record<string, number> = {
  [ASSET_IDS.sBTC]:   81000,
  [ASSET_IDS.sETH]:   2300,
  [ASSET_IDS.sAAPL]:  200,
  [ASSET_IDS.sTSLA]:  250,
  [ASSET_IDS.sGOLD]:  2650,
  [ASSET_IDS.sBOND]:  100,
  [ASSET_IDS.sNVDA]:  1100,
  [ASSET_IDS.sMSFT]:  415,
  [ASSET_IDS.sGOOGL]: 170,
  [ASSET_IDS.sICLN]:  13,
  [ASSET_IDS.sESGU]:  45,
}

export interface LivePrice {
  usd:       number
  fetchedAt: number
  isMock:    boolean
}

function wiggleMock(): Record<string, LivePrice> {
  const out: Record<string, LivePrice> = {}
  for (const [id, base] of Object.entries(MOCK_INITIAL)) {
    const w = 1 + (Math.random() - 0.5) * 0.004
    out[id] = { usd: base * w, fetchedAt: Date.now(), isMock: true }
  }
  return out
}

export function useLivePrices(): Record<string, LivePrice> {
  const { provider, signer, chainId } = useWalletContext()
  const contracts = useContracts(provider, signer, chainId)
  const [prices, setPrices] = useState<Record<string, LivePrice>>(wiggleMock)

  useEffect(() => {
    if (!contracts?.oracle) {
      // No oracle: keep wiggling mock prices every 2s
      const id = setInterval(() => setPrices(wiggleMock()), 2000)
      return () => clearInterval(id)
    }

    const tick = async () => {
      const next: Record<string, LivePrice> = {}
      for (const id of Object.values(ASSET_IDS)) {
        try {
          const raw = (await contracts.oracle.getPrice(id)) as unknown as [bigint, bigint]
          const base = Number(raw[0]) / 1e8
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[id] = { usd: base * w, fetchedAt: Date.now(), isMock: false }
        } catch {
          const fallback = MOCK_INITIAL[id] ?? 100
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[id] = { usd: fallback * w, fetchedAt: Date.now(), isMock: true }
        }
      }
      setPrices(next)
    }

    void tick()
    const id = setInterval(() => void tick(), 8000)
    return () => clearInterval(id)
  }, [contracts])

  return prices
}
