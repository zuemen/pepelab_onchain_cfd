import type { Contract, BrowserProvider } from 'ethers'

import { useRef, useMemo, useState, useEffect, useCallback } from 'react'

import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { notionalOf, isWhaleTrade, WHALE_THRESHOLD } from 'src/lib/pepefi/whale'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { avgBlockTime, chunkRanges, scanFromBlock, getLogsChunked } from 'src/lib/pepefi/chainLogs'

// 交易所活動的單一掃描來源。
//
// 在這個 hook 之前，同一份 PositionOpened 被掃了兩次：WhaleTrackerPage 的
// fetchGlobal 掃一次組排行榜，useWhaleAlerts 再掃一次組 whale banner。兩邊
// 各自最多 40 段序列 getLogs，所以只要有一頁同時用到兩者，成本就直接翻倍。
//
// 掃描本身也漏了一個事件：**PositionLiquidated**。舊版把「還開著的部位」
// 算成 `opened.length - closed.length`，但被清算的部位不會發 PositionClosed，
// 於是它們永遠留在未平倉的帳上——未平倉數被高估，而且清算掉的部位還會出現
// 在「目前最大未平倉」裡。三個事件一起掃才問得出正確的答案。

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * 最多為幾個區塊補真實的時間戳。
 *
 * 其餘的用「最新塊時間 − 塊差 × 出塊時間」推估：在 OP Stack 這種固定出塊的鏈上
 * 誤差很小，而且不用為了 feed 裡的每一列多送一次 RPC。只有真的會顯示出來的
 * 那些（feed 開頭）值得花一次 getBlock 換取精確值。
 */
const EXACT_TIMESTAMP_BLOCKS = 40

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenedTrade {
  positionId:  string
  txHash:      string
  blockNumber: number
  logIndex:    number
  /** Unix 秒。exact 為 false 時是用出塊時間推估的。 */
  timestamp:   number
  timestampExact: boolean
  owner:       string
  asset:       string
  assetLabel:  string
  isLong:      boolean
  entryPrice:  bigint
  margin:      bigint
  leverage:    bigint
  /** margin × leverage，18-dec。直接來自事件，排序不需要任何額外 RPC。 */
  notional:    bigint
  /** 這個地址在本次掃描視窗內的第一筆活動。 */
  isFirstSeen: boolean
  /** null = 仍未平倉。 */
  exitedBy:    'closed' | 'liquidated' | null
}

export interface ExitEvent {
  positionId:  string
  owner:       string
  pnl:         bigint
  txHash:      string
  blockNumber: number
  liquidated:  boolean
}

export interface ActivityTotals {
  openedCount:   number
  whaleCount:    number
  openCount:     number
  /** 視窗內所有開倉的名目總和。 */
  volume:        bigint
  /** 目前仍未平倉的名目總和。 */
  openNotional:  bigint
}

export interface ExchangeActivity {
  /** 視窗內所有開倉，新到舊。 */
  opened:     OpenedTrade[]
  /** 只留鯨魚（單筆 notional ≥ WHALE_THRESHOLD），新到舊。 */
  feed:       OpenedTrade[]
  /**
   * 仍未平倉，依 notional 由大到小。
   *
   * 「未平倉」是由事件推出來的，所以只涵蓋**在掃描視窗內開的**部位；視窗之前
   * 就開著的倉看不到（它的 PositionOpened 不在範圍內）。這是覆蓋率的限制，
   * 不是正確性的問題——在視窗內開的倉，它的平倉/清算必然也在視窗內。
   * 全站的未平倉總額請讀 useMarketSentiment，那個直接問合約。
   */
  openTrades: OpenedTrade[]
  exits:      ExitEvent[]
  totals:     ActivityTotals
  scanRange:  { from: number; to: number } | null
  progress:   { done: number; total: number } | null
  loading:    boolean
  error:      string | null
  refetch:    () => void
}

const EMPTY_TOTALS: ActivityTotals = {
  openedCount: 0, whaleCount: 0, openCount: 0, volume: 0n, openNotional: 0n,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ethers v6 的 Log 用 `index`，v5 用 `logIndex`。同一個區塊裡的先後順序只靠它，
// 少了它「誰先開倉」在同塊內就變成不定序。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logIndexOf = (log: any): number => Number(log.index ?? log.logIndex ?? 0)

/** 新到舊：先比區塊，同塊再比 log 順序。 */
const newestFirst = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) =>
  b.blockNumber - a.blockNumber || b.logIndex - a.logIndex

