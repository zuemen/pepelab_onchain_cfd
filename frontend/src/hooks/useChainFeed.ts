import type { BrowserProvider } from 'ethers'

import { Contract } from 'ethers'
import { useRef, useMemo, useState, useEffect, useCallback } from 'react'

import { CARBON_RETIREMENT_ABI } from 'src/contracts/carbonRetirement'

import { buildFeed, isFeedIncomplete, type FeedEvent, type FeedItem, type FeedLeg } from 'src/lib/pepefi/feed'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { isWhaleTrade, WHALE_THRESHOLD } from 'src/lib/pepefi/whale'
import { UI_RETRIES, UI_SCAN_CONCURRENCY, avgBlockTime, scanFromBlock, getLogsChunked, isChunkScanAborted } from 'src/lib/pepefi/chainLogs'

import { useCarbonRouting } from './useCarbonRouting'
import { useExchangeActivity } from './useExchangeActivity'
import { useRegisteredTraders } from './useRegisteredTraders'

// 鏈上動態牆的資料（issue #335）。
//
// 交易所的開倉、平倉、清算沿用巨鯨追蹤共用的那一份掃描（useExchangeActivity），不再掃一次。
// 另外只多一趟分段掃描：策略登錄的 StrategyPublished，加上跟單合約的跟隨、取消、罰沒、自動同步——
// 兩個合約、多種事件併成一次 getLogs（address 與 topics[0] 都傳陣列就是 OR）。
// 這條鏈接上了碳權退役（#333，從 FeeRouter 找得到退役合約）時，CarbonRetired 也併進同一次掃描。
// 掃描範圍沿用 scanFromBlock：本機鏈從頭掃，公開鏈只掃有限的視窗。任何一段讀不到，結果就標成不完整。
//
// 時間戳：用出塊時間推估在回放過的本機鏈上會差很遠（兩年的歷史擠在幾萬個區塊裡），
// 所以動態用到的區塊都讀真實時間，最多最新的 EXACT_BLOCKS 個。

const EXACT_BLOCKS = 800

// Resynced／AutoSyncSet 是自動同步版 CopyTracker（ADR-024）才有的事件；舊合約上不會有這兩種 log，多掃也不花額外的請求。
const SOCIAL_EVENTS = [
  'StrategyPublished', 'TraderFollowed', 'TraderUnfollowed', 'TraderSlashed', 'CarbonRetired', 'Resynced', 'AutoSyncSet',
] as const

interface Contracts {
  exchange: Contract
  registry: Contract
  copyTracker: Contract
}

type Untimed = FeedEvent extends infer E ? (E extends FeedEvent ? Omit<E, 'timestamp'> : never) : never

export interface ChainFeed {
  items: FeedItem[]
  loading: boolean
  /** 有任何一段讀不到：畫面要說動態不完整，不能把讀不到當成沒有發生。 */
  incomplete: boolean
  scanRange: { from: number; to: number } | null
  refetch: () => void
}

