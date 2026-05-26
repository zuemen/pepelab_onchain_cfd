import { useState, useEffect, useRef } from 'react'
import { ASSET_IDS } from 'src/contracts/addresses'

const COIN_MAP: Record<string, string> = {
  [ASSET_IDS.sBTC]: 'bitcoin',
  [ASSET_IDS.sETH]: 'ethereum',
}

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

export function useLivePrices(): Record<string, LivePrice> {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({})
  const basePrices = useRef<Record<string, number>>({ ...MOCK_INITIAL })

  useEffect(() => {
    let cancelled = false

    const fetchCG = async () => {
      try {
        const ids = Object.values(COIN_MAP).join(',')
        const res = await fetch(`/api/coingecko/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
        if (res.ok) {
          const data = await res.json() as Record<string, { usd: number }>
          for (const [assetId, coinId] of Object.entries(COIN_MAP)) {
            if (data[coinId]) {
              // Anchor to real price when fetched
              basePrices.current[assetId] = data[coinId].usd
            }
          }
        }
      } catch (e) {
        console.warn('[useLivePrices] CoinGecko fetch failed', e)
      }
    }

    const tick = () => {
      const out: Record<string, LivePrice> = {}
      for (const [id, baseUsd] of Object.entries(basePrices.current)) {
        // Wiggle the price slightly every tick (±0.2%)
        const wiggle = 1 + (Math.random() - 0.5) * 0.004
        basePrices.current[id] = baseUsd * wiggle
        out[id] = { usd: basePrices.current[id], fetchedAt: Date.now(), isMock: !COIN_MAP[id] }
      }
      if (!cancelled && Object.keys(out).length > 0) {
        setPrices(out)
      }
    }

    void fetchCG()
    const cgId = setInterval(() => void fetchCG(), 30_000)
    const tickId = setInterval(tick, 2000)

    // Initial tick to populate prices before 2s
    tick()

    return () => { cancelled = true; clearInterval(cgId); clearInterval(tickId) }
  }, [])

  return prices
}

