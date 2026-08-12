import type { Contract } from 'ethers'

import { MONO } from 'src/components/pepefi/brandKit'
import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';

// ── Constants ─────────────────────────────────────────────────────────────────
// Base Sepolia blocks every ~2s, and its public RPC (sepolia.base.org) rejects
// eth_getLogs ranges over 2000 blocks ("query exceeds max block range 2000").
// FETCH_BLOCKS is the total lookback; CHUNK_SIZE keeps every single request
// under that cap — queryFilterChunked() below splits the range accordingly.
const FETCH_BLOCKS = 9000   // ~5 h on Base Sepolia (2 s/block)
const CHUNK_SIZE    = 1800

// Events are cached client-side so history survives past the scan window — the
// chain keeps everything forever, but a fixed lookback can only ever see the
// tail of it. This is a browser-local cache, not a backend: it accumulates what
// this browser has already seen, and anything in it is still verifiable on
// BaseScan. MAX_CACHED is a safety valve against the ~5 MB localStorage quota;
// overflowing prunes the oldest rows, so a very deep "load more" walk is not
// guaranteed to persist in full.
const MAX_CACHED = 1000

// Positions come from contract storage, which has no block-range limit — a
// user's own history is always fetched in full via getUserPositions(). Only the
// "All Activity" walk needs a brake: it steps back from nextPositionId, so this
// bounds load time once the platform outgrows a few hundred positions.
const MAX_POSITION_SCAN = 400

const ZERO_ASSET = `0x${'0'.repeat(64)}`

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
  /** Absent on rows rebuilt from contract storage — storage keeps no tx hash. */
  txHash?:     string
  /** Log index within the tx — with txHash this is the event's on-chain identity. */
  logIndex?:   number
  /** 0 when unknown (storage-derived rows). */
  blockNumber: number
  timestamp:   number
  details:     Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ── Merge / cache ─────────────────────────────────────────────────────────────

/**
 * Stable identity for a row, independent of where it was read from.
 *
 * Position rows arrive from two sources — event logs (recent, has a tx hash)
 * and contract storage (complete, has none) — so they key on the position id
 * instead, or the same open would show up twice. Everything else keys on
 * txHash + logIndex: txHash alone is not unique, since one tx can emit several
 * events (a copy-trade opens the leader's and every follower's position).
 */
const eventKey = (e: ChainEvent): string => {
  const pid = e.details.positionId
  if (pid !== undefined && (e.type === 'PositionOpened' || e.type === 'PositionClosed')) {
    return `pos:${pid}:${e.type}`
  }
  return `${e.txHash ?? 'storage'}:${e.logIndex ?? 0}`
}

/**
 * Newest first, de-duplicated — overlapping scan ranges are expected, and the
 * log and storage sources deliberately overlap. On a collision the row with a
 * tx hash wins, so a recent position keeps its BaseScan link rather than being
 * flattened into the storage version.
 */
function mergeEvents(...lists: ChainEvent[][]): ChainEvent[] {
  const byKey = new Map<string, ChainEvent>()
  for (const list of lists) {
    for (const e of list) {
      const k    = eventKey(e)
      const seen = byKey.get(k)
      if (!seen || (!seen.txHash && e.txHash)) byKey.set(k, e)
    }
  }
  // Sort on timestamp: storage rows have no block number, but every row has a
  // trustworthy time (openedAt / closedAt on chain, block time for logs).
  return [...byKey.values()].sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      b.blockNumber - a.blockNumber ||
      (b.logIndex ?? 0) - (a.logIndex ?? 0),
  )
}

// `details` holds bigints, which JSON.stringify throws on — tag them on the way
// out and rebuild them on the way in, so cached rows round-trip as real bigints
// and renderDetails() keeps working on cached data.
const jsonReplacer = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? { __big: v.toString() } : v

const jsonReviver = (_k: string, v: unknown) =>
  v !== null && typeof v === 'object' && '__big' in v
    ? BigInt((v as { __big: string }).__big)
    : v

interface CachedHistory {
  events: ChainEvent[]
  /** Oldest block this browser has scanned — where "load more" resumes. */
  scannedFrom: number | null
}

