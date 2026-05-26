import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'

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
      return d.direction === 'ETH→USDC'
        ? <span><Typography variant="body2" component="span" color="text.secondary">{fEth(d.ethIn as bigint)} ETH</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{f18(d.usdcOut as bigint)} mUSDC</Typography></span>
        : <span><Typography variant="body2" component="span" color="text.secondary">{f18(d.usdcIn as bigint)} mUSDC</Typography> → <Typography variant="body2" component="span" color="success.main" sx={{ fontWeight: 'semibold' }}>{fEth(d.ethOut as bigint)} ETH</Typography></span>

    case 'PositionOpened': {
      const label   = ASSET_LABEL[d.asset as string] ?? '?'
      const side    = (d.isLong as boolean) ? 'LONG' : 'SHORT'
      const sideCol = (d.isLong as boolean) ? 'success.main' : 'error.main'
      return <span><Box component="span" sx={{ fontWeight: 'bold', color: sideCol }}>{side}</Box> {label} {String(d.leverage as bigint)}× @ {f8(d.entryPrice as bigint)} | Margin: {f18(d.margin as bigint)} mUSDC</span>
    }

    case 'PositionClosed': {
      const pnl    = d.pnl as bigint
      const pnlStr = (pnl >= 0n ? '+' : '') + f18(pnl)
      const col    = pnl >= 0n ? 'success.main' : 'error.main'
      return <span>PnL: <Box component="span" sx={{ fontWeight: 'bold', color: col }}>{pnlStr}</Box> mUSDC | Received: {f18(d.closeAmount as bigint)}</span>
    }

    case 'MarginDeposited':
      return <Box component="span" sx={{ color: 'success.main', fontWeight: 'semibold' }}>+{f18(d.amount as bigint)} mUSDC</Box>

    case 'MarginWithdrawn':
      return <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>−{f18(d.amount as bigint)} mUSDC</Box>

    case 'TraderFollowed': {
      const trader = d.trader as string
      return <span>Following <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>{shortAddr(trader)}</Box> | Margin: {f18(d.totalMargin as bigint)} mUSDC</span>
    }

    case 'TraderUnfollowed': {
      const trader = d.trader as string
      return <span>Unfollowed <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>{shortAddr(trader)}</Box></span>
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
      return <span>Slashed <Box component="span" sx={{ color: 'error.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> mUSDC → <Box component="span" sx={{ fontFamily: 'monospace' }}>{shortAddr(recipient)}</Box></span>
    }

    default:
      return <Typography variant="caption" color="text.secondary">{JSON.stringify(d).slice(0, 80)}</Typography>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const wallet = usePepefiWallet()
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
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'between', flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            Transaction History
          </Typography>
          <Typography variant="body2" color="text.secondary">
            On-chain auditability — decoded directly from Sepolia via ethers.js
          </Typography>
        </Box>
        <Button
          variant="text"
          onClick={() => void fetchEvents()}
          disabled={loading}
          sx={{ textTransform: 'none' }}
        >
          {loading ? 'Loading…' : '↺ Refresh'}
        </Button>
      </Box>

      {/* Proof-of-transparency note */}
      <Alert severity="info" sx={{ bgcolor: 'rgba(0, 184, 217, 0.08)', color: 'info.lighter', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        All activity is read directly from the Sepolia blockchain — no backend, no database, just the immutable ledger.{' '}
        <Box component="span" sx={{ fontWeight: 'bold', color: 'text.primary' }}>Every row below is a real on-chain event.</Box>{' '}
        Click <Box component="span" sx={{ color: 'success.main', fontWeight: 'bold', fontFamily: 'monospace' }}>↗</Box> to verify on Sepolia Etherscan.
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
          {loading ? (
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
                  {visible.map((e, i) => (
                    <TableRow key={i} hover>
                      <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary', whitespace: 'nowrap' }}>
                        {fTime(e.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={TYPE_LABEL[e.type] ?? e.type}
                          size="small"
                          sx={{
                            fontWeight: 'bold',
                            ...TYPE_STYLE[e.type]
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                        {shortAddr(e.user)}
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.75rem', color: 'text.primary' }}>
                        {renderDetails(e)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                        #{e.blockNumber}
                      </TableCell>
                      <TableCell>
                        {explorerTx(e.txHash, wallet.chainId) ? (
                          <Link
                            href={explorerTx(e.txHash, wallet.chainId)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            color="success.main"
                            sx={{ fontWeight: 'bold', fontSize: '1.1rem', textDecoration: 'none' }}
                          >
                            ↗
                          </Link>
                        ) : (
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                            {e.txHash.slice(0, 8)}…
                          </Typography>
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

      {/* Footer note */}
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block', mt: 2 }}>
        Showing events from last ~{FETCH_BLOCKS.toLocaleString()} blocks (~15 hours on Sepolia) ·{' '}
        {visible.length} event{visible.length !== 1 ? 's' : ''} displayed ·
        Older history: use Etherscan or queryFilter with a custom fromBlock
      </Typography>
    </Container>
  )
}
