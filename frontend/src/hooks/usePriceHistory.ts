import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import type { BrowserProvider } from 'ethers'
import type { LivePrice } from './useLivePrices'

export interface PricePoint { time: number; price: number }
export type PriceHistory = Record<string, PricePoint[]>

const LS_KEY      = 'ph-snapshots-v1'
const MAX_SNAPS   = 200
const FETCH_BLOCKS = 50_000

type SnapStore = Record<string, PricePoint[]>

function loadSnaps(): SnapStore {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as SnapStore }
  catch { return {} }
}

function saveSnap(assetId: string, price: number) {
  try {
    const store = loadSnaps()
    const pts   = store[assetId] ?? []
    const now   = Math.floor(Date.now() / 1000)
    const last  = pts[pts.length - 1]
    if (last && now - last.time < 60) return   // rate-limit: 1 snapshot per minute
    pts.push({ time: now, price })
    store[assetId] = pts.slice(-MAX_SNAPS)
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch { /* storage full — ignore */ }
}

export function usePriceHistory(
  oracle:     Contract | null,
  provider:   BrowserProvider | null,
  assetIds:   string[],
  livePrices: Record<string, LivePrice>,
): { history: PriceHistory; loading: boolean } {
  const [history, setHistory] = useState<PriceHistory>({})
  const [loading, setLoading] = useState(false)

  // Persist a snapshot on every live-price tick (rate-limited inside saveSnap)
  useEffect(() => {
    for (const id of assetIds) {
      const lp = livePrices[id]
      if (lp) saveSnap(id, lp.usd)
    }
  // assetIds is a module-level constant — omitting from deps is safe
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrices])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const assetKey = assetIds.join(',')

  const fetchHistory = useCallback(async () => {
    if (!oracle) return
    setLoading(true)
    try {
      let fromBlock = 0
      if (provider) {
        const cur = await provider.getBlockNumber()
        fromBlock = Math.max(0, cur - FETCH_BLOCKS)
      }
      const snapStore = loadSnaps()
      const out: PriceHistory = {}

      await Promise.all(
        assetIds.map(async (id) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const logs = await oracle.queryFilter(oracle.filters.PriceUpdated(id), fromBlock, 'latest') as any[]
            const chainPts: PricePoint[] = logs.map(log => ({
              time:  Number(log.args.timestamp as bigint),
              // Oracle stores price with 8 decimals
              price: Number(log.args.newPrice as bigint) / 1e8,
            }))
            const merged = [...(snapStore[id] ?? []), ...chainPts].sort((a, b) => a.time - b.time)
            const seen = new Set<number>()
            const deduped: PricePoint[] = []
            for (const pt of merged) {
              if (!seen.has(pt.time)) { seen.add(pt.time); deduped.push(pt) }
            }
            out[id] = deduped
          } catch {
            out[id] = snapStore[id] ?? []
          }
        }),
      )
      setHistory(out)
    } finally { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracle, provider, assetKey])

  useEffect(() => { void fetchHistory() }, [fetchHistory])

  return { history, loading }
}
