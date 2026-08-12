import type { Contract, BrowserProvider } from 'ethers'

import { useRef, useState, useEffect, useCallback } from 'react'

import { zeroPadValue } from 'ethers'

import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { notionalOf } from 'src/lib/pepefi/whale'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { avgBlockTime, chunkRanges, scanFromBlock, getLogsChunked } from 'src/lib/pepefi/chainLogs'

// 單一地址的鏈上足跡：跨 Exchange / CopyTracker / TraderStake 的事件時間軸，
// 加上目前還開著的部位。
//
// 這份邏輯原本長在 WhaleTrackerPage 的 `doSearch` 裡。搬出來是因為它回答的是
// 「這個人做了什麼」，而那是 /trader/:address 的問題；whale tracker 回答的是
// 「錢往哪流」。兩頁各做一半的結果是：whale 頁看得到交易紀錄卻沒有 follower /
// stake / reputation，profile 頁有那些卻看不到任何一筆交易。
//
// 搬家時補了一個洞：**PositionLiquidated**。舊版只掃 opened / closed，於是被
// 清算的部位在時間軸上是憑空消失的——開倉那一列還在，然後就沒有下文了。

export type AddressEventKind =
  | 'PositionOpened' | 'PositionClosed' | 'PositionLiquidated'
  | 'Following' | 'FollowedBy'
  | 'Staked' | 'Slashed'

export interface AddressEvent {
  kind:        AddressEventKind
  txHash:      string
  blockNumber: number
  logIndex:    number
  timestamp:   number
  timestampExact: boolean
  details:     Record<string, unknown>
}

export interface AddressPosition {
  id:         string
  asset:      string
  assetLabel: string
  isLong:     boolean
  entryPrice: bigint
  /** null = 沒讀到，不是 0。 */
  markPrice:  bigint | null
  margin:     bigint
  leverage:   bigint
  notional:   bigint
  pnl:        bigint | null
}

export interface AddressActivity {
  events:    AddressEvent[]
  positions: AddressPosition[]
  scanRange: { from: number; to: number } | null
  progress:  { done: number; total: number } | null
  /** 讀不到的部位數。限流不該被靜默翻譯成「這個部位不存在」。 */
  missing:   number
  loading:   boolean
  error:     string | null
  refetch:   () => void
}

/** 為多少個區塊補真實時間戳。其餘用出塊時間推估，UI 會標上 `~`。 */
const EXACT_TIMESTAMP_BLOCKS = 40

interface RawPosition {
  asset: string; isLong: boolean; isOpen: boolean
  entryPrice: bigint; margin: bigint; leverage: bigint
}

interface Contracts {
  exchange:    Contract
  copyTracker: Contract
  traderStake: Contract
}

