import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Contract } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { explorerTx, explorerAddr } from '../lib/notify'
import { ASSET_LABEL } from '../lib/assetMeta'
import { TableSkeleton, CardSkeleton } from '../components/Skeleton'
import EmptyState from '../components/EmptyState'

// ── Config ────────────────────────────────────────────────────────────────────
const DEPLOY_BLOCK = 10_874_200  // Exchange + Seed block on Sepolia
const CHUNK_SIZE   = 9_900       // Infura getLogs limit is 10k blocks; stay under it
const FETCH_BLOCKS = 50_000      // per-address timeline window (kept for display note)

// SeedWhales-derived addresses (Anvil mnemonic path indices 1–12)
const FEATURED_WHALES = [
  { label: 'Whale Alpha 🐋',   address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
  { label: 'Bond Steady 🐋',   address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' },
  { label: 'Macro Trader 🐋',  address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720' },
  { label: 'Crypto Degen',     address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' },
  { label: 'Tesla Maxi',       address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9' },
  { label: 'Index Tracker',    address: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f' },
]

const MAINNET_DEMO = {
  label:   'Vitalik (mainnet demo)',
  address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
}

// ── Types ─────────────────────────────────────────────────────────────────────
type EventKind =
  | 'PositionOpened' | 'PositionClosed'
  | 'Following' | 'FollowedBy'
  | 'Staked' | 'Slashed'

interface Activity {
  kind:        EventKind
  txHash:      string
  blockNumber: number
  timestamp:   number
  details:     Record<string, unknown>
}

interface OpenPosRow {
  id:           bigint
  asset:        string
  isLong:       boolean
  entryPrice:   bigint
  margin:       bigint
  leverage:     bigint
  currentPrice: bigint
  pnl:          bigint
}

interface RawPos {
  asset: string; isLong: boolean; isOpen: boolean
  entryPrice: bigint; margin: bigint; leverage: bigint
}

interface TraderStat {
  address:   string
  volume:    bigint   // Σ(margin × leverage), 18-dec
  count:     number   // positions opened
  openCount: number   // currently open
}

interface GlobalStats {
  openedCount: number
  volume:      bigint
  openCount:   number
  leaderboard: TraderStat[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const shortAddr = (a?: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
const isEthAddr = (s: string)  => /^0x[0-9a-fA-F]{40}$/.test(s)

const f18  = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fTime = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'
const pnlColor = (v: bigint) => Number(v) >= 0 ? 'text-green-400' : 'text-red-400'

// ── Chunked log fetcher — stays under Infura's 10k-block getLogs limit ────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function queryLogsChunked(contract: Contract, filter: any, fromBlock: number, toBlock: number): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = []
  for (let from = fromBlock; from <= toBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, toBlock)
    try {
      const chunk = await contract.queryFilter(filter, from, to)
      all.push(...chunk)
    } catch (e) {
      console.warn('[queryLogsChunked] chunk failed', from, '-', to, e)
    }
  }
  return all
}

// ── Whale tier ────────────────────────────────────────────────────────────────
function whaleTier(volumeWei: bigint): { icon: string; label: string; color: string } {
  const v = Number(volumeWei) / 1e18
  if (v >= 50_000) return { icon: '🐋', label: 'Mega Whale',  color: 'text-cyan-300 border-cyan-700 bg-cyan-900/40' }
  if (v >= 10_000) return { icon: '🐬', label: 'Whale',       color: 'text-blue-300 border-blue-700 bg-blue-900/40' }
  return              { icon: '🐟', label: 'Fish',          color: 'text-gray-400 border-gray-700 bg-gray-800/60' }
}

// ── Event styling ─────────────────────────────────────────────────────────────
const KIND_STYLE: Record<EventKind, string> = {
  PositionOpened: 'bg-green-900/60 text-green-300 border-green-700/60',
  PositionClosed: 'bg-orange-900/60 text-orange-300 border-orange-700/60',
  Following:      'bg-purple-900/60 text-purple-300 border-purple-700/60',
  FollowedBy:     'bg-teal-900/60 text-teal-300 border-teal-700/60',
  Staked:         'bg-yellow-900/60 text-yellow-300 border-yellow-700/60',
  Slashed:        'bg-red-900/60 text-red-300 border-red-700/60',
}
const KIND_LABEL: Record<EventKind, string> = {
  PositionOpened: 'Opened',
  PositionClosed: 'Closed',
  Following:      'Following',
  FollowedBy:     'Followed By',
  Staked:         'Staked',
  Slashed:        'Slashed',
}

function renderDetail(a: Activity): React.ReactNode {
  const d = a.details
  switch (a.kind) {
    case 'PositionOpened': {
      const label = ASSET_LABEL[d.asset as string] ?? '?'
      const side  = (d.isLong as boolean) ? 'LONG' : 'SHORT'
      const col   = (d.isLong as boolean) ? 'text-green-400' : 'text-red-400'
      return (
        <span>
          <span className={`font-semibold ${col}`}>{side}</span>{' '}
          {label} {String(d.leverage as bigint)}× @ {fUsd(d.entryPrice as bigint)}{' '}
          | Margin: <span className="text-white">{f18(d.margin as bigint)}</span> USDC
        </span>
      )
    }
    case 'PositionClosed': {
      const pnl = d.pnl as bigint
      return (
        <span>
          PnL:{' '}
          <span className={`font-semibold ${pnlColor(pnl)}`}>
            {(pnl >= 0n ? '+' : '') + f18(pnl)}
          </span>{' '}
          USDC | Received: {f18(d.closeAmount as bigint)}
        </span>
      )
    }
    case 'Following':
      return <span>Following <span className="font-mono">{shortAddr(d.trader as string)}</span> | Margin: {f18(d.totalMargin as bigint)} USDC</span>
    case 'FollowedBy':
      return <span><span className="font-mono">{shortAddr(d.follower as string)}</span> copied this trader | Margin: {f18(d.totalMargin as bigint)} USDC</span>
    case 'Staked':
      return <span>Staked <span className="text-yellow-300 font-semibold">{f18(d.amount as bigint)}</span> USDC</span>
    case 'Slashed':
      return <span>Slashed <span className="text-red-300 font-semibold">{f18(d.amount as bigint)}</span> USDC → <span className="font-mono">{shortAddr(d.recipient as string)}</span></span>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function WhaleTrackerPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const [searchParams]  = useSearchParams()

  const [inputAddr,     setInputAddr]     = useState('')
  const [searchAddr,    setSearchAddr]    = useState<string | null>(null)
  const [isMainnetDemo, setIsMainnetDemo] = useState(false)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  const [activity,      setActivity]      = useState<Activity[]>([])
  const [openPositions, setOpenPositions] = useState<OpenPosRow[]>([])

  // ── Global leaderboard state ───────────────────────────────────────────────
  const [globalStats,   setGlobalStats]   = useState<GlobalStats | null>(null)
  const [globalLoading, setGlobalLoading] = useState(false)

  // ── Derived per-address stats ──────────────────────────────────────────────
  const openedEvents = activity.filter(a => a.kind === 'PositionOpened')
  const closedEvents = activity.filter(a => a.kind === 'PositionClosed')

  const totalVolume = openedEvents.reduce((acc, a) => {
    const margin   = a.details.margin   as bigint
    const leverage = a.details.leverage as bigint
    return acc + margin * leverage
  }, 0n)

  const wins    = closedEvents.filter(a => (a.details.pnl as bigint) >= 0n).length
  const winRate = closedEvents.length > 0
    ? Math.round((wins / closedEvents.length) * 100)
    : null

  const tier = whaleTier(totalVolume)

  const addrParam   = searchParams.get('addr') ?? ''
  const urlSearched = useRef(false)

  // ── Global leaderboard fetch (runs on mount, no search required) ───────────
  const fetchGlobal = useCallback(async () => {
    if (!contracts || !wallet.provider) return
    setGlobalLoading(true)
    try {
      const currentBlock = await wallet.provider.getBlockNumber()

      // Fetch all PositionOpened + PositionClosed from deploy block (chunked)
      const [openedLogs, closedLogs] = await Promise.all([
        queryLogsChunked(contracts.exchange, contracts.exchange.filters.PositionOpened(), DEPLOY_BLOCK, currentBlock),
        queryLogsChunked(contracts.exchange, contracts.exchange.filters.PositionClosed(), DEPLOY_BLOCK, currentBlock),
      ])

      const closedIds = new Set(closedLogs.map(l => String(l.args.positionId as bigint)))

      let totalVol = 0n
      const traderMap = new Map<string, { volume: bigint; count: number; openCount: number }>()

      for (const log of openedLogs) {
        const owner    = (log.args.owner as string).toLowerCase()
        const margin   = log.args.margin   as bigint
        const leverage = log.args.leverage as bigint
        const notional = margin * leverage
        const posId    = String(log.args.positionId as bigint)
        const isOpen   = !closedIds.has(posId)

        totalVol += notional

        const t = traderMap.get(owner) ?? { volume: 0n, count: 0, openCount: 0 }
        t.volume += notional
        t.count++
        if (isOpen) t.openCount++
        traderMap.set(owner, t)
      }

      const leaderboard: TraderStat[] = [...traderMap.entries()]
        .map(([address, s]) => ({ address, ...s }))
        .sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0))

      setGlobalStats({
        openedCount: openedLogs.length,
        volume:      totalVol,
        openCount:   openedLogs.length - closedLogs.length,
        leaderboard,
      })
    } catch (e) {
      console.error('[whale global]', e)
    } finally {
      setGlobalLoading(false)
    }
  }, [contracts, wallet.provider])

  useEffect(() => { void fetchGlobal() }, [fetchGlobal])

  // ── Per-address search ─────────────────────────────────────────────────────
  const doSearch = useCallback(async (addr: string, mainnetDemo = false) => {
    if (!isEthAddr(addr)) { setError('Invalid Ethereum address'); return }
    if (!contracts || !wallet.provider) { setError('Connect your wallet first'); return }

    setSearchAddr(addr)
    setIsMainnetDemo(mainnetDemo)
    setLoading(true)
    setError(null)
    setActivity([])
    setOpenPositions([])

    try {
      const currentBlock = await wallet.provider.getBlockNumber()
      // Use DEPLOY_BLOCK so we never miss events; chunked to stay under Infura limit
      const from = DEPLOY_BLOCK

      const results = await Promise.allSettled([
        // [0] PositionOpened by addr
        queryLogsChunked(contracts.exchange, contracts.exchange.filters.PositionOpened(null, addr), from, currentBlock),
        // [1] PositionClosed by addr
        queryLogsChunked(contracts.exchange, contracts.exchange.filters.PositionClosed(null, addr), from, currentBlock),
        // [2] TraderFollowed: addr is the follower
        queryLogsChunked(contracts.copyTracker, contracts.copyTracker.filters.TraderFollowed(addr, null), from, currentBlock),
        // [3] TraderFollowed: addr is the trader (someone is copying them)
        queryLogsChunked(contracts.copyTracker, contracts.copyTracker.filters.TraderFollowed(null, addr), from, currentBlock),
        // [4] Staked by addr
        queryLogsChunked(contracts.traderStake, contracts.traderStake.filters.Staked(addr), from, currentBlock),
        // [5] Slashed: addr was slashed
        queryLogsChunked(contracts.traderStake, contracts.traderStake.filters.Slashed(addr, null), from, currentBlock),
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getLogs = (i: number): any[] =>
        results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<any[]>).value : []

      const evs: Activity[] = []

      for (const log of getLogs(0)) {
        const a = log.args
        evs.push({
          kind: 'PositionOpened', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { asset: a.asset as string, isLong: a.isLong as boolean,
            entryPrice: a.entryPrice as bigint, margin: a.margin as bigint, leverage: a.leverage as bigint },
        })
      }
      for (const log of getLogs(1)) {
        const a = log.args
        evs.push({
          kind: 'PositionClosed', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { pnl: a.pnl as bigint, closeAmount: a.closeAmount as bigint },
        })
      }
      for (const log of getLogs(2)) {
        const a = log.args
        evs.push({
          kind: 'Following', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { trader: a.trader as string, totalMargin: a.totalMargin as bigint },
        })
      }
      for (const log of getLogs(3)) {
        const a = log.args
        evs.push({
          kind: 'FollowedBy', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { follower: a.follower as string, totalMargin: a.totalMargin as bigint },
        })
      }
      for (const log of getLogs(4)) {
        const a = log.args
        evs.push({
          kind: 'Staked', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint },
        })
      }
      for (const log of getLogs(5)) {
        const a = log.args
        evs.push({
          kind: 'Slashed', txHash: log.transactionHash,
          blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint, recipient: a.recipient as string },
        })
      }

      // Batch-fetch block timestamps
      const uniqueBnums = [...new Set(evs.map(e => e.blockNumber))]
      const blockFetches = await Promise.allSettled(
        uniqueBnums.map(bn => wallet.provider!.getBlock(bn)),
      )
      const blockTs: Record<number, number> = {}
      for (const [i, r] of blockFetches.entries()) {
        if (r.status === 'fulfilled' && r.value)
          blockTs[uniqueBnums[i]] = Number(r.value.timestamp)
      }
      for (const e of evs) e.timestamp = blockTs[e.blockNumber] ?? 0

      evs.sort((a, b) => b.blockNumber - a.blockNumber)
      setActivity(evs)

      // Fetch current open positions — each position individually try/catched
      // so one failed RPC call cannot wipe out all other positions
      if (!mainnetDemo) {
        const ids = await (async () => {
          try { return (await contracts.exchange.getUserPositions(addr)) as bigint[] }
          catch { return [] as bigint[] }
        })()
        const rows = await Promise.all(
          ids.map(async (id): Promise<OpenPosRow | null> => {
            try {
              const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos
              if (!raw.isOpen) return null
              const [pnl, pr] = await Promise.allSettled([
                contracts.exchange.getUnrealizedPnL(id),
                contracts.oracle.getPrice(raw.asset),
              ])
              const pnlVal      = pnl.status === 'fulfilled' ? pnl.value as bigint : 0n
              const priceRaw    = pr.status  === 'fulfilled' ? pr.value  as [bigint, bigint] : [0n, 0n] as [bigint, bigint]
              return {
                id, asset: raw.asset, isLong: raw.isLong,
                entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
                currentPrice: priceRaw[0] * 10n ** 10n, pnl: pnlVal,
              }
            } catch { return null }
          }),
        )
        setOpenPositions(rows.filter((r): r is OpenPosRow => r !== null))
      }
    } catch (err) {
      console.error('[whale]', err)
      setError(err instanceof Error ? err.message.slice(0, 140) : 'Failed to fetch on-chain data')
    } finally {
      setLoading(false)
    }
  }, [contracts, wallet.provider])

  const handleSearch = () => {
    const addr = inputAddr.trim()
    const isDemo = addr.toLowerCase() === MAINNET_DEMO.address.toLowerCase()
    void doSearch(addr, isDemo)
  }

  const pickAddress = (addr: string, mainnetDemo = false) => {
    setInputAddr(addr)
    void doSearch(addr, mainnetDemo)
  }

  // ── Auto-search from ?addr= URL param ─────────────────────────────────────
  useEffect(() => {
    if (!addrParam || urlSearched.current) return
    if (!isEthAddr(addrParam))             return
    if (!contracts || !wallet.provider)    return
    urlSearched.current = true
    setInputAddr(addrParam)
    void doSearch(addrParam)
  }, [addrParam, contracts, wallet.provider, doSearch])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            🐋 Whale Tracker
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Global leaderboard · Per-address activity · On-chain position history
          </p>
        </div>
        <button
          onClick={() => void fetchGlobal()}
          disabled={globalLoading}
          className="text-xs text-gray-500 hover:text-white disabled:opacity-40 transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {/* ── A. Global Overview ─────────────────────────────────────────────────── */}
      {!wallet.isConnected ? (
        <div className="rounded-card border border-surface-border bg-surface p-10 text-center text-gray-500 text-sm">
          Connect your wallet to view on-chain data.
        </div>
      ) : (
        <>
          {/* Global stat cards */}
          {globalLoading ? (
            <div className="grid grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
            </div>
          ) : globalStats ? (
            <div className="grid grid-cols-3 gap-4">
              <StatCard
                title="Positions Opened"
                value={String(globalStats.openedCount)}
                sub="all-time (all traders)"
              />
              <StatCard
                title="Total Volume"
                value={fUsd(globalStats.volume)}
                sub="Σ margin × leverage"
                highlight={Number(globalStats.volume) / 1e18 >= 10_000}
              />
              <StatCard
                title="Open Positions"
                value={String(globalStats.openCount)}
                sub="currently active"
                highlight={globalStats.openCount > 0}
              />
            </div>
          ) : (
            <div className="rounded-card border border-surface-border bg-surface p-6 text-center text-gray-500 text-sm">
              載入全局統計中…
            </div>
          )}

          {/* ── B. Trader Leaderboard ─────────────────────────────────────────── */}
          {globalStats && globalStats.leaderboard.length > 0 && (
            <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
              <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  B · Trader Leaderboard
                </h2>
                <span className="text-xs text-gray-600">{globalStats.leaderboard.length} traders</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                      {['Rank', 'Address', 'Tier', 'Total Volume', 'Positions', 'Open', ''].map(h => (
                        <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {globalStats.leaderboard.map((t, i) => {
                      const tier = whaleTier(t.volume)
                      return (
                        <tr key={t.address} className="hover:bg-surface-elev/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-gray-500 tabular-nums">#{i + 1}</td>
                          <td className="px-4 py-2.5 font-mono text-cyan-400">
                            {shortAddr(t.address)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${tier.color}`}>
                              {tier.icon} {tier.label}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-white tabular-nums">
                            {fUsd(t.volume)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-gray-400 tabular-nums">{t.count}</td>
                          <td className="px-4 py-2.5 font-mono tabular-nums">
                            <span className={t.openCount > 0 ? 'text-green-400' : 'text-gray-600'}>
                              {t.openCount}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => pickAddress(t.address)}
                              className="text-xs text-brand-300 hover:text-white transition-colors px-2 py-1 rounded border border-brand-300/30 hover:border-brand-300"
                            >
                              View →
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── C. Per-address search ──────────────────────────────────────────── */}
          <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">C · Address Lookup</h2>
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="0x… Ethereum address"
                value={inputAddr}
                onChange={e => setInputAddr(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-300 font-mono"
              />
              <button
                onClick={handleSearch}
                disabled={loading || !inputAddr.trim()}
                className="px-5 py-2.5 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-bold transition-colors"
              >
                {loading ? '…' : 'Search'}
              </button>
            </div>

            {/* Featured whale quick-select */}
            <div className="space-y-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Featured Demo Whales</p>
              <div className="flex flex-wrap gap-2">
                {FEATURED_WHALES.map(w => (
                  <button
                    key={w.address}
                    onClick={() => pickAddress(w.address)}
                    className="px-3 py-1.5 rounded-lg bg-surface-elev border border-surface-border text-xs text-gray-300 hover:text-white hover:border-brand-300/50 transition-colors font-medium"
                  >
                    {w.label}
                  </button>
                ))}
                <button
                  onClick={() => pickAddress(MAINNET_DEMO.address, true)}
                  className="px-3 py-1.5 rounded-lg bg-purple-900/30 border border-purple-700/40 text-xs text-purple-300 hover:text-purple-100 transition-colors font-medium"
                  title="Mainnet address — for demo purposes only"
                >
                  {MAINNET_DEMO.label}
                </button>
              </div>
            </div>
          </div>

          {/* Mainnet warning */}
          {isMainnetDemo && searchAddr && (
            <div className="rounded-lg border border-purple-700/40 bg-purple-900/20 px-4 py-3 text-sm text-purple-300">
              <span className="font-semibold">ℹ Mainnet address</span> — PepeFi runs on Sepolia testnet.
              This address has no activity here. The search demonstrates the queryFilter capability for any address.
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-xs text-red-400">
              {error}
            </div>
          )}

          {/* ── D. Per-address results ─────────────────────────────────────────── */}
          {searchAddr && (
            <>
              {/* Address header + whale tier */}
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-gray-300 text-sm">{searchAddr}</span>
                {wallet.chainId === 11155111 && (
                  <a
                    href={explorerAddr(searchAddr, wallet.chainId) ?? '#'}
                    target="_blank" rel="noopener noreferrer"
                    className="text-emerald-400 text-xs hover:underline"
                  >
                    Etherscan ↗
                  </a>
                )}
                {!loading && !isMainnetDemo && (
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${tier.color}`}>
                    {tier.icon} {tier.label}
                  </span>
                )}
              </div>

              {/* Per-address stat cards */}
              {loading ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard title="Positions Opened" value={String(openedEvents.length)} sub="total lifetime" />
                  <StatCard
                    title="Total Volume"
                    value={fUsd(totalVolume)}
                    sub="margin × leverage"
                    highlight={Number(totalVolume) / 1e18 >= 10_000}
                  />
                  <StatCard title="Open Positions" value={String(openPositions.length)} sub="currently active" />
                  <StatCard
                    title="Win Rate"
                    value={winRate !== null ? `${winRate}%` : '—'}
                    sub={`${wins}/${closedEvents.length} closes`}
                    highlight={winRate !== null && winRate >= 60}
                  />
                </div>
              )}

              {/* Current Open Positions */}
              <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
                <h2 className="text-base font-bold text-white">Current Open Positions</h2>
                {loading ? (
                  <TableSkeleton rows={3} cols={6} />
                ) : openPositions.length === 0 ? (
                  <p className="text-sm text-gray-600 py-4 text-center">No open positions.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead>
                        <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                          {['Asset', 'Side', 'Lev', 'Entry', 'Current', 'Margin', 'Notional', 'PnL'].map(h => (
                            <th key={h} className="py-2 pr-4 font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {openPositions.map(row => {
                          const notional = row.margin * row.leverage
                          return (
                            <tr key={String(row.id)} className="hover:bg-surface-elev/50 transition-colors">
                              <td className="py-2.5 pr-4 font-mono text-white font-medium">
                                {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
                              </td>
                              <td className={`py-2.5 pr-4 font-bold text-xs ${row.isLong ? 'text-green-400' : 'text-red-400'}`}>
                                {row.isLong ? 'LONG ↑' : 'SHORT ↓'}
                              </td>
                              <td className="py-2.5 pr-4 font-mono text-gray-300">{String(row.leverage)}×</td>
                              <td className="py-2.5 pr-4 font-mono text-gray-300">{fUsd(row.entryPrice)}</td>
                              <td className="py-2.5 pr-4 font-mono text-gray-300">
                                {row.currentPrice === 0n ? '—' : fUsd(row.currentPrice)}
                              </td>
                              <td className="py-2.5 pr-4 font-mono text-gray-300">{f18(row.margin)}</td>
                              <td className="py-2.5 pr-4 font-mono text-gray-400">{f18(notional)}</td>
                              <td className={`py-2.5 pr-4 font-mono font-semibold ${pnlColor(row.pnl)}`}>
                                {(Number(row.pnl) >= 0 ? '+' : '') + f18(row.pnl, 4)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Activity Timeline */}
              <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
                <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
                  <h2 className="text-base font-bold text-white">Activity Timeline</h2>
                  <span className="text-xs text-gray-500">From deploy block #{DEPLOY_BLOCK.toLocaleString()}</span>
                </div>

                {loading ? (
                  <TableSkeleton rows={6} cols={5} />
                ) : activity.length === 0 ? (
                  <EmptyState
                    icon="📭"
                    title="No activity found"
                    description={
                      isMainnetDemo
                        ? 'This is a mainnet address — no PepeFi activity on Sepolia.'
                        : `No events found for ${shortAddr(searchAddr)} since block #${DEPLOY_BLOCK.toLocaleString()}.`
                    }
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead>
                        <tr className="text-xs text-gray-500 uppercase border-b border-surface-border bg-surface-sub/50">
                          {['Time', 'Type', 'Details', 'Block', 'Tx'].map(h => (
                            <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {activity.map((e, i) => (
                          <tr key={i} className="hover:bg-surface-elev/50 transition-colors">
                            <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                              {fTime(e.timestamp)}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${KIND_STYLE[e.kind]}`}>
                                {KIND_LABEL[e.kind]}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-300 max-w-sm">
                              {renderDetail(e)}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-gray-500 whitespace-nowrap">
                              #{e.blockNumber}
                            </td>
                            <td className="px-4 py-2.5">
                              {explorerTx(e.txHash, wallet.chainId) ? (
                                <a
                                  href={explorerTx(e.txHash, wallet.chainId)!}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-emerald-500 hover:text-emerald-300 transition-colors text-base"
                                  title={e.txHash}
                                >
                                  ↗
                                </a>
                              ) : (
                                <span className="text-gray-700 text-xs font-mono">{e.txHash.slice(0, 8)}…</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* Footer note */}
      {wallet.isConnected && !globalLoading && (
        <p className="text-xs text-gray-700 text-center">
          Data scanned from block #{DEPLOY_BLOCK.toLocaleString()} · {FETCH_BLOCKS.toLocaleString()} block window per chunk
        </p>
      )}
    </div>
  )
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  title, value, sub, highlight = false
}: { title: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-card border p-4 space-y-1 ${
      highlight
        ? 'border-brand-300/40 bg-brand-400/5'
        : 'border-surface-border bg-surface'
    }`}>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{title}</p>
      <p className={`text-xl font-bold font-mono ${highlight ? 'text-brand-100' : 'text-white'}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  )
}
