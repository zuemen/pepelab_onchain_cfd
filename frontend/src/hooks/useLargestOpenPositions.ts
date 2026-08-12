import type { Contract } from 'ethers'

import type { WhaleTag } from 'src/lib/pepefi/whale'
import type { OpenedTrade } from './useExchangeActivity'

import { useRef, useMemo, useState, useEffect, useCallback } from 'react'

import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { notionalOf, positionProfile } from 'src/lib/pepefi/whale'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

// 目前最大的未平倉部位。
//
// 取值策略是為了不讓「排名」變成一次全表掃描：`margin × leverage` 就在
// PositionOpened 事件裡，所以**排序完全不需要 RPC**，只有真的會顯示出來的
// 那幾列才去鏈上取值。舊的 WhaleTrackerPage 反過來——它對某個地址的每一個
// position id 都發 getPosition + getUnrealizedPnL + getPrice，然後才知道哪些
// 還開著。
//
// 但事件裡的 margin 不能當最終答案：depositMargin / withdrawMargin 會改
// 已開部位的保證金，於是名目也跟著變。所以用事件排出候選之後，仍然要對
// 候選發 getPosition 拿權威值，再用權威值重排一次。多抓 HEADROOM 筆是因為
// 過濾掉已平倉的之後還要湊得滿 limit 筆。

/** 候選比 limit 多抓幾筆，濾掉已平倉的之後才不會不足額。 */
const HEADROOM = 6

export interface LiveOpenPosition {
  positionId: string
  owner:      string
  asset:      string
  assetLabel: string
  isLong:     boolean
  entryPrice: bigint
  /** 18-dec。null = 這一列的價格沒讀到，不要拿 0 冒充。 */
  markPrice:  bigint | null
  margin:     bigint
  leverage:   bigint
  /** 鏈上權威值：getPosition 的 margin × leverage，不是事件裡的舊值。 */
  notional:   bigint
  /** null = 沒讀到。0 是一個合法的 PnL，不能用它表示「不知道」。 */
  pnl:        bigint | null
  openedAt:   number
  tags:       WhaleTag[]
}

export interface LargestOpenPositions {
  rows:    LiveOpenPosition[]
  /** 候選裡讀不到的筆數。RPC 限流不該被靜默翻譯成「這個部位不存在」。 */
  missing: number
  loading: boolean
  error:   string | null
  refetch: () => void
}

interface RawPosition {
  owner:      string
  asset:      string
  isLong:     boolean
  entryPrice: bigint
  margin:     bigint
  leverage:   bigint
  openedAt:   bigint
  isOpen:     boolean
}

export function useLargestOpenPositions(
  exchange:   Contract | null,
  candidates: OpenedTrade[],
  limit = 10,
): LargestOpenPositions {
  const [rows,    setRows]    = useState<LiveOpenPosition[]>([])
  const [missing, setMissing] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const runId = useRef(0)

  // candidates 已經依事件名目排好序（useExchangeActivity 用 useMemo 保住識別，
  // 否則這個 effect 會每次 render 重跑）。
  const shortlist = useMemo(
    () => candidates.slice(0, limit + HEADROOM).map(c => ({ id: c.positionId, isFirstSeen: c.isFirstSeen })),
    [candidates, limit],
  )

  const fetchPositions = useCallback(async () => {
    if (!exchange) return
    if (shortlist.length === 0) { setRows([]); setMissing(0); return }

    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun

    setLoading(true)
    setError(null)

    try {
      // ── 1. 候選的權威狀態 ───────────────────────────────────────────────
      const raw = await mapLimit(shortlist, RPC_CONCURRENCY, async (c) => {
        try {
          const p = await withRetry(() => exchange.getPosition(c.id)) as unknown as RawPosition
          return { ...c, p }
        } catch {
          return null
        }
      })
      if (isStale()) return

      const ok = raw.filter((r): r is NonNullable<typeof r> => r !== null)
      const unreadable = shortlist.length - ok.length

      // ── 2. 只留還開著的，用鏈上的 margin 重排 ────────────────────────────
      const live = ok
        .filter(r => r.p.isOpen)
        .map(r => ({
          positionId: r.id,
          isFirstSeen: r.isFirstSeen,
          owner:      (r.p.owner as string).toLowerCase(),
          asset:      r.p.asset as string,
          assetLabel: ASSET_LABEL[r.p.asset as string] ?? '?',
          isLong:     r.p.isLong,
          entryPrice: r.p.entryPrice,
          margin:     r.p.margin,
          leverage:   r.p.leverage,
          notional:   notionalOf(r.p.margin, r.p.leverage),
          openedAt:   Number(r.p.openedAt),
        }))
        .sort((a, b) => (b.notional > a.notional ? 1 : b.notional < a.notional ? -1 : 0))
        .slice(0, limit)

      if (live.length === 0) {
        if (!isStale()) { setRows([]); setMissing(unreadable) }
        return
      }

      // ── 3. 每個市場一次 mark price，不是每一列一次 ──────────────────────
      // 用 getMarkPrice 而不是 oracle.getPrice：mark 帶了多空失衡的溢價，
      // 而且它正是合約算 getUnrealizedPnL 用的價格。取 oracle 的原始指數價會
      // 讓「現價」與「未實現損益」出自兩個不同的數字，兩欄互相對不起來。
      const assets = [...new Set(live.map(r => r.asset))]
      const prices = await mapLimit(assets, RPC_CONCURRENCY, async (a) => {
        try { return [a, await withRetry(() => exchange.getMarkPrice(a)) as bigint] as const }
        catch { return [a, null] as const }
      })
      if (isStale()) return
      const priceByAsset = new Map(prices)

      // ── 4. 只為顯示出來的那幾列取未實現損益 ─────────────────────────────
      const pnls = await mapLimit(live, RPC_CONCURRENCY, async (r) => {
        try { return await withRetry(() => exchange.getUnrealizedPnL(r.positionId)) as bigint }
        catch { return null }
      })
      if (isStale()) return

      setMissing(unreadable)
      setRows(live.map((r, i) => ({
        positionId: r.positionId,
        owner:      r.owner,
        asset:      r.asset,
        assetLabel: r.assetLabel,
        isLong:     r.isLong,
        entryPrice: r.entryPrice,
        markPrice:  priceByAsset.get(r.asset) ?? null,
        margin:     r.margin,
        leverage:   r.leverage,
        notional:   r.notional,
        pnl:        pnls[i],
        openedAt:   r.openedAt,
        tags:       positionProfile({
          notional:    r.notional,
          leverage:    r.leverage,
          isFirstSeen: r.isFirstSeen,
        }),
      })))
    } catch (e) {
      console.error('[useLargestOpenPositions]', e)
      if (runId.current === myRun) setError('Could not read open positions from the exchange.')
    } finally {
      if (runId.current === myRun) setLoading(false)
    }
  }, [exchange, shortlist, limit])

  useEffect(() => { void fetchPositions() }, [fetchPositions])

  return { rows, missing, loading, error, refetch: fetchPositions }
}
