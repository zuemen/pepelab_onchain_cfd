import type { Contract, BrowserProvider } from 'ethers'

import { useRef, useState, useEffect, useCallback } from 'react'

import { zeroPadValue } from 'ethers'

import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { notionalOf } from 'src/lib/pepefi/whale'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { t, interpolate } from 'src/locales'
import { UI_RETRIES, avgBlockTime, chunkRanges, scanFromBlock, getLogsChunked, isChunkScanAborted } from 'src/lib/pepefi/chainLogs'

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
  /** 重試後仍讀不到的區塊段數。> 0 時時間軸不完整，空結果必須顯示「讀取失敗」。 */
  failedChunks: number
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
  const [failedChunks, setFailedChunks] = useState(0)

  const runId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  /** 上一次抓取的 chainId:address，用來判斷是不是換了地址。 */
  const lastIdentity = useRef<string | null>(null)
  // 卸載時中止還在跑的掃描，並讓在飛的其他讀取回來後被丟棄。
  useEffect(() => () => { abortRef.current?.abort(); runId.current += 1 }, [])

  const fetchActivity = useCallback(async () => {
    // 先遞增、先中止，再判斷能不能開始：早退（例如 provider 變成 null）時，
    // 上一輪還在飛的掃描也要被中止、結果被丟棄。
    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    // 換了地址（或鏈／合約）：上一個地址的事件與部位不能掛在新地址底下，等新資料時先清空。
    // 同一個地址的重新整理則保留舊資料，避免畫面閃空。
    const identity = `${chainId ?? 0}:${address?.toLowerCase() ?? ''}`
    const identityChanged = lastIdentity.current !== identity
    lastIdentity.current = identity
    const clearData = () => {
      setEvents([])
      setPositions([])
      setScanRange(null)
      setMissing(0)
      setFailedChunks(0)
    }
    if (!contracts || !provider || !address) {
      // 上一輪可能還掛著 loading：它的 finally 因 run id 不符不會收尾，這裡收。
      clearData()
      setLoading(false)
      setProgress(null)
      return
    }
    if (identityChanged) clearData()

    setLoading(true)
    setError(null)
    setFailedChunks(0)

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
      // 掉的段不能悄悄丟掉——例如 Slashed 那一段讀不到，畫面就會像「從未被罰沒」。
      let failedChunks = 0
      const logSets = await Promise.all(
        queries.map(q => getLogsChunked(provider, q, from, latestNum, tick, () => { failedChunks += 1 }, { retries: UI_RETRIES, signal: ac.signal })),
      )
      if (isStale()) return
      setFailedChunks(failedChunks)
      if (failedChunks > 0) {
        setError(interpolate(t.traderProfile.activity.scanIncomplete, { count: failedChunks }))
      }

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
      if (isChunkScanAborted(e)) return
      console.error('[useAddressActivity]', e)
      if (runId.current === myRun) setError(t.traderProfile.activity.readError)
    } finally {
      if (runId.current === myRun) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [contracts, provider, chainId, address])

  useEffect(() => { void fetchActivity() }, [fetchActivity])

  return { events, positions, scanRange, progress, missing, loading, error, failedChunks, refetch: fetchActivity }
}