const byNotionalDesc = (a: OpenedTrade, b: OpenedTrade) =>
  b.notional > a.notional ? 1 : b.notional < a.notional ? -1 : 0

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * 掃一次 PositionOpened / PositionClosed / PositionLiquidated，
 * 導出 whale feed、未平倉清單、多空情緒與統計。
 *
 * WhaleTrackerPage、Dashboard 的 whale 區塊與 whale banner 都吃這一份，
 * 不再各掃各的。
 */
export function useExchangeActivity(
  exchange: Contract | null,
  provider: BrowserProvider | null,
  chainId:  number | null = null,
  /** feed 的門檻。改它只重算導出值，不會重掃鏈。 */
  threshold: bigint = WHALE_THRESHOLD,
): ExchangeActivity {
  const [opened,     setOpened]     = useState<OpenedTrade[]>([])
  const [exits,      setExits]      = useState<ExitEvent[]>([])
  const [scanRange,  setScanRange]  = useState<{ from: number; to: number } | null>(null)
  const [progress,   setProgress]   = useState<{ done: number; total: number } | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // 一次掃描是幾十次序列 RPC，期間使用者可能換鏈或按了 Refresh。沒有這個
  // 版本號的話，先發出的舊掃描會在新掃描之後才回來，用過期的資料蓋掉新的。
  const runId = useRef(0)

  const fetchActivity = useCallback(async () => {
    if (!exchange || !provider) return

    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun

    setLoading(true)
    setError(null)

    try {
      // 這一發原本是裸的 await。掛載瞬間三個 hook 同時對節點開火，它是最先被
      // 擠掉的那一個——一失敗就整頁沒有掃描範圍，UI 永遠停在 "scanning…"。
      const latestBlock = await withRetry(() => provider.getBlock('latest'))
      if (!latestBlock || isStale()) return
      const { number: latestNum, timestamp: latestTs } = latestBlock

      const from = scanFromBlock({ chainId, currentBlock: latestNum })
      const blockTime = avgBlockTime(chainId)
      setScanRange({ from, to: latestNum })

      // 三種事件合成**一趟**掃描：topics[0] 傳陣列就是 OR。之前是三個
      // queryFilter 各掃一遍，同樣的答案要付三倍的 getLogs。
      const iface = exchange.interface
      const topicOf = (name: string) => iface.getEvent(name)!.topicHash
      const eventTopics = [
        topicOf('PositionOpened'),
        topicOf('PositionClosed'),
        topicOf('PositionLiquidated'),
      ]

      const totalChunks = chunkRanges(from, latestNum).length
      let doneChunks = 0
      setProgress({ done: 0, total: totalChunks })
      const tick = () => {
        doneChunks += 1
        if (!isStale()) setProgress({ done: doneChunks, total: totalChunks })
      }

      const rawLogs = await getLogsChunked(
        provider,
        { address: exchange.target as string, topics: [eventTopics] },
        from,
        latestNum,
        tick,
      )
      if (isStale()) return

      const openedLogs:     Array<{ args: any; blockNumber: number; transactionHash: string; index: number }> = []
      const closedLogs:     Array<{ args: any; blockNumber: number; transactionHash: string }> = []
      const liquidatedLogs: Array<{ args: any; blockNumber: number; transactionHash: string }> = []

      for (const log of rawLogs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue
        const row = {
          args:            parsed.args,
          blockNumber:     Number(log.blockNumber),
          transactionHash: log.transactionHash as string,
          index:           Number(log.index ?? log.logIndex ?? 0),
        }
        if (parsed.name === 'PositionOpened')          openedLogs.push(row)
        else if (parsed.name === 'PositionClosed')     closedLogs.push(row)
        else if (parsed.name === 'PositionLiquidated') liquidatedLogs.push(row)
      }

      // ── 出場事件：平倉與清算合成同一張表 ──────────────────────────────────
      const exitRows: ExitEvent[] = [
        ...closedLogs.map(l => ({
          positionId:  String(l.args.positionId as bigint),
          owner:       (l.args.owner as string).toLowerCase(),
          pnl:         l.args.pnl as bigint,
          txHash:      l.transactionHash as string,
          blockNumber: l.blockNumber as number,
          liquidated:  false,
        })),
        ...liquidatedLogs.map(l => ({
          positionId:  String(l.args.positionId as bigint),
          owner:       (l.args.owner as string).toLowerCase(),
          pnl:         l.args.pnl as bigint,
          txHash:      l.transactionHash as string,
          blockNumber: l.blockNumber as number,
          liquidated:  true,
        })),
      ]
      const exitedBy = new Map<string, 'closed' | 'liquidated'>()
      for (const e of exitRows) exitedBy.set(e.positionId, e.liquidated ? 'liquidated' : 'closed')

      // ── 開倉事件 ─────────────────────────────────────────────────────────
      const rows: OpenedTrade[] = openedLogs.map(log => {
        const a = log.args
        const margin      = a.margin   as bigint
        const leverage    = a.leverage as bigint
        const blockNumber = log.blockNumber as number
        const positionId  = String(a.positionId as bigint)
        const asset       = a.asset as string
        return {
          positionId,
          txHash:         log.transactionHash as string,
          blockNumber,
          logIndex:       logIndexOf(log),
          timestamp:      latestTs - (latestNum - blockNumber) * blockTime,
          timestampExact: false,
          owner:          (a.owner as string).toLowerCase(),
          asset,
          assetLabel:     ASSET_LABEL[asset] ?? '?',
          isLong:         a.isLong as boolean,
          entryPrice:     a.entryPrice as bigint,
          margin,
          leverage,
          notional:       notionalOf(margin, leverage),
          isFirstSeen:    false,
          exitedBy:       exitedBy.get(positionId) ?? null,
        }
      })

      // 「新面孔」＝這個地址在視窗內最早的那一筆，所以要由舊往新走一遍。
      const seen = new Set<string>()
      for (const t of [...rows].sort((a, b) => -newestFirst(a, b))) {
        if (!seen.has(t.owner)) {
          seen.add(t.owner)
          t.isFirstSeen = true
        }
      }

      rows.sort(newestFirst)

      // ── 為會顯示出來的那些補上真實時間戳 ──────────────────────────────────
      // 推估值對「3 小時前」這種粒度夠用，但 feed 開頭幾筆是使用者會盯著看的
      // 「幾分鐘前」，那裡的六秒誤差看得出來。
      // 取最新的那些區塊，不看門檻——門檻是使用者可以隨時調的，而掃描不該
      // 因為調門檻就重跑一次。rows 已經新到舊排好，前面這些就是任何門檻下
      // feed 最上方會出現的內容。
      const wantExact = [...new Set(rows.slice(0, EXACT_TIMESTAMP_BLOCKS).map(t => t.blockNumber))]
      if (wantExact.length > 0) {
        // mapLimit 而不是 Promise.allSettled：40 個 getBlock 一次全發出去，
        // 正是 rpcBatch.ts 量到會被公開節點丟掉的那種打法。
        const blocks = await mapLimit(wantExact, RPC_CONCURRENCY, async (bn) => {
          try { return [bn, Number((await withRetry(() => provider.getBlock(bn)))?.timestamp ?? 0)] as const }
          catch { return [bn, 0] as const }
        })
        if (isStale()) return
        const tsByBlock = new Map(blocks.filter(([, ts]) => ts > 0))
        for (const t of rows) {
          const ts = tsByBlock.get(t.blockNumber)
          if (ts !== undefined) {
            t.timestamp = ts
            t.timestampExact = true
          }
        }
      }

      if (isStale()) return
      setOpened(rows)
      setExits(exitRows.sort((a, b) => b.blockNumber - a.blockNumber))
    } catch (e) {
      console.error('[useExchangeActivity]', e)
      if (runId.current === myRun) setError('Could not read on-chain activity. The RPC node may be rate-limiting.')
    } finally {
      if (runId.current === myRun) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [exchange, provider, chainId])

  useEffect(() => { void fetchActivity() }, [fetchActivity])

  // 這些都是 opened 的純導出值，不另存 state——多存一份就多一個會跟主資料
  // 不同步的地方。用 useMemo 不是為了效能，是為了**識別**：下游 hook
  // （useLargestOpenPositions）拿 openTrades 當 effect 依賴，每次 render 都給
  // 一個新陣列的話，那個 effect 會無限重跑。
  // 門檻是導出層的事，不是掃描層的事：調門檻只是換一個篩子，不必再問一次鏈。
  const feed = useMemo(() => opened.filter(t => isWhaleTrade(t.notional, threshold)), [opened, threshold])

  const openTrades = useMemo(
    () => opened.filter(t => t.exitedBy === null).sort(byNotionalDesc),
    [opened],
  )

  const totals = useMemo<ActivityTotals>(() => (
    opened.length === 0 ? EMPTY_TOTALS : {
      openedCount:  opened.length,
      whaleCount:   feed.length,
      openCount:    openTrades.length,
      volume:       opened.reduce((acc, t) => acc + t.notional, 0n),
      openNotional: openTrades.reduce((acc, t) => acc + t.notional, 0n),
    }
  ), [opened, feed, openTrades])

  return {
    opened, feed, openTrades, exits, totals,
    scanRange, progress, loading, error,
    refetch: fetchActivity,
  }
}