/** 事件參數：先照名稱讀，名稱對不上（ABI 換成 forge 產物後改名）再照位置讀。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arg = (args: any, name: string, position: number): unknown => args?.[name] ?? args?.[position]

// ethers v6 的 Log 用 `index`，v5 用 `logIndex`。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logIndexOf = (log: any): number => Number(log.index ?? log.logIndex ?? 0)

export function useChainFeed(
  contracts: Contracts | null,
  provider: BrowserProvider | null,
  chainId: number | null,
): ChainFeed {
  const activity = useExchangeActivity(contracts?.exchange ?? null, provider, chainId)
  const carbon = useCarbonRouting(provider, chainId)
  const retirement = carbon.routing?.retirement ?? null
  const retirementDecimals = carbon.routing?.decimals ?? null
  const [social, setSocial] = useState<Untimed[]>([])
  const [socialFailed, setSocialFailed] = useState(0)
  const [socialLoading, setSocialLoading] = useState(false)
  const [latest, setLatest] = useState<{ number: number; timestamp: number } | null>(null)
  const [times, setTimes] = useState<ReadonlyMap<number, number>>(new Map())
  const [versions, setVersions] = useState<ReadonlyMap<string, FeedLeg[]>>(new Map())
  const timeCache = useRef(new Map<number, number>())
  const versionCache = useRef(new Map<string, FeedLeg[] | null>())

  const runId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort(); runId.current += 1 }, [])

  // 換鏈時快取作廢：同一個區塊號碼在另一條鏈上是另一個區塊。
  useEffect(() => {
    timeCache.current = new Map()
    versionCache.current = new Map()
    setTimes(new Map())
    setVersions(new Map())
  }, [chainId])

  const scanSocial = useCallback(async () => {
    runId.current += 1
    const myRun = runId.current
    const isStale = () => runId.current !== myRun
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    if (!contracts || !provider) {
      setSocialLoading(false)
      return
    }
    // 先等退役合約找完，才知道要不要一起掃——否則公開鏈上會整段掃兩次
    if (!carbon.loaded) {
      setSocialLoading(true)
      return
    }
    setSocialLoading(true)
    setSocialFailed(0)
    try {
      const block = await withRetry(() => provider.getBlock('latest'))
      if (!block || isStale()) return
      setLatest({ number: block.number, timestamp: block.timestamp })
      const from = scanFromBlock({ chainId, currentBlock: block.number })

      const sources = [
        contracts.registry,
        contracts.copyTracker,
        ...(retirement ? [new Contract(retirement, CARBON_RETIREMENT_ABI, provider)] : []),
      ]
      const topics = SOCIAL_EVENTS.flatMap((name) => {
        const source = sources.find((c) => c.interface.getEvent(name))
        return source ? [source.interface.getEvent(name)!.topicHash] : []
      })
      let failed = 0
      const logs = await getLogsChunked(
        provider,
        // address 傳陣列是 eth_getLogs 的 OR；chainLogs 的型別只寫了單一位址
        { address: sources.map((c) => c.target as string) as unknown as string, topics: [topics] },
        from,
        block.number,
        undefined,
        () => { failed += 1 },
        { retries: UI_RETRIES, concurrency: UI_SCAN_CONCURRENCY, signal: ac.signal },
      )
      if (isStale()) return

      const rows: Untimed[] = []
      for (const log of logs) {
        const source = sources.find((c) => (c.target as string).toLowerCase() === String(log.address).toLowerCase())
        const parsed = source?.interface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue
        const base = { blockNumber: Number(log.blockNumber), logIndex: logIndexOf(log), txHash: log.transactionHash as string }
        const a = parsed.args
        if (parsed.name === 'StrategyPublished') {
          rows.push({ ...base, kind: 'publish', trader: String(a.trader), versionId: Number(a.versionId) })
        } else if (parsed.name === 'TraderFollowed') {
          rows.push({ ...base, kind: 'follow', trader: String(a.trader), follower: String(a.follower), totalMargin: a.totalMargin as bigint })
        } else if (parsed.name === 'TraderUnfollowed') {
          rows.push({ ...base, kind: 'unfollow', trader: String(a.trader), follower: String(a.follower) })
        } else if (parsed.name === 'TraderSlashed') {
          rows.push({ ...base, kind: 'slash', trader: String(a.trader), follower: String(a.follower), amount: a.slashAmount as bigint })
        } else if (parsed.name === 'CarbonRetired') {
          // 金額換成 18 位小數，與動態上其他金額同一個格式；讀不到結算幣的 decimals 時當作 18
          const decimals = retirementDecimals ?? 18
          const amount = a.amount as bigint
          const scaled = decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18)
          rows.push({ ...base, kind: 'retire', amount: scaled, tonnes: a.tonnesCO2e as bigint })
        } else if (parsed.name === 'Resynced') {
          rows.push({
            ...base,
            kind: 'resync',
            follower: String(arg(a, 'follower', 0)),
            trader: String(arg(a, 'trader', 2)),
            fromVersion: Number(arg(a, 'fromVersion', 3)),
            toVersion: Number(arg(a, 'toVersion', 4)),
          })
        } else if (parsed.name === 'AutoSyncSet') {
          // 事件沒有帶 trader 的合約版本：先留空，下面再從 copyRecords 補
          const trader = a.trader
          rows.push({
            ...base,
            kind: 'autoSync',
            follower: String(arg(a, 'follower', 0)),
            trader: typeof trader === 'string' ? trader : '',
            enabled: Boolean(a.enabled ?? false),
            recordIdx: BigInt(String(arg(a, 'recordIdx', 1) ?? 0)),
          } as Untimed)
        }
      }
      // AutoSyncSet 沒帶 trader 時，用 copyRecords(follower, idx) 讀回是哪位交易者；讀不到的那則就不列
      const unknownTrader = rows.filter(
        (r): r is Extract<Untimed, { kind: 'autoSync' }> & { recordIdx: bigint } => r.kind === 'autoSync' && !r.trader,
      )
      if (unknownTrader.length > 0) {
        await mapLimit(unknownTrader, RPC_CONCURRENCY, async (r) => {
          try {
            const rec = (await withRetry(() => contracts.copyTracker.copyRecords(r.follower, r.recordIdx))) as unknown as { trader?: string; 0?: string }
            r.trader = String(rec.trader ?? rec[0] ?? '')
          } catch { /* 留空：buildFeed 不列 */ }
        })
        if (isStale()) return
      }
      setSocial(rows)
      setSocialFailed(failed)
    } catch (e) {
      if (isChunkScanAborted(e)) return
      console.error('[useChainFeed]', e)
      // 整趟掃描失敗也是「不完整」，不是「沒有動態」
      if (!isStale()) setSocialFailed((n) => Math.max(n, 1))
    } finally {
      if (!isStale()) setSocialLoading(false)
    }
  }, [contracts, provider, chainId, carbon.loaded, retirement, retirementDecimals])

  useEffect(() => { void scanSocial() }, [scanSocial])

  // 交易所事件 → 動態會用到的那些（大額開倉、大額部位的平倉、所有清算），加上社群事件。
  const relevant = useMemo<Untimed[]>(() => {
    const opens: Untimed[] = activity.opened.map((t) => ({
      kind: 'open', blockNumber: t.blockNumber, logIndex: t.logIndex, txHash: t.txHash,
      owner: t.owner, positionId: t.positionId, asset: t.asset, isLong: t.isLong, leverage: t.leverage, notional: t.notional,
    }))
    const exits: Untimed[] = activity.exits.map((x) => ({
      kind: x.liquidated ? 'liquidated' : 'close', blockNumber: x.blockNumber, logIndex: x.logIndex, txHash: x.txHash,
      owner: x.owner, positionId: x.positionId, pnl: x.pnl,
    }))
    return [...opens, ...exits, ...social]
  }, [activity.opened, activity.exits, social])

  // 需要真實時間的區塊：會變成動態的那些事件所在的區塊。
  const wantedBlocks = useMemo(() => {
    const bigOpen = new Set(
      activity.opened.filter((t) => isWhaleTrade(t.notional, WHALE_THRESHOLD)).map((t) => t.positionId),
    )
    const blocks = new Set<number>()
    for (const e of relevant) {
      const shown =
        e.kind === 'open' || e.kind === 'close' ? bigOpen.has(e.positionId) : true
      if (shown) blocks.add(e.blockNumber)
    }
    return [...blocks].sort((a, b) => b - a).slice(0, EXACT_BLOCKS)
  }, [relevant, activity.opened])

  useEffect(() => {
    if (!provider) return undefined
    let cancelled = false
    const missing = wantedBlocks.filter((b) => !timeCache.current.has(b))
    if (missing.length === 0) return undefined
    void mapLimit(missing, RPC_CONCURRENCY, async (bn) => {
      try {
        const b = await withRetry(() => provider.getBlock(bn))
        if (b) timeCache.current.set(bn, Number(b.timestamp))
      } catch { /* 留給推估值 */ }
    }).then(() => {
      if (!cancelled) setTimes(new Map(timeCache.current))
    })
    return () => { cancelled = true }
  }, [provider, wantedBlocks])

  // 策略發布要和前一版比，所以每一版與它的前一版都要讀。
  const wantedVersions = useMemo(() => {
    const keys = new Set<string>()
    for (const e of social) {
      if (e.kind !== 'publish') continue
      keys.add(`${e.trader.toLowerCase()}:${e.versionId}`)
      if (e.versionId > 0) keys.add(`${e.trader.toLowerCase()}:${e.versionId - 1}`)
    }
    return [...keys]
  }, [social])

  useEffect(() => {
    const registry = contracts?.registry
    if (!registry) return undefined
    let cancelled = false
    const missing = wantedVersions.filter((k) => !versionCache.current.has(k))
    if (missing.length === 0) return undefined
    void mapLimit(missing, RPC_CONCURRENCY, async (key) => {
      const [trader, id] = key.split(':')
      try {
        const res = (await withRetry(() => registry.getStrategyVersion(trader, BigInt(id)))) as unknown as [unknown[], bigint]
        versionCache.current.set(key, (res[0] as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }[]).map((x) => ({
          asset: x.asset, weightBps: Number(x.weight), isLong: x.isLong, leverage: Number(x.leverage),
        })))
      } catch {
        versionCache.current.set(key, null) // 讀不到：動態只說「發布了新版」
      }
    }).then(() => {
      if (cancelled) return
      const ok = new Map<string, FeedLeg[]>()
      for (const [k, v] of versionCache.current) if (v) ok.set(k, v)
      setVersions(ok)
    })
    return () => { cancelled = true }
  }, [contracts, wantedVersions])

  const actors = useMemo(
    () => [...new Set(relevant.flatMap((e) => ('trader' in e ? [e.trader] : 'owner' in e ? [e.owner] : [])).map((a) => a.toLowerCase()))],
    [relevant],
  )
  const registered = useRegisteredTraders(contracts?.registry ?? null, actors)

  const items = useMemo(() => {
    const blockTime = avgBlockTime(chainId)
    const timed = relevant.map((e) => ({
      ...e,
      timestamp:
        times.get(e.blockNumber) ??
        (latest ? latest.timestamp - (latest.number - e.blockNumber) * blockTime : 0),
    })) as FeedEvent[]
    const names = new Map<string, string>()
    for (const [addr, info] of registered) if (info.registered && info.name) names.set(addr, info.name)
    return buildFeed(timed, { names, versions })
  }, [relevant, times, latest, chainId, registered, versions])

  const refetch = useCallback(() => {
    activity.refetch()
    void scanSocial()
  }, [activity, scanSocial])

  return {
    items,
    loading: activity.loading || socialLoading,
    incomplete: isFeedIncomplete([activity.failedChunks, socialFailed]) || activity.error !== null,
    scanRange: activity.scanRange,
    refetch,
  }
}