const cacheKeyFor = (chainId: number | null, tab: string, address: string | null) =>
  `pepefi:history:${chainId ?? 0}:${tab}:${address?.toLowerCase() ?? 'all'}`

function loadCache(key: string): CachedHistory {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { events: [], scannedFrom: null }
    const parsed = JSON.parse(raw, jsonReviver) as CachedHistory
    return { events: parsed.events ?? [], scannedFrom: parsed.scannedFrom ?? null }
  } catch {
    return { events: [], scannedFrom: null }   // corrupt / private mode
  }
}

function saveCache(key: string, events: ChainEvent[], scannedFrom: number | null) {
  try {
    const payload: CachedHistory = { events: events.slice(0, MAX_CACHED), scannedFrom }
    localStorage.setItem(key, JSON.stringify(payload, jsonReplacer))
  } catch { /* quota exceeded or private mode — cache is best-effort */ }
}

/**
 * Splits [fromBlock, toBlock] into <= chunkSize windows before calling
 * contract.queryFilter — a single call spanning the whole range silently
 * fails on RPCs that cap eth_getLogs (e.g. Base Sepolia's public RPC caps at
 * 2000 blocks and throws "query exceeds max block range"). With 12 event
 * types firing chunks in parallel, the same public RPC also rate-limits
 * bursts (HTTP 429) — each chunk gets a couple of backoff retries before
 * being counted as a real failure, which is reported instead of swallowed
 * so partial data doesn't silently look like "no data".
 */
async function queryFilterChunked(
  contract: Contract,
  filter: unknown,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ logs: any[]; errors: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs:   any[]    = []
  const errors: string[] = []
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock)
    let lastErr: unknown
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1))  // 400ms, 800ms
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logs.push(...(await contract.queryFilter(filter as any, start, end)))
        ok = true
      } catch (err) {
        lastErr = err
      }
    }
    if (!ok) errors.push(lastErr instanceof Error ? lastErr.message : String(lastErr))
  }
  return { logs, errors }
}

/**
 * Rebuilds position history from contract storage instead of event logs.
 *
 * This is the only source that is actually complete. Logs can only ever be read
 * through a bounded block window, but PerpetualExchange keeps every position in
 * storage forever — `getUserPositions` is a permanent per-user index, and each
 * `getPosition` carries openedAt / closedAt / realizedPnL. Verified against the
 * live contract: position #1 dates to 2026-06-21 and still reads back today.
 *
 * The tradeoff is that storage has no tx hash, so these rows cannot deep-link
 * to a transaction. mergeEvents() prefers the log-derived row when both exist,
 * which keeps the ↗ link on anything recent enough to still be in the window.
 *
 * Only positions work this way — swaps, margin moves, fees, stakes and oracle
 * updates leave no per-user storage trail, so they stay log-only.
 */
async function fetchPositionEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exchange: any,
  owner: string | null,
): Promise<{ evs: ChainEvent[]; missed: number }> {
  let ids: bigint[]
  if (owner) {
    ids = [...(await withRetry(() => exchange.getUserPositions(owner)) as bigint[])]
  } else {
    const next = Number(await withRetry(() => exchange.nextPositionId()))
    const from = Math.max(0, next - MAX_POSITION_SCAN)
    ids = Array.from({ length: next - from }, (_, i) => BigInt(next - 1 - i))
  }

  let missed = 0
  const positions = await mapLimit(ids, RPC_CONCURRENCY, async (id) => {
    try {
      // Retry rather than skip: the public RPC drops calls under load, and a
      // silent skip reads as "you never opened that position".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await withRetry(() => exchange.getPosition(id)) as any
    } catch {
      missed += 1
      return null
    }
  })

  const evs: ChainEvent[] = []
  for (const p of positions) {
    if (!p || !p.asset || p.asset === ZERO_ASSET) continue   // unwritten slot
    const positionId = p.id as bigint
    evs.push({
      type: 'PositionOpened',
      user: p.owner as string,
      blockNumber: 0,
      timestamp: Number(p.openedAt),
      details: {
        positionId,
        asset:      p.asset as string,
        isLong:     p.isLong as boolean,
        entryPrice: p.entryPrice as bigint,
        margin:     p.margin as bigint,
        leverage:   p.leverage as bigint,
      },
    })
    if (Number(p.closedAt) > 0) {
      evs.push({
        type: 'PositionClosed',
        user: p.owner as string,
        blockNumber: 0,
        timestamp: Number(p.closedAt),
        details: {
          positionId,
          pnl: p.realizedPnL as bigint,
          // Storage records realised PnL, not the amount transferred back.
          closeAmount: undefined,
        },
      })
    }
  }
  return { evs, missed }
}