export function useAddressActivity(
  contracts: Contracts | null,
  provider:  BrowserProvider | null,
  chainId:   number | null,
  address:   string | undefined,
): AddressActivity {
  const [events,    setEvents]    = useState<AddressEvent[]>([])
  const [positions, setPositions] = useState<AddressPosition[]>([])
  const [scanRange, setScanRange] = useState<{ from: number; to: number } | null>(null)
  const [progress,  setProgress]  = useState<{ done: number; total: number } | null>(null)
  const [missing,   setMissing]   = useState(0)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const runId = useRef(0)

  const fetchActivity = useCallback(async () => {
    if (!contracts || !provider || !address) return

    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun

    setLoading(true)
    setError(null)

    try {
      // 同 useExchangeActivity：這一發被擠掉的話整頁沒有掃描範圍。
      const latestBlock = await withRetry(() => provider.getBlock('latest'))
      if (!latestBlock || isStale()) return
      const { number: latestNum, timestamp: latestTs } = latestBlock

      const from = scanFromBlock({ chainId, currentBlock: latestNum })
      const blockTime = avgBlockTime(chainId)
      setScanRange({ from, to: latestNum })

      const { exchange, copyTracker, traderStake } = contracts
      const addrTopic = zeroPadValue(address, 32).toLowerCase()

      // 七個 filter 併成四趟。topics[0] 傳陣列是 OR，而同一個合約上共用同一個
      // indexed 位置的事件可以一起問：
      //   - Exchange 的 Opened / Closed / Liquidated，owner 都在 topics[2]
      //   - TraderStake 的 Staked / Slashed，trader 都在 topics[1]
      //   - CopyTracker 的 TraderFollowed 要分兩趟，因為「我跟別人」和「別人跟我」
      //     是同一個事件的不同 topic 位置，OR 不了。
      const exTopic = (n: string) => exchange.interface.getEvent(n)!.topicHash
      const stTopic = (n: string) => traderStake.interface.getEvent(n)!.topicHash
      const ctFollowed = copyTracker.interface.getEvent('TraderFollowed')!.topicHash

      const queries = [
        { address: exchange.target as string,
          topics: [[exTopic('PositionOpened'), exTopic('PositionClosed'), exTopic('PositionLiquidated')], null, addrTopic] },
        { address: traderStake.target as string,
          topics: [[stTopic('Staked'), stTopic('Slashed')], addrTopic] },
        { address: copyTracker.target as string, topics: [ctFollowed, addrTopic] },
        { address: copyTracker.target as string, topics: [ctFollowed, null, addrTopic] },
      ]

      const totalChunks = chunkRanges(from, latestNum).length * queries.length
      let doneChunks = 0
      setProgress({ done: 0, total: totalChunks })
      const tick = () => {
        doneChunks += 1
        if (!isStale()) setProgress({ done: doneChunks, total: totalChunks })
      }

      const ifaceFor = [exchange.interface, traderStake.interface, copyTracker.interface, copyTracker.interface]
      const logSets = await Promise.all(
        queries.map(q => getLogsChunked(provider, q, from, latestNum, tick)),
      )
      if (isStale()) return

      const lowerAddr = address.toLowerCase()
      const rows: AddressEvent[] = []
      const seenLog = new Set<string>()

      for (const [qi, logs] of logSets.entries()) {
        for (const log of logs) {
          // 最後兩趟問的是同一個事件的兩個角色，自己跟自己時會兩邊都回來。
          const dedupeKey = `${log.transactionHash}-${log.index ?? log.logIndex ?? 0}`
          if (seenLog.has(dedupeKey)) continue
          seenLog.add(dedupeKey)

          const parsed = ifaceFor[qi].parseLog({ topics: [...log.topics], data: log.data })
          if (!parsed) continue
          const a = parsed.args

          const kind: AddressEventKind =
            parsed.name === 'TraderFollowed'
              ? (String(a.follower).toLowerCase() === lowerAddr ? 'Following' : 'FollowedBy')
              : (parsed.name as AddressEventKind)

          const details: Record<string, unknown> =
            kind === 'PositionOpened'     ? { asset: a.asset, isLong: a.isLong, entryPrice: a.entryPrice, margin: a.margin, leverage: a.leverage }
            : kind === 'PositionClosed'     ? { pnl: a.pnl, closeAmount: a.closeAmount }
            : kind === 'PositionLiquidated' ? { pnl: a.pnl, liquidator: a.liquidator }
            : kind === 'Following'          ? { trader: a.trader, totalMargin: a.totalMargin }
            : kind === 'FollowedBy'         ? { follower: a.follower, totalMargin: a.totalMargin }
            : kind === 'Staked'             ? { amount: a.amount }
            :                                 { amount: a.amount, recipient: a.recipient }

          rows.push({
            kind,
            txHash:      log.transactionHash,
            blockNumber: Number(log.blockNumber),
            logIndex:    Number(log.index ?? log.logIndex ?? 0),
            timestamp:   latestTs - (latestNum - Number(log.blockNumber)) * blockTime,
            timestampExact: false,
            details,
          })
        }
      }

      rows.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)

      // 只為畫面最上面那些補真實時間戳；其餘留推估值並在 UI 上標記。
      const wantExact = [...new Set(rows.slice(0, EXACT_TIMESTAMP_BLOCKS).map(r => r.blockNumber))]
      if (wantExact.length > 0) {
        const blocks = await mapLimit(wantExact, RPC_CONCURRENCY, async (bn) => {
          try { return [bn, Number((await withRetry(() => provider.getBlock(bn)))?.timestamp ?? 0)] as const }
          catch { return [bn, 0] as const }
        })
        if (isStale()) return
        const tsByBlock = new Map(blocks.filter(([, ts]) => ts > 0))
        for (const r of rows) {
          const ts = tsByBlock.get(r.blockNumber)
          if (ts !== undefined) { r.timestamp = ts; r.timestampExact = true }
        }
      }

      if (isStale()) return
      setEvents(rows)

      // ── 目前未平倉 ────────────────────────────────────────────────────────
      // 用 getUserPositions 而不是從事件推：它是鏈上的權威清單，也涵蓋掃描
      // 視窗之前就開著的倉——那些倉的 PositionOpened 早就掉出視窗了。
      const ids = await (async () => {
        try { return (await exchange.getUserPositions(address)) as bigint[] }
        catch { return [] as bigint[] }
      })()
      if (isStale()) return

      const raw = await mapLimit(ids, RPC_CONCURRENCY, async (id) => {
        try { return { id, p: await withRetry(() => exchange.getPosition(id)) as unknown as RawPosition } }
        catch { return null }
      })
      if (isStale()) return

      const readable = raw.filter((r): r is NonNullable<typeof r> => r !== null)
      const open = readable.filter(r => r.p.isOpen)

      const assets = [...new Set(open.map(r => r.p.asset))]
      const prices = await mapLimit(assets, RPC_CONCURRENCY, async (a) => {
        try { return [a, await withRetry(() => exchange.getMarkPrice(a)) as bigint] as const }
        catch { return [a, null] as const }
      })
      if (isStale()) return
      const priceByAsset = new Map(prices)

      const pnls = await mapLimit(open, RPC_CONCURRENCY, async (r) => {
        try { return await withRetry(() => exchange.getUnrealizedPnL(r.id)) as bigint }
        catch { return null }
      })
      if (isStale()) return

      setMissing(ids.length - readable.length)
      setPositions(open.map((r, i) => ({
        id:         String(r.id),
        asset:      r.p.asset,
        assetLabel: ASSET_LABEL[r.p.asset] ?? '?',
        isLong:     r.p.isLong,
        entryPrice: r.p.entryPrice,
        markPrice:  priceByAsset.get(r.p.asset) ?? null,
        margin:     r.p.margin,
        leverage:   r.p.leverage,
        notional:   notionalOf(r.p.margin, r.p.leverage),
        pnl:        pnls[i],
      })))
    } catch (e) {
      console.error('[useAddressActivity]', e)
      if (runId.current === myRun) setError('Could not read this address’s on-chain history. The RPC node may be rate-limiting.')
    } finally {
      if (runId.current === myRun) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [contracts, provider, chainId, address])

  useEffect(() => { void fetchActivity() }, [fetchActivity])

  return { events, positions, scanRange, progress, missing, loading, error, refetch: fetchActivity }
}
