import { useState, useEffect, useCallback, type ReactNode } from 'react'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { explorerTx } from '../lib/notify'
import { TableSkeleton } from '../components/Skeleton'
import EmptyState from '../components/EmptyState'
import { ASSET_LABEL } from '../lib/assetMeta'

// ── Constants ─────────────────────────────────────────────────────────────────
const FETCH_BLOCKS = 5000   // ~15 h on Sepolia (12 s/block)

// ── Types ─────────────────────────────────────────────────────────────────────
type EventType =
  | 'Swap' | 'PositionOpened' | 'PositionClosed'
  | 'MarginDeposited' | 'MarginWithdrawn'
  | 'TraderFollowed' | 'TraderUnfollowed'
  | 'CopyFee' | 'PriceUpdated' | 'Stake' | 'Slash'

type FilterKey = 'all' | 'Swap' | 'Position' | 'Margin' | 'Social' | 'Fee' | 'Price' | 'Stake'

interface ChainEvent {
  type:        EventType
  user?:       string
  txHash:      string
  blockNumber: number
  timestamp:   number
  details:     Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const shortAddr = (addr?: string) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'

const fTime = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'

const f18  = (v: bigint) => (Number(v) / 1e18).toFixed(2)
const fEth = (v: bigint) => (Number(v) / 1e18).toFixed(6)
const f8   = (v: bigint) =>
  '$' + (Number(v) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── Type badge styling ────────────────────────────────────────────────────────
const TYPE_STYLE: Partial<Record<EventType, string>> = {
  Swap:             'bg-blue-900/60 text-blue-300 border-blue-700/60',
  PositionOpened:   'bg-green-900/60 text-green-300 border-green-700/60',
  PositionClosed:   'bg-orange-900/60 text-orange-300 border-orange-700/60',
  MarginDeposited:  'bg-cyan-900/60 text-cyan-300 border-cyan-700/60',
  MarginWithdrawn:  'bg-amber-900/60 text-amber-300 border-amber-700/60',
  TraderFollowed:   'bg-purple-900/60 text-purple-300 border-purple-700/60',
  TraderUnfollowed: 'bg-gray-700/80 text-gray-300 border-gray-600',
  CopyFee:          'bg-brand-400/20 text-brand-100 border-brand-300/30',
  PriceUpdated:     'bg-teal-900/60 text-teal-300 border-teal-700/60',
  Stake:            'bg-yellow-900/60 text-yellow-300 border-yellow-700/60',
  Slash:            'bg-red-900/60 text-red-300 border-red-700/60',
}

const TYPE_LABEL: Partial<Record<EventType, string>> = {
  Swap:             'Swap',
  PositionOpened:   'Opened',
  PositionClosed:   'Closed',
  MarginDeposited:  'Deposit',
  MarginWithdrawn:  'Withdraw',
  TraderFollowed:   'Follow',
  TraderUnfollowed: 'Unfollow',
  CopyFee:          'Copy Fee',
  PriceUpdated:     'Price ↺',
  Stake:            'Stake',
  Slash:            'Slash',
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'Swap',     label: 'Swap' },
  { key: 'Position', label: 'Positions' },
  { key: 'Margin',   label: 'Margin' },
  { key: 'Social',   label: 'Social' },
  { key: 'Fee',      label: 'Fees' },
  { key: 'Price',    label: 'Oracle' },
  { key: 'Stake',    label: 'Stake' },
]

const FILTER_TYPES: Partial<Record<FilterKey, EventType[]>> = {
  Swap:     ['Swap'],
  Position: ['PositionOpened', 'PositionClosed'],
  Margin:   ['MarginDeposited', 'MarginWithdrawn'],
  Social:   ['TraderFollowed', 'TraderUnfollowed'],
  Fee:      ['CopyFee'],
  Price:    ['PriceUpdated'],
  Stake:    ['Stake', 'Slash'],
}

// ── Details renderer ──────────────────────────────────────────────────────────
function renderDetails(e: ChainEvent): ReactNode {
  const d = e.details
  switch (e.type) {
    case 'Swap':
      return d.direction === 'ETH→USDC'
        ? <span><span className="text-gray-300">{fEth(d.ethIn as bigint)} ETH</span> → <span className="text-emerald-400">{f18(d.usdcOut as bigint)} mUSDC</span></span>
        : <span><span className="text-gray-300">{f18(d.usdcIn as bigint)} mUSDC</span> → <span className="text-emerald-400">{fEth(d.ethOut as bigint)} ETH</span></span>

    case 'PositionOpened': {
      const label   = ASSET_LABEL[d.asset as string] ?? '?'
      const side    = (d.isLong as boolean) ? 'LONG' : 'SHORT'
      const sideCol = (d.isLong as boolean) ? 'text-green-400' : 'text-red-400'
      return <span><span className={`font-semibold ${sideCol}`}>{side}</span> {label} {String(d.leverage as bigint)}× @ {f8(d.entryPrice as bigint)} | Margin: {f18(d.margin as bigint)} mUSDC</span>
    }

    case 'PositionClosed': {
      const pnl    = d.pnl as bigint
      const pnlStr = (pnl >= 0n ? '+' : '') + f18(pnl)
      const col    = pnl >= 0n ? 'text-green-400' : 'text-red-400'
      return <span>PnL: <span className={`font-semibold ${col}`}>{pnlStr}</span> mUSDC | Received: {f18(d.closeAmount as bigint)}</span>
    }

    case 'MarginDeposited':
      return <span className="text-emerald-400">+{f18(d.amount as bigint)} mUSDC</span>

    case 'MarginWithdrawn':
      return <span className="text-amber-400">−{f18(d.amount as bigint)} mUSDC</span>

    case 'TraderFollowed': {
      const trader = d.trader as string
      return <span>Following <span className="font-mono">{shortAddr(trader)}</span> | Margin: {f18(d.totalMargin as bigint)} mUSDC</span>
    }

    case 'TraderUnfollowed': {
      const trader = d.trader as string
      return <span>Unfollowed <span className="font-mono">{shortAddr(trader)}</span></span>
    }

    case 'CopyFee':
      return <span>Earned: <span className="text-brand-100 font-semibold">{f18(d.traderShare as bigint)}</span> mUSDC (fee: {f18(d.fee as bigint)})</span>

    case 'PriceUpdated': {
      const label = ASSET_LABEL[d.assetId as string] ?? '?'
      return <span>{label}: {f8(d.oldPrice as bigint)} → <span className="text-teal-300 font-semibold">{f8(d.newPrice as bigint)}</span></span>
    }

    case 'Stake':
      return <span>Staked <span className="text-yellow-300 font-semibold">{f18(d.amount as bigint)}</span> mUSDC</span>

    case 'Slash': {
      const recipient = d.recipient as string
      return <span>Slashed <span className="text-red-300 font-semibold">{f18(d.amount as bigint)}</span> mUSDC → <span className="font-mono">{shortAddr(recipient)}</span></span>
    }

    default:
      return <span className="text-gray-600 text-xs">{JSON.stringify(d).slice(0, 80)}</span>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function HistoryPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [tab,       setTab]       = useState<'mine' | 'all'>('mine')
  const [events,    setEvents]    = useState<ChainEvent[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [filterKey, setFilterKey] = useState<FilterKey>('all')

  // ── Event fetcher ───────────────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    if (!contracts || !wallet.provider) return
    setLoading(true)
    setError(null)
    try {
      const currentBlock = await wallet.provider.getBlockNumber()
      const fromBlock    = Math.max(0, currentBlock - FETCH_BLOCKS)
      const userFilter   = tab === 'mine' ? (wallet.address ?? null) : null

      const uf = userFilter  // shorthand

      const results = await Promise.allSettled([
        // [0] ETH→USDC swaps
        contracts.swapRouter.queryFilter(
          uf ? contracts.swapRouter.filters.SwapEthToUsdc(uf) : contracts.swapRouter.filters.SwapEthToUsdc(),
          fromBlock, 'latest',
        ),
        // [1] USDC→ETH swaps
        contracts.swapRouter.queryFilter(
          uf ? contracts.swapRouter.filters.SwapUsdcToEth(uf) : contracts.swapRouter.filters.SwapUsdcToEth(),
          fromBlock, 'latest',
        ),
        // [2] PositionOpened
        contracts.exchange.queryFilter(
          uf ? contracts.exchange.filters.PositionOpened(null, uf) : contracts.exchange.filters.PositionOpened(),
          fromBlock, 'latest',
        ),
        // [3] PositionClosed
        contracts.exchange.queryFilter(
          uf ? contracts.exchange.filters.PositionClosed(null, uf) : contracts.exchange.filters.PositionClosed(),
          fromBlock, 'latest',
        ),
        // [4] MarginDeposited
        contracts.exchange.queryFilter(
          uf ? contracts.exchange.filters.MarginDeposited(uf) : contracts.exchange.filters.MarginDeposited(),
          fromBlock, 'latest',
        ),
        // [5] MarginWithdrawn
        contracts.exchange.queryFilter(
          uf ? contracts.exchange.filters.MarginWithdrawn(uf) : contracts.exchange.filters.MarginWithdrawn(),
          fromBlock, 'latest',
        ),
        // [6] TraderFollowed (mine: as follower; all: everyone)
        contracts.copyTracker.queryFilter(
          uf ? contracts.copyTracker.filters.TraderFollowed(uf, null) : contracts.copyTracker.filters.TraderFollowed(),
          fromBlock, 'latest',
        ),
        // [7] TraderUnfollowed (mine only)
        uf
          ? contracts.copyTracker.queryFilter(contracts.copyTracker.filters.TraderUnfollowed(uf, null), fromBlock, 'latest')
          : Promise.resolve([]),
        // [8] CopyFeeDistributed (mine: as trader)
        contracts.feeRouter.queryFilter(
          uf ? contracts.feeRouter.filters.CopyFeeDistributed(uf) : contracts.feeRouter.filters.CopyFeeDistributed(),
          fromBlock, 'latest',
        ),
        // [9] PriceUpdated (all mode only — too noisy for "mine")
        tab === 'all'
          ? contracts.oracle.queryFilter(contracts.oracle.filters.PriceUpdated(), fromBlock, 'latest')
          : Promise.resolve([]),
        // [10] Staked
        contracts.traderStake.queryFilter(
          uf ? contracts.traderStake.filters.Staked(uf) : contracts.traderStake.filters.Staked(),
          fromBlock, 'latest',
        ),
        // [11] Slashed
        contracts.traderStake.queryFilter(
          uf ? contracts.traderStake.filters.Slashed(uf, null) : contracts.traderStake.filters.Slashed(),
          fromBlock, 'latest',
        ),
      ])

      const getLogs = (i: number): any[] =>
        results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<any[]>).value : []

      const evs: ChainEvent[] = []

      // 0 — ETH→USDC
      for (const log of getLogs(0)) {
        const a = log.args
        evs.push({ type: 'Swap', user: a.user, txHash: log.transactionHash, blockNumber: log.blockNumber,
          timestamp: Number(a.timestamp ?? 0),
          details: { direction: 'ETH→USDC', ethIn: a.ethIn as bigint, usdcOut: a.usdcOut as bigint } })
      }
      // 1 — USDC→ETH
      for (const log of getLogs(1)) {
        const a = log.args
        evs.push({ type: 'Swap', user: a.user, txHash: log.transactionHash, blockNumber: log.blockNumber,
          timestamp: Number(a.timestamp ?? 0),
          details: { direction: 'USDC→ETH', usdcIn: a.usdcIn as bigint, ethOut: a.ethOut as bigint } })
      }
      // 2 — PositionOpened
      for (const log of getLogs(2)) {
        const a = log.args
        evs.push({ type: 'PositionOpened', user: a.owner, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { positionId: a.positionId as bigint, asset: a.asset as string, isLong: a.isLong as boolean,
            entryPrice: a.entryPrice as bigint, margin: a.margin as bigint, leverage: a.leverage as bigint } })
      }
      // 3 — PositionClosed
      for (const log of getLogs(3)) {
        const a = log.args
        evs.push({ type: 'PositionClosed', user: a.owner, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { positionId: a.positionId as bigint, pnl: a.pnl as bigint, closeAmount: a.closeAmount as bigint } })
      }
      // 4 — MarginDeposited
      for (const log of getLogs(4)) {
        const a = log.args
        evs.push({ type: 'MarginDeposited', user: a.user, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint } })
      }
      // 5 — MarginWithdrawn
      for (const log of getLogs(5)) {
        const a = log.args
        evs.push({ type: 'MarginWithdrawn', user: a.user, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint } })
      }
      // 6 — TraderFollowed
      for (const log of getLogs(6)) {
        const a = log.args
        evs.push({ type: 'TraderFollowed', user: a.follower, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { trader: a.trader as string, totalMargin: a.totalMargin as bigint } })
      }
      // 7 — TraderUnfollowed
      for (const log of getLogs(7)) {
        const a = log.args
        evs.push({ type: 'TraderUnfollowed', user: a.follower, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { trader: a.trader as string } })
      }
      // 8 — CopyFeeDistributed
      for (const log of getLogs(8)) {
        const a = log.args
        evs.push({ type: 'CopyFee', user: a.trader, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { fee: a.fee as bigint, traderShare: a.traderShare as bigint } })
      }
      // 9 — PriceUpdated
      for (const log of getLogs(9)) {
        const a = log.args
        evs.push({ type: 'PriceUpdated', user: undefined, txHash: log.transactionHash, blockNumber: log.blockNumber,
          timestamp: Number(a.timestamp ?? 0),
          details: { assetId: a.assetId as string, oldPrice: a.oldPrice as bigint, newPrice: a.newPrice as bigint } })
      }
      // 10 — Staked
      for (const log of getLogs(10)) {
        const a = log.args
        evs.push({ type: 'Stake', user: a.trader, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint } })
      }
      // 11 — Slashed
      for (const log of getLogs(11)) {
        const a = log.args
        evs.push({ type: 'Slash', user: a.trader, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: 0,
          details: { amount: a.amount as bigint, recipient: a.recipient as string } })
      }