const shortAddr = (addr?: string) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'

// Split into date and clock so the two can sit on one line when the column is
// wide and stack when it is not. Locale is pinned to en-US rather than left to
// the browser: the surrounding UI is English, and the default locale renders
// the meridiem in the user's language (上午/下午) next to English column headers.
// 2-digit month/day (not 'numeric') so every date is the same character count —
// "7/9/2026" next to "12/14/2026" ragged-lines the column; "07/09/2026" next to
// "12/14/2026" lines up.
const fDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })

const fClock = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

const f18  = (v: bigint) => (Number(v) / 1e18).toFixed(2)
const fEth = (v: bigint) => (Number(v) / 1e18).toFixed(6)

const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Oracle prices — MockOracle stores 8 decimals. */
const f8 = (v: bigint) => usd(Number(v) / 1e8)

/**
 * Position entry prices — 18 decimals, NOT 8.
 *
 * PerpetualExchange.sol:129 declares `uint256 entryPrice; // 18 decimals`, and
 * _markPrice() scales the oracle's 8-decimal feed up before storing. Formatting
 * these with f8 renders a $64k BTC entry as $641,480,779,573,500.
 */
const fPrice18 = (v: bigint) => usd(Number(v) / 1e18)

// ── Type badge styling ────────────────────────────────────────────────────────
const TYPE_STYLE: Record<EventType, any> = {
  Swap:             { bgcolor: 'rgba(0, 184, 217, 0.16)', color: '#00b8d9', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.24)' },
  PositionOpened:   { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' },
  PositionClosed:   { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  MarginDeposited:  { bgcolor: 'rgba(0, 184, 217, 0.16)', color: '#00b8d9', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.24)' },
  MarginWithdrawn:  { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  TraderFollowed:   { bgcolor: 'rgba(142, 51, 255, 0.16)', color: '#8e33ff', border: '1px solid', borderColor: 'rgba(142, 51, 255, 0.24)' },
  TraderUnfollowed: { bgcolor: 'rgba(145, 158, 171, 0.16)', color: '#919eab', border: '1px solid', borderColor: 'rgba(145, 158, 171, 0.24)' },
  CopyFee:          { bgcolor: 'rgba(0, 167, 111, 0.16)', color: '#00a76f', border: '1px solid', borderColor: 'rgba(0, 167, 111, 0.24)' },
  PriceUpdated:     { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' },
  Stake:            { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  Slash:            { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' },
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
      return d.direction === 'ETH→mUSDC'
        ? <span><Typography variant="body2" component="span" color="text.secondary">{fEth(d.ethIn as bigint)} ETH</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{f18(d.usdcOut as bigint)} mUSDC</Typography></span>
        : <span><Typography variant="body2" component="span" color="text.secondary">{f18(d.usdcIn as bigint)} mUSDC</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{fEth(d.ethOut as bigint)} ETH</Typography></span>

    case 'PositionOpened': {
      const label   = ASSET_LABEL[d.asset as string] ?? '?'
      const side    = (d.isLong as boolean) ? 'LONG' : 'SHORT'
      const sideCol = (d.isLong as boolean) ? 'success.main' : 'error.main'
      return <span><Box component="span" sx={{ fontWeight: 'bold', color: sideCol }}>{side}</Box> {label} {String(d.leverage as bigint)}× @ {fPrice18(d.entryPrice as bigint)} | Margin: {f18(d.margin as bigint)} mUSDC</span>
    }

    case 'PositionClosed': {
      const pnl    = d.pnl as bigint
      const pnlStr = (pnl >= 0n ? '+' : '') + f18(pnl)
      const col    = pnl >= 0n ? 'success.main' : 'error.main'
      // closeAmount only exists on the log-derived row — storage records the
      // realised PnL but not the amount transferred back.
      const received = d.closeAmount as bigint | undefined
      return (
        <span>
          PnL: <Box component="span" sx={{ fontWeight: 'bold', color: col }}>{pnlStr}</Box> mUSDC
          {received !== undefined && ` | Received: ${f18(received)}`}
        </span>
      )
    }

    case 'MarginDeposited':
      return <Box component="span" sx={{ color: 'success.main', fontWeight: 'semibold' }}>+{f18(d.amount as bigint)} mUSDC</Box>

    case 'MarginWithdrawn':
      return <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>−{f18(d.amount as bigint)} mUSDC</Box>

    case 'TraderFollowed': {
      const trader = d.trader as string
      return <span>Following <Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{shortAddr(trader)}</Box> | Margin: {f18(d.totalMargin as bigint)} mUSDC</span>
    }

    case 'TraderUnfollowed': {
      const trader = d.trader as string
      return <span>Unfollowed <Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{shortAddr(trader)}</Box></span>
    }

    case 'CopyFee':
      return <span>Earned: <Box component="span" sx={{ color: 'primary.main', fontWeight: 'bold' }}>{f18(d.traderShare as bigint)}</Box> mUSDC (fee: {f18(d.fee as bigint)})</span>

    case 'PriceUpdated': {
      const label = ASSET_LABEL[d.assetId as string] ?? '?'
      return <span>{label}: {f8(d.oldPrice as bigint)} → <Box component="span" sx={{ color: 'info.main', fontWeight: 'semibold' }}>{f8(d.newPrice as bigint)}</Box></span>
    }

    case 'Stake':
      return <span>Staked <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> mUSDC</span>

    case 'Slash': {
      const recipient = d.recipient as string
      return <span>Slashed <Box component="span" sx={{ color: 'error.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> mUSDC → <Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(recipient)}</Box></span>
    }

    default:
      return <Typography variant="caption" color="text.secondary">{JSON.stringify(d).slice(0, 80)}</Typography>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [tab,        setTab]        = useState<'mine' | 'all'>('mine')
  const [events,     setEvents]     = useState<ChainEvent[]>([])
  const [loading,    setLoading]    = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [filterKey,  setFilterKey]  = useState<FilterKey>('all')
  /** Oldest block scanned so far — the resume point for "load older". */
  const [scannedFrom, setScannedFrom] = useState<number | null>(null)

  const cacheKey = cacheKeyFor(wallet.chainId, tab, tab === 'mine' ? wallet.address : null)

  // Mirror both in refs: the restore effect and the scanners run after the
  // render that built their closures, so reading state there would see the
  // pre-restore values — which would reset a previous session's "load older"
  // progress back to the top window on every reload.
  const eventsRef      = useRef<ChainEvent[]>([])
  const scannedFromRef = useRef<number | null>(null)

  const commit = useCallback((next: ChainEvent[], nextScannedFrom: number | null) => {
    eventsRef.current      = next
    scannedFromRef.current = nextScannedFrom
    setEvents(next)
    setScannedFrom(nextScannedFrom)
    saveCache(cacheKey, next, nextScannedFrom)
  }, [cacheKey])

  // Paint whatever this browser already knows before touching the network, and
  // reset cleanly when the wallet / tab / chain changes.
  useEffect(() => {
    const cached = loadCache(cacheKey)
    eventsRef.current      = cached.events
    scannedFromRef.current = cached.scannedFrom
    setEvents(cached.events)
    setScannedFrom(cached.scannedFrom)
  }, [cacheKey])

  // ── Event fetcher ───────────────────────────────────────────────────────
  /** Scans one block window and returns its events — no state, no merging. */
  const scanRange = useCallback(async (
    fromBlock: number,
    toBlock: number,
  ): Promise<{ evs: ChainEvent[]; failedChunks: number }> => {
    if (!contracts || !wallet.provider) return { evs: [], failedChunks: 0 }
    const uf = tab === 'mine' ? (wallet.address ?? null) : null
    const chunked = (contract: Contract, filter: unknown) =>
      queryFilterChunked(contract, filter, fromBlock, toBlock, CHUNK_SIZE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const empty = Promise.resolve({ logs: [] as any[], errors: [] as string[] })

    const results = await Promise.all([
      // [0] ETH→mUSDC swaps
      chunked(contracts.swapRouter, uf ? contracts.swapRouter.filters.SwapEthToUsdc(uf) : contracts.swapRouter.filters.SwapEthToUsdc()),
      // [1] mUSDC→ETH swaps
      chunked(contracts.swapRouter, uf ? contracts.swapRouter.filters.SwapUsdcToEth(uf) : contracts.swapRouter.filters.SwapUsdcToEth()),
      // [2] PositionOpened
      chunked(contracts.exchange, uf ? contracts.exchange.filters.PositionOpened(null, uf) : contracts.exchange.filters.PositionOpened()),
      // [3] PositionClosed
      chunked(contracts.exchange, uf ? contracts.exchange.filters.PositionClosed(null, uf) : contracts.exchange.filters.PositionClosed()),
      // [4] MarginDeposited
      chunked(contracts.exchange, uf ? contracts.exchange.filters.MarginDeposited(uf) : contracts.exchange.filters.MarginDeposited()),
      // [5] MarginWithdrawn
      chunked(contracts.exchange, uf ? contracts.exchange.filters.MarginWithdrawn(uf) : contracts.exchange.filters.MarginWithdrawn()),
      // [6] TraderFollowed (mine: as follower; all: everyone)
      chunked(contracts.copyTracker, uf ? contracts.copyTracker.filters.TraderFollowed(uf, null) : contracts.copyTracker.filters.TraderFollowed()),
      // [7] TraderUnfollowed (mine only)
      uf ? chunked(contracts.copyTracker, contracts.copyTracker.filters.TraderUnfollowed(uf, null)) : empty,
      // [8] CopyFeeDistributed (mine: as trader)
      chunked(contracts.feeRouter, uf ? contracts.feeRouter.filters.CopyFeeDistributed(uf) : contracts.feeRouter.filters.CopyFeeDistributed()),
      // [9] PriceUpdated (all mode only — too noisy for "mine")
      tab === 'all' ? chunked(contracts.oracle, contracts.oracle.filters.PriceUpdated()) : empty,
      // [10] Staked
      chunked(contracts.traderStake, uf ? contracts.traderStake.filters.Staked(uf) : contracts.traderStake.filters.Staked()),
      // [11] Slashed
      chunked(contracts.traderStake, uf ? contracts.traderStake.filters.Slashed(uf, null) : contracts.traderStake.filters.Slashed()),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getLogs = (i: number): any[] => results[i].logs
    const failedChunks = results.reduce((n, r) => n + r.errors.length, 0)

    const evs: ChainEvent[] = []

    // 0 — ETH→mUSDC
    for (const log of getLogs(0)) {
      const a = log.args
      evs.push({ type: 'Swap', user: a.user, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber,
        timestamp: Number(a.timestamp ?? 0),
        details: { direction: 'ETH→mUSDC', ethIn: a.ethIn as bigint, usdcOut: a.usdcOut as bigint } })
    }
    // 1 — mUSDC→ETH
    for (const log of getLogs(1)) {
      const a = log.args
      evs.push({ type: 'Swap', user: a.user, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber,
        timestamp: Number(a.timestamp ?? 0),
        details: { direction: 'mUSDC→ETH', usdcIn: a.usdcIn as bigint, ethOut: a.ethOut as bigint } })
    }
    // 2 — PositionOpened
    for (const log of getLogs(2)) {
      const a = log.args
      evs.push({ type: 'PositionOpened', user: a.owner, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { positionId: a.positionId as bigint, asset: a.asset as string, isLong: a.isLong as boolean,
          entryPrice: a.entryPrice as bigint, margin: a.margin as bigint, leverage: a.leverage as bigint } })
    }
    // 3 — PositionClosed
    for (const log of getLogs(3)) {
      const a = log.args
      evs.push({ type: 'PositionClosed', user: a.owner, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { positionId: a.positionId as bigint, pnl: a.pnl as bigint, closeAmount: a.closeAmount as bigint } })
    }
    // 4 — MarginDeposited
    for (const log of getLogs(4)) {
      const a = log.args
      evs.push({ type: 'MarginDeposited', user: a.user, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { amount: a.amount as bigint } })
    }
    // 5 — MarginWithdrawn
    for (const log of getLogs(5)) {
      const a = log.args
      evs.push({ type: 'MarginWithdrawn', user: a.user, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { amount: a.amount as bigint } })
    }
    // 6 — TraderFollowed
    for (const log of getLogs(6)) {
      const a = log.args
      evs.push({ type: 'TraderFollowed', user: a.follower, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { trader: a.trader as string, totalMargin: a.totalMargin as bigint } })
    }
    // 7 — TraderUnfollowed
    for (const log of getLogs(7)) {
      const a = log.args
      evs.push({ type: 'TraderUnfollowed', user: a.follower, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { trader: a.trader as string } })
    }
    // 8 — CopyFeeDistributed
    for (const log of getLogs(8)) {
      const a = log.args
      evs.push({ type: 'CopyFee', user: a.trader, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { fee: a.fee as bigint, traderShare: a.traderShare as bigint } })
    }
    // 9 — PriceUpdated
    for (const log of getLogs(9)) {
      const a = log.args
      evs.push({ type: 'PriceUpdated', user: undefined, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber,
        timestamp: Number(a.timestamp ?? 0),
        details: { assetId: a.assetId as string, oldPrice: a.oldPrice as bigint, newPrice: a.newPrice as bigint } })
    }
    // 10 — Staked
    for (const log of getLogs(10)) {
      const a = log.args
      evs.push({ type: 'Stake', user: a.trader, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
        details: { amount: a.amount as bigint } })
    }
    // 11 — Slashed
    for (const log of getLogs(11)) {
      const a = log.args
      evs.push({ type: 'Slash', user: a.trader, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, timestamp: 0,
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

    return { evs, failedChunks }
  }, [contracts, tab, wallet.address, wallet.provider])

  /** Says which part is incomplete, so a gap is never mistaken for "no data". */
  const reportScanIssues = (failedChunks: number, missedPositions = 0) => {
    const notes: string[] = []
    if (failedChunks > 0) {
      notes.push(`${failedChunks} block-range quer${failedChunks === 1 ? 'y' : 'ies'} failed (swaps, margin, fees and stakes may be incomplete)`)
    }
    if (missedPositions < 0) {
      notes.push('the position index could not be read — positions below may be missing')
    } else if (missedPositions > 0) {
      notes.push(`${missedPositions} position${missedPositions === 1 ? '' : 's'} could not be read`)
    }
    setError(notes.length ? `${notes.join(' · ')}. Refresh to retry.` : null)
  }

  /** Re-scans the newest window and folds it into what's already known. */
  const refresh = useCallback(async () => {
    if (!contracts || !wallet.provider) return
    setLoading(true)
    setError(null)
    try {
      const currentBlock = await wallet.provider.getBlockNumber()
      const windowStart  = Math.max(0, currentBlock - FETCH_BLOCKS)

      // Deliberately sequential, not Promise.all: the log scan alone already
      // gets rate-limited on the public RPC, and firing a few hundred eth_calls
      // alongside it makes both worse. Positions go first — they are the
      // complete, most-wanted half — and are shown before the logs come back.
      const owner = tab === 'mine' ? (wallet.address ?? null) : null
      const posResult = await fetchPositionEvents(contracts.exchange, owner)
        .catch((err): { evs: ChainEvent[]; missed: number } => {
          console.error('[history:positions]', err)
          return { evs: [], missed: -1 }   // -1 = the index read itself failed
        })

      // If the cache's newest log-derived event predates this window, the blocks
      // in between were never scanned. Restarting `scannedFrom` at the window
      // floor lets "load older" walk backwards through that gap. Storage rows
      // are excluded: they carry no block number, and counting their 0 as
      // "newest seen" would report a gap on every single refresh.
      const prevFrom = scannedFromRef.current
      const newestSeen = eventsRef.current.reduce((max, e) => Math.max(max, e.blockNumber), -1)
      const hasGap   = newestSeen > 0 && newestSeen < windowStart - 1
      const nextFrom = hasGap || prevFrom === null
        ? windowStart
        : Math.min(prevFrom, windowStart)

      commit(mergeEvents(eventsRef.current, posResult.evs), nextFrom)

      const { evs, failedChunks } = await scanRange(windowStart, currentBlock)
      commit(mergeEvents(eventsRef.current, evs), nextFrom)
      reportScanIssues(failedChunks, posResult.missed)
    } catch (err) {
      console.error('[history]', err)
      setError(err instanceof Error ? err.message.slice(0, 120) : 'Failed to fetch events')
    } finally {
      setLoading(false)
    }
  }, [commit, contracts, scanRange, wallet.provider])

  /** Extends the scan one window further back, below everything seen so far. */
  const loadOlder = useCallback(async () => {
    const from = scannedFromRef.current
    if (!contracts || !wallet.provider || from === null || from <= 0) return
    setLoadingMore(true)
    setError(null)
    try {
      const toBlock   = from - 1
      const fromBlock = Math.max(0, toBlock - FETCH_BLOCKS + 1)
      const { evs, failedChunks } = await scanRange(fromBlock, toBlock)
      commit(mergeEvents(eventsRef.current, evs), fromBlock)
      reportScanIssues(failedChunks)
    } catch (err) {
      console.error('[history:older]', err)
      setError(err instanceof Error ? err.message.slice(0, 120) : 'Failed to fetch older events')
    } finally {
      setLoadingMore(false)
    }
  }, [commit, contracts, scanRange, wallet.provider])

  useEffect(() => { void refresh() }, [contracts, tab, wallet.address, wallet.provider])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtering ─────────────────────────────────────────────────────────────
  const allowed = FILTER_TYPES[filterKey]
  const visible  = allowed ? events.filter(e => allowed.includes(e.type)) : events

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Header */}
      {/* 'between' 不是合法的 justify-content 值（那是 Tailwind 的簡寫），
          瀏覽器會整條宣告丟掉。同一個錯誤原本也在 WhaleTrackerPage 的 header。 */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            Transaction History
          </Typography>
          <Typography variant="body2" color="text.secondary">
            On-chain auditability — decoded directly from Base Sepolia via ethers.js
          </Typography>
        </Box>
        <Button
          variant="text"
          onClick={() => void refresh()}
          disabled={loading || loadingMore}
          sx={{ textTransform: 'none' }}
        >
          {loading ? 'Loading…' : '↺ Refresh'}
        </Button>
      </Box>

      {/* Proof-of-transparency note */}
      <Alert severity="info" sx={{ bgcolor: 'rgba(0, 184, 217, 0.08)', color: 'info.lighter', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        All activity is read directly from the Base Sepolia blockchain — no backend and no server-side database, just the immutable ledger.{' '}
        <Box component="span" sx={{ fontWeight: 'bold', color: 'text.primary' }}>Positions are complete</Box> — every one you have ever
        opened is read from contract storage, however long ago. Swaps, margin moves, fees and stakes exist only as event logs, which the
        RPC serves in a limited block window, so those build up from what this browser has already seen.{' '}
        Click <Box component="span" sx={{ color: 'success.main', fontWeight: 'bold', fontFamily: MONO }}>↗</Box> to verify a row on BaseScan.
      </Alert>

      {/* Tabs */}
      <Tabs
        value={tab}
        onChange={(_, val) => { setTab(val); setFilterKey('all') }}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab
          value="mine"
          label={wallet.isConnected ? 'My Activity' : 'My Activity (connect wallet)'}
          sx={{ textTransform: 'none' }}
        />
        <Tab
          value="all"
          label="All Activity"
          sx={{ textTransform: 'none' }}
        />
      </Tabs>

      {/* Type filter chips */}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        {FILTERS.map(f => {
          const active = filterKey === f.key;
          return (
            <Chip
              key={f.key}
              label={
                active && visible.length > 0
                  ? `${f.label} (${visible.length})`
                  : f.label
              }
              onClick={() => setFilterKey(f.key)}
              color={active ? 'primary' : 'default'}
              variant={active ? 'filled' : 'outlined'}
              size="small"
              sx={{ cursor: 'pointer' }}
            />
          );
        })}
      </Stack>

      {/* Error banner */}
      {error && (
        <Alert severity="error">
          {error}
        </Alert>
      )}

      {/* "Mine" tab, no wallet */}
      {tab === 'mine' && !wallet.isConnected && (
        <Card sx={{ p: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="text.secondary">Connect your wallet to see your activity.</Typography>
        </Card>
      )}

      {/* Events table */}
      {(tab === 'all' || wallet.isConnected) && (
        <Card>
          {/* Cached rows stay on screen while refreshing — only a cold load blanks out. */}
          {loading && events.length === 0 ? (
            <TableSkeleton rows={5} cols={6} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon="📜"
              title="No activity yet"
              description={`No events found in the last ${FETCH_BLOCKS.toLocaleString()} blocks${filterKey !== 'all' ? ` for filter "${filterKey}"` : ''}.`}
            />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    {['Time', 'Type', 'User', 'Details', 'Block', 'Tx'].map(h => (
                      <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visible.map(e => (
                    <TableRow key={eventKey(e)} hover>
                      <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary', fontFamily: MONO }}>
                        {e.timestamp ? (
                          // One line while the column has room; the clock wraps
                          // onto its own line when it doesn't. Each part stays
                          // unbroken so a date never splits mid-way. Monospace +
                          // a fixed date width makes every row's date and time
                          // start in the same column instead of ragging with
                          // the proportional-font table body.
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 0.75 }}>
                            <Box component="span" sx={{ whiteSpace: 'nowrap', minWidth: '5.5em' }}>{fDate(e.timestamp)}</Box>
                            <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{fClock(e.timestamp)}</Box>
                          </Box>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={TYPE_LABEL[e.type] ?? e.type}
                          size="small"
                          sx={{
                            fontWeight: 'bold',
                            minWidth: 76,
                            justifyContent: 'center',
                            ...TYPE_STYLE[e.type]
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
                        {shortAddr(e.user)}
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.75rem', color: 'text.primary' }}>
                        {renderDetails(e)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
                        {e.blockNumber > 0 ? `#${e.blockNumber}` : '—'}
                      </TableCell>
                      <TableCell>
                        {e.txHash && explorerTx(e.txHash, wallet.chainId) ? (
                          <Link
                            href={explorerTx(e.txHash, wallet.chainId)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            color="success.main"
                            sx={{ fontWeight: 'bold', fontSize: '1.1rem', textDecoration: 'none' }}
                          >
                            ↗
                          </Link>
                        ) : e.txHash ? (
                          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                            {e.txHash.slice(0, 8)}…
                          </Typography>
                        ) : (
                          // Rebuilt from contract storage, which keeps no tx hash.
                          <Tooltip title="Read from contract storage — permanent, but not tied to a single transaction. Verify with getPosition() on BaseScan.">
                            <Typography variant="caption" sx={{ color: 'text.disabled', cursor: 'help' }}>
                              storage
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      )}

      {/* Walk the scan window further back, one FETCH_BLOCKS window at a time */}
      {(tab === 'all' || wallet.isConnected) && scannedFrom !== null && scannedFrom > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Button
            variant="outlined"
            onClick={() => void loadOlder()}
            disabled={loading || loadingMore}
            sx={{ textTransform: 'none' }}
          >
            {loadingMore
              ? 'Scanning older blocks…'
              : `↓ Load older (blocks ${Math.max(0, scannedFrom - FETCH_BLOCKS).toLocaleString()}–${(scannedFrom - 1).toLocaleString()})`}
          </Button>
        </Box>
      )}

      {/* Footer note */}
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block', mt: 2 }}>
        {visible.length} event{visible.length !== 1 ? 's' : ''} displayed ·{' '}
        Positions read in full from contract storage
        {scannedFrom !== null && ` · logs scanned back to block #${scannedFrom.toLocaleString()}`}{' '}
        · Log rows are cached in this browser only; clearing site data resets them, but the chain keeps everything.
      </Typography>
    </Container>
  )
}
