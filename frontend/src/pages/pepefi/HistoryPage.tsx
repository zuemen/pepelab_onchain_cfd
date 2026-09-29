import type { Contract } from 'ethers'

import { MONO } from 'src/components/pepefi/brandKit'
import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useContracts } from 'src/hooks/useContracts'
import { useV2Contracts } from 'src/hooks/useV2Contracts'
import { isDeployed } from 'src/lib/pepefi/safeRead'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { t, interpolate } from 'src/locales'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import {
  UI_RETRIES,
  scanContractEvents,
  type ParsedEventLog,
  type DeferredTopicFilterLike,
} from 'src/lib/pepefi/chainLogs'

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
// Base Sepolia blocks every ~2s. FETCH_BLOCKS is the total lookback per
// refresh / "load older" step; every scan goes through scanContractEvents →
// getLogsChunked, whose CHUNK_SIZE is set from a measured node limit (the public
// RPC rejects eth_getLogs spans over 1,000 blocks — see chainLogs.ts).
const FETCH_BLOCKS = 9000   // ~5 h on Base Sepolia (2 s/block)

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
  // F3：V2 AssetVault 鑄造／贖回、PepeAMM 兌換、InsuranceVault 存入／提領。
  // 'Swap' 是舊版 MockSwapRouter 的事件，保留但標為 legacy。
  | 'AssetMint' | 'AssetRedeem' | 'AmmSwap' | 'VaultDeposit' | 'VaultWithdraw'

type FilterKey = 'all' | 'Swap' | 'Asset' | 'Vault' | 'Position' | 'Margin' | 'Social' | 'Fee' | 'Price' | 'Stake'

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

// v2（2026-09-29）：舊版快取是在 getLogs 分段全數被公開節點拒絕的時期寫下的——
// scannedFrom 已推進到「看似掃過」的區塊，但那些區塊其實一筆也沒讀到。升版讓它們
// 全部失效，重新掃描。
const cacheKeyFor = (chainId: number | null, tab: string, address: string | null) =>
  `pepefi:history:v2:${chainId ?? 0}:${tab}:${address?.toLowerCase() ?? 'all'}`

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

// ── Event scan sources ───────────────────────────────────────────────────────

/** 一個合約與要在它上面掃的事件。key 用來分派解析（不同合約可能有同名事件）。 */
interface EventSource {
  key: string
  contract: Contract
  filters: DeferredTopicFilterLike[]
}

const logBase = (log: ParsedEventLog) => ({
  txHash: log.transactionHash,
  logIndex: log.index,
  blockNumber: log.blockNumber,
})