      // Batch-fetch timestamps for events without embedded timestamp
      const needTs     = evs.filter(e => e.timestamp === 0)
      const uniqueBnums = [...new Set(needTs.map(e => e.blockNumber))]
      const blockFetches = await Promise.allSettled(
        uniqueBnums.map(bn => wallet.provider!.getBlock(bn)),
      )
      const blockTsMap: Record<number, number> = {}
      for (const [i, r] of blockFetches.entries()) {
        if (r.status === 'fulfilled' && r.value)
          blockTsMap[uniqueBnums[i]] = Number(r.value.timestamp)
      }
      for (const e of evs) {
        if (e.timestamp === 0) e.timestamp = blockTsMap[e.blockNumber] ?? 0
      }

      evs.sort((a, b) => b.blockNumber - a.blockNumber)
      setEvents(evs)
    } catch (err) {
      console.error('[history]', err)
      setError(err instanceof Error ? err.message.slice(0, 120) : 'Failed to fetch events')
    } finally {
      setLoading(false)
    }
  }, [contracts, tab, wallet.address, wallet.provider])

  useEffect(() => { void fetchEvents() }, [fetchEvents])

  // ── Filtering ─────────────────────────────────────────────────────────────
  const allowed = FILTER_TYPES[filterKey]
  const visible  = allowed ? events.filter(e => allowed.includes(e.type)) : events

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Transaction History</h1>
          <p className="text-sm text-gray-400 mt-0.5">On-chain auditability — decoded directly from Sepolia via ethers.js</p>
        </div>
        <button
          onClick={() => void fetchEvents()}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-white disabled:opacity-40 transition-colors"
        >
          {loading ? 'Loading…' : '↺ Refresh'}
        </button>
      </div>

      {/* Proof-of-transparency note */}
      <div className="rounded-card border border-info/30 bg-info/5 px-5 py-4 text-xs text-gray-300 leading-relaxed">
        All activity is read directly from the Sepolia blockchain — no backend, no database, just the immutable ledger.{' '}
        <strong className="text-white">Every row below is a real on-chain event.</strong>{' '}
        Click <span className="font-mono text-emerald-400">↗</span> to verify on Sepolia Etherscan.
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['mine', 'all'] as const).map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setFilterKey('all') }}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t
                ? 'bg-brand-400/20 text-brand-100 border border-brand-300/30'
                : 'text-gray-400 hover:text-white border border-transparent hover:border-surface-border'
            }`}
          >
            {t === 'mine' ? (wallet.isConnected ? 'My Activity' : 'My Activity (connect wallet)') : 'All Activity'}
          </button>
        ))}
      </div>

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilterKey(f.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filterKey === f.key
                ? 'bg-gray-600 text-white'
                : 'bg-surface-sub text-gray-400 hover:text-white border border-surface-border'
            }`}
          >
            {f.label}
            {filterKey === f.key && visible.length > 0 && (
              <span className="ml-1.5 text-gray-400">{visible.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* "Mine" tab, no wallet */}
      {tab === 'mine' && !wallet.isConnected && (
        <div className="rounded-card border border-surface-border bg-surface p-12 text-center text-gray-500">
          Connect your wallet to see your activity.
        </div>
      )}

      {/* Events table */}
      {(tab === 'all' || wallet.isConnected) && (
        <div className="rounded-card border border-surface-border bg-surface overflow-hidden">
          {loading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon="📜"
              title="No activity yet"
              description={`No events found in the last ${FETCH_BLOCKS.toLocaleString()} blocks${filterKey !== 'all' ? ` for filter "${filterKey}"` : ''}.`}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-surface-border bg-surface-sub/50">
                    {['Time', 'Type', 'User', 'Details', 'Block', 'Tx'].map(h => (
                      <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {visible.map((e, i) => (
                    <tr key={i} className="hover:bg-surface-elev/50 transition-colors">
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {fTime(e.timestamp)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${TYPE_STYLE[e.type] ?? 'bg-gray-800 text-gray-300 border-gray-700'}`}>
                          {TYPE_LABEL[e.type] ?? e.type}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">
                        {shortAddr(e.user)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-300 max-w-xs">
                        {renderDetails(e)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-500 whitespace-nowrap">
                        #{e.blockNumber}
                      </td>
                      <td className="px-4 py-2.5">
                        {explorerTx(e.txHash, wallet.chainId) ? (
                          <a
                            href={explorerTx(e.txHash, wallet.chainId)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-emerald-500 hover:text-emerald-300 transition-colors text-base"
                          >
                            ↗
                          </a>
                        ) : (
                          <span className="text-gray-700 text-xs font-mono" title={e.txHash}>
                            {e.txHash.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Footer note */}
      <p className="text-xs text-gray-600 text-center">
        Showing events from last ~{FETCH_BLOCKS.toLocaleString()} blocks (~15 hours on Sepolia) ·{' '}
        {visible.length} event{visible.length !== 1 ? 's' : ''} displayed ·
        Older history: use Etherscan or queryFilter with a custom fromBlock
      </p>
    </div>
  )
}
