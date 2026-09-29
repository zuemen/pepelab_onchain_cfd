import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import type { BrowserProvider } from 'ethers'
import type { LivePrice } from './useLivePrices'

import { CHUNK_SIZE, scanContractEvents } from 'src/lib/pepefi/chainLogs'

export interface PricePoint { time: number; price: number }
export type PriceHistory = Record<string, PricePoint[]>

const LS_KEY      = 'ph-snapshots-v1'
const MAX_SNAPS   = 200
// 回看塊數。以前是單次 queryFilter 掃 50,000 塊——公開節點的 getLogs 上限只有
// 1,000 塊（見 chainLogs.ts 的實測），那一發請求必定失敗、被 catch 吞成「沒有鏈上歷史」。
// 現在走分段掃描，30 段 × CHUNK_SIZE。
const FETCH_BLOCKS = 30 * CHUNK_SIZE

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
): { history: PriceHistory; loading: boolean; failed: boolean } {
  const [history, setHistory] = useState<PriceHistory>({})
  const [loading, setLoading] = useState(false)
  /** 鏈上事件讀取失敗（或不完整）。此時 history 只有本機快照，不代表「沒有鏈上歷史」。 */
  const [failed, setFailed] = useState(false)

  // Persist a snapshot on every live-price tick (rate-limited inside saveSnap)
  useEffect(() => {
    for (const id of assetIds) {
      const lp = livePrices[id]
      // 無價格（null）不寫快照——否則歷史圖會被 0 或假值污染。
      if (lp && lp.usd !== null) saveSnap(id, lp.usd)
    }
  // assetIds is a module-level constant — omitting from deps is safe
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrices])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const assetKey = assetIds.join(',')

  const fetchHistory = useCallback(async () => {
    if (!oracle || !provider) return
    setLoading(true)
    const snapStore = loadSnaps()
    const chainPts: Record<string, PricePoint[]> = {}
    let readFailed = false
    try {
      const cur = await provider.getBlockNumber()
      const fromBlock = Math.max(0, cur - FETCH_BLOCKS + 1)
      // 一趟掃所有標的的 PriceUpdated（不帶 assetId 條件），在本地分桶——
      // 每個標的各掃一遍等於同樣的答案付 N 倍的 getLogs。
      const r = await scanContractEvents(
        provider,
        oracle,
        [oracle.filters.PriceUpdated()],
        fromBlock,
        cur,
        { retries: 2 },
      )
      readFailed = r.failedChunks > 0
      for (const log of r.events) {
        const id = String(log.args.assetId)
        ;(chainPts[id] ??= []).push({
          time:  Number(log.args.timestamp as bigint),
          // Oracle stores price with 8 decimals
          price: Number(log.args.newPrice as bigint) / 1e8,
        })
      }
    } catch {
      readFailed = true
    }

    const out: PriceHistory = {}
    for (const id of assetIds) {
      const merged = [...(snapStore[id] ?? []), ...(chainPts[id] ?? [])].sort((a, b) => a.time - b.time)
      const seen = new Set<number>()
      const deduped: PricePoint[] = []
      for (const pt of merged) {
        if (!seen.has(pt.time)) { seen.add(pt.time); deduped.push(pt) }
      }
      out[id] = deduped
    }
    setHistory(out)
    setFailed(readFailed)
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracle, provider, assetKey])

  useEffect(() => { void fetchHistory() }, [fetchHistory])

  return { history, loading, failed }
}
