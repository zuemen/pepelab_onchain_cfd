import { useState, useEffect } from 'react'

import { useContracts } from 'src/hooks/useContracts'
import { useWalletContext } from 'src/contexts/wallet-context'
import { ASSET_IDS, getAddresses } from 'src/contracts/addresses'

const MOCK_INITIAL: Record<string, number> = {
  [ASSET_IDS.sBTC]:   50000,
  [ASSET_IDS.sETH]:   3000,
  [ASSET_IDS.sAAPL]:  200,
  [ASSET_IDS.sTSLA]:  250,
  [ASSET_IDS.sGOLD]:  2650,
  [ASSET_IDS.sBOND]:  100,
  [ASSET_IDS.sNVDA]:  135,
  [ASSET_IDS.sMSFT]:  420,
  [ASSET_IDS.sGOOGL]: 175,
  [ASSET_IDS.sICLN]:  14,
  [ASSET_IDS.sESGU]:  120,
}

export interface LivePrice {
  usd:       number
  fetchedAt: number
  isMock:    boolean
}

function wiggleMock(pepeAddr?: string | null): Record<string, LivePrice> {
  const out: Record<string, LivePrice> = {}
  for (const [id, base] of Object.entries(MOCK_INITIAL)) {
    const w = 1 + (Math.random() - 0.5) * 0.004
    out[id] = { usd: base * w, fetchedAt: Date.now(), isMock: true }
  }
  if (pepeAddr) {
    const w = 1 + (Math.random() - 0.5) * 0.004
    out[pepeAddr] = { usd: 0.00001337 * w, fetchedAt: Date.now(), isMock: true }
  }
  return out
}

export function useLivePrices(): Record<string, LivePrice> {
  const { provider, signer, chainId } = useWalletContext()
  const contracts = useContracts(provider, signer, chainId)
  
  const addr = getAddresses(chainId)
  const pepeAddr = addr?.PepeToken ? addr.PepeToken.toLowerCase() : null

  const [prices, setPrices] = useState<Record<string, LivePrice>>(() => wiggleMock(pepeAddr))

  useEffect(() => {
    if (!pepeAddr) return
    setPrices(prev => {
      if (prev[pepeAddr]) return prev
      return wiggleMock(pepeAddr)
    })
  }, [pepeAddr])

  useEffect(() => {
    if (!contracts?.oracle) {
      // No oracle: keep wiggling mock prices every 2s
      const id = setInterval(() => setPrices(wiggleMock(pepeAddr)), 2000)
      return () => clearInterval(id)
    }

    const tick = async () => {
      const next: Record<string, LivePrice> = {}
      for (const id of Object.values(ASSET_IDS)) {
        try {
          const raw = (await contracts.oracle.getPrice(id)) as unknown as [bigint, bigint]
          const base = Number(raw[0]) / 1e8
          next[id] = { usd: base, fetchedAt: Date.now(), isMock: false }
        } catch {
          const fallback = MOCK_INITIAL[id] ?? 100
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[id] = { usd: fallback * w, fetchedAt: Date.now(), isMock: true }
        }
      }

      // Query or wiggle PEPE price
      if (pepeAddr) {
        try {
          // Fetch real spot PEPE price from CoinGecko
          const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pepe&vs_currencies=usd');
          if (res.ok) {
            const json = await res.json();
            if (json.pepe && json.pepe.usd) {
              next[pepeAddr] = { usd: json.pepe.usd, fetchedAt: Date.now(), isMock: false }
            } else {
              throw new Error('No PEPE price in json')
            }
          } else {
            throw new Error('Fetch failed')
          }
        } catch (e) {
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[pepeAddr] = { usd: 0.00001337 * w, fetchedAt: Date.now(), isMock: true }
        }
      }

      setPrices(next)
    }

    void tick()
    const id = setInterval(() => void tick(), 8000)
    return () => clearInterval(id)
  }, [contracts, pepeAddr])

  return prices
}
