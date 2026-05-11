import { useState, useEffect } from 'react'
import { ASSET_IDS } from '../contracts/addresses'

const COIN_MAP: Record<string, string> = {
  [ASSET_IDS.sBTC]: 'bitcoin',
  [ASSET_IDS.sETH]: 'ethereum',
}

const MOCK_INITIAL: Record<string, number> = {
  [ASSET_IDS.sAAPL]: 200,
  [ASSET_IDS.sTSLA]: 250,
}

const REFRESH_MS = 30_000

export interface LivePrice {
  usd:       number
  fetchedAt: number
  isMock:    boolean
}

export function useLivePrices(): Record<string, LivePrice> {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({})

  useEffect(() => {
    let cancelled = false
    const mockState: Record<string, number> = { ...MOCK_INITIAL }

    const fetchOnce = async () => {
      const out: Record<string, LivePrice> = {}

      try {
        const ids = Object.values(COIN_MAP).join(',')
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        )
        if (res.ok) {
          const data = (await res.json()) as Record<string, { usd: number }>
          for (const [assetId, coinId] of Object.entries(COIN_MAP)) {
            if (data[coinId]) {
              out[assetId] = { usd: data[coinId].usd, fetchedAt: Date.now(), isMock: false }
            }
          }
        }
      } catch (e) {
        console.warn('[useLivePrices] CoinGecko fetch failed:', e)
      }

      for (const [assetId] of Object.entries(MOCK_INITIAL)) {
        const cur    = mockState[assetId]
        const wiggle = 1 + (Math.random() - 0.5) * 0.04
        mockState[assetId] = cur * wiggle
        out[assetId] = { usd: mockState[assetId], fetchedAt: Date.now(), isMock: true }
      }

      if (!cancelled) setPrices(out)
    }

    void fetchOnce()
    const id = setInterval(() => void fetchOnce(), REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return prices
}