/** 把解析後的 log 轉成頁面的一列。不認得的 (source, event) 回 null。 */
function toChainEvent(source: string, log: ParsedEventLog): ChainEvent | null {
  const a = log.args
  switch (`${source}:${log.eventName}`) {
    case 'swapRouter:SwapEthToUsdc':
      return { type: 'Swap', user: a.user, ...logBase(log), timestamp: Number(a.timestamp ?? 0),
        details: { direction: 'ETH→USDC', ethIn: a.ethIn as bigint, usdcOut: a.usdcOut as bigint } }
    case 'swapRouter:SwapUsdcToEth':
      return { type: 'Swap', user: a.user, ...logBase(log), timestamp: Number(a.timestamp ?? 0),
        details: { direction: 'USDC→ETH', usdcIn: a.usdcIn as bigint, ethOut: a.ethOut as bigint } }
    case 'exchange:PositionOpened':
      return { type: 'PositionOpened', user: a.owner, ...logBase(log), timestamp: 0,
        details: { positionId: a.positionId as bigint, asset: a.asset as string, isLong: a.isLong as boolean,
          entryPrice: a.entryPrice as bigint, margin: a.margin as bigint, leverage: a.leverage as bigint } }
    case 'exchange:PositionClosed':
      return { type: 'PositionClosed', user: a.owner, ...logBase(log), timestamp: 0,
        details: { positionId: a.positionId as bigint, pnl: a.pnl as bigint, closeAmount: a.closeAmount as bigint } }
    case 'exchange:MarginDeposited':
      return { type: 'MarginDeposited', user: a.user, ...logBase(log), timestamp: 0, details: { amount: a.amount as bigint } }
    case 'exchange:MarginWithdrawn':
      return { type: 'MarginWithdrawn', user: a.user, ...logBase(log), timestamp: 0, details: { amount: a.amount as bigint } }
    case 'copyTracker:TraderFollowed':
      return { type: 'TraderFollowed', user: a.follower, ...logBase(log), timestamp: 0,
        details: { trader: a.trader as string, totalMargin: a.totalMargin as bigint } }
    case 'copyTracker:TraderUnfollowed':
      return { type: 'TraderUnfollowed', user: a.follower, ...logBase(log), timestamp: 0, details: { trader: a.trader as string } }
    case 'feeRouter:CopyFeeDistributed':
      return { type: 'CopyFee', user: a.trader, ...logBase(log), timestamp: 0,
        details: { fee: a.fee as bigint, traderShare: a.traderShare as bigint } }
    case 'oracle:PriceUpdated':
      return { type: 'PriceUpdated', user: undefined, ...logBase(log), timestamp: Number(a.timestamp ?? 0),
        details: { assetId: a.assetId as string, oldPrice: a.oldPrice as bigint, newPrice: a.newPrice as bigint } }
    case 'traderStake:Staked':
      return { type: 'Stake', user: a.trader, ...logBase(log), timestamp: 0, details: { amount: a.amount as bigint } }
    case 'traderStake:Slashed':
      return { type: 'Slash', user: a.trader, ...logBase(log), timestamp: 0,
        details: { amount: a.amount as bigint, recipient: a.recipient as string } }
    case 'assetVaultV2:Minted':
      return { type: 'AssetMint', user: a.user, ...logBase(log), timestamp: 0,
        details: { assetId: a.assetId as string, usdcIn: a.usdcIn as bigint, tokenOut: a.tokenOut as bigint, fee: a.fee as bigint } }
    case 'assetVaultV2:Redeemed':
      return { type: 'AssetRedeem', user: a.user, ...logBase(log), timestamp: 0,
        details: { assetId: a.assetId as string, tokenIn: a.tokenIn as bigint, usdcOut: a.usdcOut as bigint, fee: a.fee as bigint } }
    case 'pepeAMM:Swap':
      return { type: 'AmmSwap', user: a.user, ...logBase(log), timestamp: 0,
        details: { ethToUsdc: a.ethToUsdc as boolean, amountIn: a.amountIn as bigint, amountOut: a.amountOut as bigint } }
    case 'insuranceVault:Deposited':
      return { type: 'VaultDeposit', user: a.user, ...logBase(log), timestamp: 0,
        details: { usdcAmount: a.usdcAmount as bigint, shares: a.shares as bigint } }
    case 'insuranceVault:Withdrawn':
      return { type: 'VaultWithdraw', user: a.user, ...logBase(log), timestamp: 0,
        details: { usdcAmount: a.usdcAmount as bigint, shares: a.shares as bigint } }
    default:
      return null
  }
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
  AssetMint:        { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' },
  AssetRedeem:      { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  AmmSwap:          { bgcolor: 'rgba(0, 184, 217, 0.16)', color: '#00b8d9', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.24)' },
  VaultDeposit:     { bgcolor: 'rgba(142, 51, 255, 0.16)', color: '#8e33ff', border: '1px solid', borderColor: 'rgba(142, 51, 255, 0.24)' },
  VaultWithdraw:    { bgcolor: 'rgba(145, 158, 171, 0.16)', color: '#919eab', border: '1px solid', borderColor: 'rgba(145, 158, 171, 0.24)' },
}

const TYPE_LABEL: Partial<Record<EventType, string>> = {
  Swap:             t.history.eventType.swapLegacy,
  PositionOpened:   t.history.eventType.opened,
  PositionClosed:   t.history.eventType.closed,
  MarginDeposited:  t.history.eventType.deposit,
  MarginWithdrawn:  t.history.eventType.withdraw,
  TraderFollowed:   t.history.eventType.follow,
  TraderUnfollowed: t.history.eventType.unfollow,
  CopyFee:          t.history.eventType.copyFee,
  PriceUpdated:     t.history.eventType.priceUpdated,
  Stake:            t.history.eventType.stake,
  Slash:            t.history.eventType.slash,
  AssetMint:        t.history.eventType.mint,
  AssetRedeem:      t.history.eventType.redeem,
  AmmSwap:          t.history.eventType.ammSwap,
  VaultDeposit:     t.history.eventType.vaultDeposit,
  VaultWithdraw:    t.history.eventType.vaultWithdraw,
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',      label: t.history.filter.all },
  { key: 'Swap',     label: t.history.filter.swap },
  { key: 'Asset',    label: t.history.filter.asset },
  { key: 'Vault',    label: t.history.filter.vault },
  { key: 'Position', label: t.history.filter.position },
  { key: 'Margin',   label: t.history.filter.margin },
  { key: 'Social',   label: t.history.filter.social },
  { key: 'Fee',      label: t.history.filter.fee },
  { key: 'Price',    label: t.history.filter.price },
  { key: 'Stake',    label: t.history.filter.stake },
]

const FILTER_TYPES: Partial<Record<FilterKey, EventType[]>> = {
  Swap:     ['Swap', 'AmmSwap'],
  Asset:    ['AssetMint', 'AssetRedeem'],
  Vault:    ['VaultDeposit', 'VaultWithdraw'],
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
        ? <span><Typography variant="body2" component="span" color="text.secondary">{fEth(d.ethIn as bigint)} ETH</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{f18(d.usdcOut as bigint)} USDC</Typography></span>
        : <span><Typography variant="body2" component="span" color="text.secondary">{f18(d.usdcIn as bigint)} USDC</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{fEth(d.ethOut as bigint)} ETH</Typography></span>

    case 'PositionOpened': {
      const label   = ASSET_LABEL[d.asset as string] ?? '?'
      const side    = (d.isLong as boolean) ? t.history.detail.sideLong : t.history.detail.sideShort
      const sideCol = (d.isLong as boolean) ? 'success.main' : 'error.main'
      return <span><Box component="span" sx={{ fontWeight: 'bold', color: sideCol }}>{side}</Box> {label} {String(d.leverage as bigint)}× @ {fPrice18(d.entryPrice as bigint)} | {t.history.detail.marginLabel} {f18(d.margin as bigint)} USDC</span>
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
          {t.history.detail.pnlLabel} <Box component="span" sx={{ fontWeight: 'bold', color: col }}>{pnlStr}</Box> USDC
          {received !== undefined && interpolate(t.history.detail.receivedSuffix, { amount: f18(received) })}
        </span>
      )
    }

    case 'MarginDeposited':
      return <Box component="span" sx={{ color: 'success.main', fontWeight: 'semibold' }}>+{f18(d.amount as bigint)} USDC</Box>

    case 'MarginWithdrawn':
      return <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>−{f18(d.amount as bigint)} USDC</Box>

    case 'TraderFollowed': {
      const trader = d.trader as string
      return <span>{t.history.detail.following} <Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{shortAddr(trader)}</Box> | {t.history.detail.marginLabel} {f18(d.totalMargin as bigint)} USDC</span>
    }

    case 'TraderUnfollowed': {
      const trader = d.trader as string
      return <span>{t.history.detail.unfollowed} <Box component="span" sx={{ fontFamily: MONO, color: 'text.primary' }}>{shortAddr(trader)}</Box></span>
    }

    case 'CopyFee':
      return <span>{t.history.detail.earned} <Box component="span" sx={{ color: 'primary.main', fontWeight: 'bold' }}>{f18(d.traderShare as bigint)}</Box> USDC{interpolate(t.history.detail.feeSuffix, { fee: f18(d.fee as bigint) })}</span>

    case 'PriceUpdated': {
      const label = ASSET_LABEL[d.assetId as string] ?? '?'
      return <span>{label}: {f8(d.oldPrice as bigint)} → <Box component="span" sx={{ color: 'info.main', fontWeight: 'semibold' }}>{f8(d.newPrice as bigint)}</Box></span>
    }

    case 'Stake':
      return <span>{t.history.detail.staked} <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> USDC</span>

    case 'Slash': {
      const recipient = d.recipient as string
      return <span>{t.history.detail.slashed} <Box component="span" sx={{ color: 'error.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> USDC → <Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(recipient)}</Box></span>
    }

    case 'AmmSwap':
      return (d.ethToUsdc as boolean)
        ? <span><Typography variant="body2" component="span" color="text.secondary">{fEth(d.amountIn as bigint)} ETH</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{f18(d.amountOut as bigint)} USDC</Typography></span>
        : <span><Typography variant="body2" component="span" color="text.secondary">{f18(d.amountIn as bigint)} USDC</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{fEth(d.amountOut as bigint)} ETH</Typography></span>

    case 'AssetMint':
      return <span>{interpolate(t.history.detail.mint, {
        amount: fEth(d.tokenOut as bigint),
        asset:  ASSET_LABEL[d.assetId as string] ?? '?',
        usdc:   f18(d.usdcIn as bigint),
        fee:    f18(d.fee as bigint),
      })}</span>

    case 'AssetRedeem':
      return <span>{interpolate(t.history.detail.redeem, {
        amount: fEth(d.tokenIn as bigint),
        asset:  ASSET_LABEL[d.assetId as string] ?? '?',
        usdc:   f18(d.usdcOut as bigint),
        fee:    f18(d.fee as bigint),
      })}</span>

    case 'VaultDeposit':
      return <Box component="span" sx={{ color: 'success.main' }}>{interpolate(t.history.detail.vaultDeposit, { usdc: f18(d.usdcAmount as bigint), shares: f18(d.shares as bigint) })}</Box>

    case 'VaultWithdraw':
      return <Box component="span" sx={{ color: 'warning.main' }}>{interpolate(t.history.detail.vaultWithdraw, { usdc: f18(d.usdcAmount as bigint), shares: f18(d.shares as bigint) })}</Box>

    default:
      return <Typography variant="caption" color="text.secondary">{JSON.stringify(d).slice(0, 80)}</Typography>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const v2 = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId)

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
    const provider = wallet.provider

    // 每個合約一組 filter；scanContractEvents 會把「topic0 以外條件相同」的事件
    // 合成一趟分段 getLogs（CHUNK_SIZE 依實測上限，見 chainLogs.ts）。以前 12 種
    // 事件各自一趟、而且用自己的 1,800 塊分段——公開節點上限是 1,000 塊，每一段都
    // 被拒，最後整頁只剩從 storage 重建的部位。
    const sources: Array<Omit<EventSource, 'contract'> & { contract: Contract | null | undefined }> = [
      {
        // Legacy：舊版 MockSwapRouter（已由 PepeAMM 取代），保留以顯示歷史兌換。
        key: 'swapRouter',
        contract: contracts.swapRouter,
        filters: [
          uf ? contracts.swapRouter.filters.SwapEthToUsdc(uf) : contracts.swapRouter.filters.SwapEthToUsdc(),
          uf ? contracts.swapRouter.filters.SwapUsdcToEth(uf) : contracts.swapRouter.filters.SwapUsdcToEth(),
        ],
      },
      {
        key: 'exchange',
        contract: contracts.exchange,
        filters: [
          uf ? contracts.exchange.filters.PositionOpened(null, uf) : contracts.exchange.filters.PositionOpened(),
          uf ? contracts.exchange.filters.PositionClosed(null, uf) : contracts.exchange.filters.PositionClosed(),
          uf ? contracts.exchange.filters.MarginDeposited(uf) : contracts.exchange.filters.MarginDeposited(),
          uf ? contracts.exchange.filters.MarginWithdrawn(uf) : contracts.exchange.filters.MarginWithdrawn(),
        ],
      },
      {
        key: 'copyTracker',
        contract: contracts.copyTracker,
        filters: [
          // mine: as follower; all: everyone. Unfollow is mine-only.
          uf ? contracts.copyTracker.filters.TraderFollowed(uf, null) : contracts.copyTracker.filters.TraderFollowed(),
          ...(uf ? [contracts.copyTracker.filters.TraderUnfollowed(uf, null)] : []),
        ],
      },
      {
        key: 'feeRouter',
        contract: contracts.feeRouter,
        // mine: as trader
        filters: [uf ? contracts.feeRouter.filters.CopyFeeDistributed(uf) : contracts.feeRouter.filters.CopyFeeDistributed()],
      },
      {
        key: 'oracle',
        contract: contracts.oracle,
        // all mode only — too noisy for "mine"
        filters: tab === 'all' ? [contracts.oracle.filters.PriceUpdated()] : [],
      },
      {
        // V2 AssetVault（位址來自 addresses.ts 的 V2_STACK；該鏈沒有 V2 時為 null）。
        // Minted/Redeemed 的 user 是第 1 個 indexed 參數。
        key: 'assetVaultV2',
        contract: v2?.vault,
        filters: v2
          ? [
              uf ? v2.vault.filters.Minted(uf) : v2.vault.filters.Minted(),
              uf ? v2.vault.filters.Redeemed(uf) : v2.vault.filters.Redeemed(),
            ]
          : [],
      },
      {
        key: 'pepeAMM',
        contract: contracts.pepeAMM,
        filters: [uf ? contracts.pepeAMM.filters.Swap(uf) : contracts.pepeAMM.filters.Swap()],
      },
      {
        key: 'insuranceVault',
        contract: contracts.insuranceVault,
        filters: [
          uf ? contracts.insuranceVault.filters.Deposited(uf) : contracts.insuranceVault.filters.Deposited(),
          uf ? contracts.insuranceVault.filters.Withdrawn(uf) : contracts.insuranceVault.filters.Withdrawn(),
        ],
      },
      {
        key: 'traderStake',
        contract: contracts.traderStake,
        filters: [
          uf ? contracts.traderStake.filters.Staked(uf) : contracts.traderStake.filters.Staked(),
          uf ? contracts.traderStake.filters.Slashed(uf, null) : contracts.traderStake.filters.Slashed(),
        ],
      },
    ]

    // 併發 2：公開 RPC 對 getLogs 的突發請求會回 429；每段另有兩次退避重試。
    const results = await mapLimit(
      // 位址為 0x0（該鏈未部署）的來源直接略過，不去撥 0x0。
      sources.filter((s): s is EventSource =>
        !!s.contract && isDeployed(String(s.contract.target)) && s.filters.length > 0),
      2,
      async (s) => {
        try {
          const r = await scanContractEvents(provider, s.contract, s.filters, fromBlock, toBlock, { retries: UI_RETRIES })
          return { key: s.key, events: r.events, failedChunks: r.failedChunks }
        } catch (err) {
          console.warn('[history] scan failed', s.key, err)
          // 連 topic filter 都組不出來 = 整個來源讀不到，至少算一段失敗，不能變成「沒有資料」。
          return { key: s.key, events: [] as ParsedEventLog[], failedChunks: 1 }
        }
      },
    )
    const failedChunks = results.reduce((n, r) => n + r.failedChunks, 0)

    const evs: ChainEvent[] = []
    for (const r of results) {
      for (const log of r.events) {
        const ev = toChainEvent(r.key, log)
        if (ev) evs.push(ev)
      }
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
  }, [contracts, v2, tab, wallet.address, wallet.provider])

  /** Says which part is incomplete, so a gap is never mistaken for "no data". */
  const reportScanIssues = (failedChunks: number, missedPositions = 0) => {
    const notes: string[] = []
    if (failedChunks > 0) {
      notes.push(
        interpolate(
          failedChunks === 1 ? t.history.scanIssue.failedChunkOne : t.history.scanIssue.failedChunkMany,
          { count: failedChunks },
        ),
      )
    }
    if (missedPositions < 0) {
      notes.push(t.history.scanIssue.positionIndexUnreadable)
    } else if (missedPositions > 0) {
      notes.push(
        interpolate(
          missedPositions === 1 ? t.history.scanIssue.missedPositionOne : t.history.scanIssue.missedPositionMany,
          { count: missedPositions },
        ),
      )
    }
    setError(
      notes.length ? interpolate(t.history.scanIssue.refreshToRetry, { notes: notes.join(' · ') }) : null,
    )
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

      // 部位來自 storage，和日誌掃描範圍無關——先顯示，但掃描起點維持原值。
      commit(mergeEvents(eventsRef.current, posResult.evs), prevFrom)

      const { evs, failedChunks } = await scanRange(windowStart, currentBlock)
      // 有段落讀不到時不推進 scannedFrom：推進就等於宣稱那些區塊已經掃過，
      // 之後「載入較舊資料」會跳過它們，缺口永遠補不回來。
      commit(mergeEvents(eventsRef.current, evs), failedChunks > 0 ? prevFrom : nextFrom)
      reportScanIssues(failedChunks, posResult.missed)
    } catch (err) {
      console.error('[history]', err)
      setError(err instanceof Error ? err.message.slice(0, 120) : t.history.fetchFailed)
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
      // 同上：這一段沒有完整讀到，就不把起點往回推，下次「載入較舊」會重掃同一段。
      commit(mergeEvents(eventsRef.current, evs), failedChunks > 0 ? from : fromBlock)
      reportScanIssues(failedChunks)
    } catch (err) {
      console.error('[history:older]', err)
      setError(err instanceof Error ? err.message.slice(0, 120) : t.history.fetchOlderFailed)
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
            {t.history.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t.history.subtitle}
          </Typography>
        </Box>
        <Button
          variant="text"
          onClick={() => void refresh()}
          disabled={loading || loadingMore}
          sx={{ textTransform: 'none' }}
        >
          {loading ? t.history.loading : t.history.refresh}
        </Button>
      </Box>

      {/* Proof-of-transparency note */}
      <Alert severity="info" sx={{ bgcolor: 'rgba(0, 184, 217, 0.08)', color: 'info.lighter', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        {t.history.proofNote.intro}{' '}
        <Box component="span" sx={{ fontWeight: 'bold', color: 'text.primary' }}>{t.history.proofNote.positionsComplete}</Box>{' '}
        {t.history.proofNote.positionsCompleteRest}{' '}
        {t.history.proofNote.clickToVerify} <Box component="span" sx={{ color: 'success.main', fontWeight: 'bold', fontFamily: MONO }}>↗</Box> {t.history.proofNote.clickToVerifyRest}
      </Alert>

      {/* Tabs */}
      <Tabs
        value={tab}
        onChange={(_, val) => { setTab(val); setFilterKey('all') }}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab
          value="mine"
          label={wallet.isConnected ? t.history.tab.mine : t.history.tab.mineDisconnected}
          sx={{ textTransform: 'none' }}
        />
        <Tab
          value="all"
          label={t.history.tab.all}
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
                  ? interpolate(t.history.filter.countedLabel, { label: f.label, count: visible.length })
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
          <Typography color="text.secondary">{t.history.noWallet}</Typography>
        </Card>
      )}

      {/* Events table */}
      {(tab === 'all' || wallet.isConnected) && (
        <Card>
          {/* Cached rows stay on screen while refreshing — only a cold load blanks out. */}
          {loading && events.length === 0 ? (
            <TableSkeleton rows={5} cols={6} />
          ) : visible.length === 0 && error ? (
            // 讀取失敗（或不完整）時的空白不是「沒有活動」——不能套用空狀態文案。
            <EmptyState
              icon="⚠️"
              title={t.history.readFailed.title}
              description={t.history.readFailed.description}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon="📜"
              title={t.history.empty.title}
              description={
                filterKey !== 'all'
                  ? interpolate(t.history.empty.windowFiltered, {
                      blocks: FETCH_BLOCKS.toLocaleString(),
                      filter: filterKey,
                    })
                  : interpolate(t.history.empty.windowOnly, { blocks: FETCH_BLOCKS.toLocaleString() })
              }
            />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    {[
                      t.history.column.time,
                      t.history.column.type,
                      t.history.column.user,
                      t.history.column.details,
                      t.history.column.block,
                      t.history.column.tx,
                    ].map(h => (
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
                        <Tooltip title={e.type === 'Swap' ? t.history.legacySwapTooltip : ''}>
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
                        </Tooltip>
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
                          <Tooltip title={t.history.storageTooltip}>
                            <Typography variant="caption" sx={{ color: 'text.disabled', cursor: 'help' }}>
                              {t.history.storageLabel}
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
              ? t.history.loadOlder.scanning
              : interpolate(t.history.loadOlder.cta, {
                  from: Math.max(0, scannedFrom - FETCH_BLOCKS).toLocaleString(),
                  to: (scannedFrom - 1).toLocaleString(),
                })}
          </Button>
        </Box>
      )}

      {/* Footer note */}
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block', mt: 2 }}>
        {interpolate(
          visible.length === 1 ? t.history.footer.eventOne : t.history.footer.eventMany,
          { count: visible.length },
        )}{' '}
        ·{' '}
        {t.history.footer.positionsFull}
        {scannedFrom !== null &&
          ` ${interpolate(t.history.footer.scannedBackTo, { block: scannedFrom.toLocaleString() })}`}{' '}
        {t.history.footer.cacheNote}
      </Typography>
    </Container>
  )
}
