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

// Display-only live quotes from the free, keyless CoinGecko simple-price API.
// These keep the UI alive even when the on-chain keeper is idle. Settlement
// (open/close/liquidation) always uses the on-chain oracle — see `settlementUsd`.
const COINGECKO_IDS: Record<string, string> = {
  [ASSET_IDS.sBTC]: 'bitcoin',
  [ASSET_IDS.sETH]: 'ethereum',
}

export type PriceSource = 'coingecko' | 'oracle' | 'mock'

export interface LivePrice {
  usd:       number        // best display price (live source preferred)
  fetchedAt: number
  isMock:    boolean
  source:    PriceSource
  /** On-chain oracle price = the actual settlement/index price (if available). */
  settlementUsd?: number
}

function wiggleMock(pepeAddr?: string | null): Record<string, LivePrice> {
  const out: Record<string, LivePrice> = {}
  for (const [id, base] of Object.entries(MOCK_INITIAL)) {
    const w = 1 + (Math.random() - 0.5) * 0.004
    out[id] = { usd: base * w, fetchedAt: Date.now(), isMock: true, source: 'mock' }
  }
  if (pepeAddr) {
    const w = 1 + (Math.random() - 0.5) * 0.004
    out[pepeAddr] = { usd: 0.00001337 * w, fetchedAt: Date.now(), isMock: true, source: 'mock' }
  }
  return out
}

/** Fetch free CoinGecko spot prices for the display-tracked crypto ids + PEPE. */
async function fetchCoinGecko(pepeAddr?: string | null): Promise<Record<string, number>> {
  const ids = [...new Set([...Object.values(COINGECKO_IDS), ...(pepeAddr ? ['pepe'] : [])])]
  const out: Record<string, number> = {}
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
    )
    if (!res.ok) return out
    const json = await res.json()
    for (const [assetId, cgId] of Object.entries(COINGECKO_IDS)) {
      if (json[cgId]?.usd) out[assetId] = json[cgId].usd
    }
    if (pepeAddr && json.pepe?.usd) out[pepeAddr] = json.pepe.usd
  } catch {
    /* offline / rate-limited → caller falls back to oracle/mock */
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
    let cancelled = false

    const tick = async () => {
      // 1) Free, keyless display quotes (crypto + PEPE) — always tries to be live.
      const cg = await fetchCoinGecko(pepeAddr)
      const next: Record<string, LivePrice> = {}

      for (const id of Object.values(ASSET_IDS)) {
        // On-chain oracle = settlement price (source of truth for open/close).
        let settlement: number | undefined
        if (contracts?.oracle) {
          try {
            const raw = (await contracts.oracle.getPrice(id)) as unknown as [bigint, bigint]
            settlement = Number(raw[0]) / 1e8
          } catch { /* asset not on oracle */ }
        }

        const cgPrice = cg[id]
        if (cgPrice !== undefined) {
          // Crypto with a live CoinGecko quote → show it; keep oracle as settlement.
          next[id] = { usd: cgPrice, fetchedAt: Date.now(), isMock: false, source: 'coingecko', settlementUsd: settlement }
        } else if (settlement !== undefined) {
          // Stocks / RWA → on-chain oracle is the live display + settlement.
          next[id] = { usd: settlement, fetchedAt: Date.now(), isMock: false, source: 'oracle', settlementUsd: settlement }
        } else {
          const fallback = MOCK_INITIAL[id] ?? 100
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[id] = { usd: fallback * w, fetchedAt: Date.now(), isMock: true, source: 'mock' }
        }
      }

      if (pepeAddr) {
        const cgPepe = cg[pepeAddr]
        if (cgPepe !== undefined) {
          next[pepeAddr] = { usd: cgPepe, fetchedAt: Date.now(), isMock: false, source: 'coingecko' }
        } else {
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[pepeAddr] = { usd: 0.00001337 * w, fetchedAt: Date.now(), isMock: true, source: 'mock' }
        }
      }

      if (!cancelled) setPrices(next)
    }

    void tick()
    const id = setInterval(() => void tick(), 8000)
    return () => { cancelled = true; clearInterval(id) }
  }, [contracts, pepeAddr])

  return prices
}
