import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'
import type { Contract } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { useMode } from 'src/contexts/mode-context'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx, explorerAddr, explorerName } from 'src/lib/pepefi/notify'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { pepeNameFor } from 'src/lib/pepefi/pepeName'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import StatCard from 'src/components/pepefi/StatCard'
import { PepeIdentity } from 'src/components/pepefi/PepeIdentity'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';

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
const pnlColor = (v: bigint) => Number(v) >= 0 ? 'success.main' : 'error.main'

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
function whaleTier(volumeWei: bigint): { icon: string; label: string; style: any } {
  const v = Number(volumeWei) / 1e18
  if (v >= 50_000) return { icon: '🐋', label: 'Mega Whale',  style: { bgcolor: 'rgba(0, 184, 217, 0.16)', color: '#00b8d9', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.24)' } }
  if (v >= 10_000) return { icon: '🐬', label: 'Whale',       style: { bgcolor: 'rgba(142, 51, 255, 0.16)', color: '#8e33ff', border: '1px solid', borderColor: 'rgba(142, 51, 255, 0.24)' } }
  return              { icon: '🐟', label: 'Fish',        style: { bgcolor: 'rgba(145, 158, 171, 0.16)', color: '#919eab', border: '1px solid', borderColor: 'rgba(145, 158, 171, 0.24)' } }
}

// ── Event styling ─────────────────────────────────────────────────────────────
const KIND_STYLE: Record<EventKind, any> = {
  PositionOpened: { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' },
  PositionClosed: { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  Following:      { bgcolor: 'rgba(142, 51, 255, 0.16)', color: '#8e33ff', border: '1px solid', borderColor: 'rgba(142, 51, 255, 0.24)' },
  FollowedBy:     { bgcolor: 'rgba(0, 184, 217, 0.16)', color: '#00b8d9', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.24)' },
  Staked:         { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' },
  Slashed:        { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' },
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
      const col   = (d.isLong as boolean) ? 'success.main' : 'error.main'
      return (
        <span>
          <Box component="span" sx={{ fontWeight: 'bold', color: col }}>{side}</Box>{' '}
          {label} {String(d.leverage as bigint)}× @ {fUsd(d.entryPrice as bigint)}{' '}
          | Margin: <Box component="span" sx={{ color: 'text.primary', fontWeight: 'semibold' }}>{f18(d.margin as bigint)}</Box> USDT
        </span>
      )
    }
    case 'PositionClosed': {
      const pnl = d.pnl as bigint
      return (
        <span>
          PnL:{' '}
          <Box component="span" sx={{ fontWeight: 'bold', color: pnlColor(pnl) }}>
            {(pnl >= 0n ? '+' : '') + f18(pnl)}
          </Box>{' '}
          USDT | Received: {f18(d.closeAmount as bigint)}
        </span>
      )
    }
    case 'Following':
      return <span>Following <Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(d.trader as string)}</Box> | Margin: {f18(d.totalMargin as bigint)} USDT</span>
    case 'FollowedBy':
      return <span><Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(d.follower as string)}</Box> copied this trader | Margin: {f18(d.totalMargin as bigint)} USDT</span>
    case 'Staked':
      return <span>Staked <Box component="span" sx={{ color: 'warning.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> USDT</span>
    case 'Slashed':
      return <span>Slashed <Box component="span" sx={{ color: 'error.main', fontWeight: 'semibold' }}>{f18(d.amount as bigint)}</Box> USDT → <Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(d.recipient as string)}</Box></span>
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function WhaleTrackerPage() {
  const { mode } = useMode()
  const wallet = usePepefiWallet()
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
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'between', flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
            🐋 Whale Tracker
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Global leaderboard · Per-address activity · On-chain position history
          </Typography>
        </Box>
        <Button
          variant="text"
          onClick={() => void fetchGlobal()}
          disabled={globalLoading}
          sx={{ textTransform: 'none' }}
        >
          ↺ Refresh
        </Button>
      </Box>

      {/* ── A. Global Overview ─────────────────────────────────────────────────── */}
      {!wallet.isConnected ? (
        <Card sx={{ p: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="text.secondary">Connect your wallet to view on-chain data.</Typography>
        </Card>
      ) : (
        <>
          {/* Global stat cards */}
          {globalLoading ? (
            <Grid container spacing={3}>
              {Array.from({ length: 3 }).map((_, i) => (
                <Grid size={{ xs: 12, md: 4 }} key={i}>
                  <Card sx={{ p: 4 }}>
                    <TableSkeleton rows={2} cols={1} />
                  </Card>
                </Grid>
              ))}
            </Grid>
          ) : globalStats ? (
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, md: 4 }}>
                <StatCard
                  title="Positions Opened"
                  value={String(globalStats.openedCount)}
                  sub="all-time (all traders)"
                />
              </Grid>
              <Grid size={{ xs: 12, md: 4 }}>
                <StatCard
                  title="Total Volume"
                  value={fUsd(globalStats.volume)}
                  sub="Σ margin × leverage"
                  valueColor={Number(globalStats.volume) / 1e18 >= 10_000 ? 'primary.main' : undefined}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 4 }}>
                <StatCard
                  title="Open Positions"
                  value={String(globalStats.openCount)}
                  sub="currently active"
                  valueColor={globalStats.openCount > 0 ? 'success.main' : undefined}
                />
              </Grid>
            </Grid>
          ) : (
            <Card sx={{ p: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Typography color="text.secondary">Loading global stats...</Typography>
            </Card>
          )}

          {/* ── B. Trader Leaderboard ─────────────────────────────────────────── */}
          {/* Simple mode: big Pepe cards for top 5 */}
          {mode === 'simple' && globalStats && globalStats.leaderboard.length > 0 && (
            <Box>
              <Typography variant="overline" sx={{ fontWeight: 'bold', color: 'text.secondary', display: 'block', mb: 2 }}>
                🐋 Top Whale Traders
              </Typography>
              <Grid container spacing={2}>
                {globalStats.leaderboard.slice(0, 5).map((t, i) => {
                  const tier = whaleTier(t.volume)
                  return (
                    <Grid key={t.address} size={{ xs: 12, sm: 6, md: 4 }}>
                      <Card sx={{ p: 3, textAlign: 'center', border: '1px solid', borderColor: 'rgba(124,193,74,0.2)', bgcolor: 'rgba(124,193,74,0.03)' }}>
                        <Box sx={{ fontSize: 48, mb: 1 }}>#{i + 1}</Box>
                        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
                          <PepeIdentity address={t.address} size={80} vertical />
                        </Box>
                        <Chip label={`${tier.icon} ${tier.label}`} size="small" sx={{ fontWeight: 'bold', mb: 1.5, ...tier.style }} />
                        <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 900 }}>{fUsd(t.volume)}</Typography>
                        <Typography variant="caption" color="text.secondary">累積交易量</Typography>
                        <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 'bold', mt: 1 }}>
                          {t.openCount > 0 ? `🟢 ${t.openCount} 個持倉` : '無持倉'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                          「{pepeNameFor(t.address)} 剛買了 {fUsd(t.volume)} 的倉位」
                        </Typography>
                      </Card>
                    </Grid>
                  )
                })}
              </Grid>
            </Box>
          )}

          {globalStats && globalStats.leaderboard.length > 0 && mode === 'expert' && (
            <Card>
              <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="overline" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
                  Trader Leaderboard
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {globalStats.leaderboard.length} traders
                </Typography>
              </Box>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow sx={{ bgcolor: 'background.neutral' }}>
                      {['Rank', 'Address', 'Tier', 'Total Volume', 'Positions', 'Open', ''].map(h => (
                        <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {globalStats.leaderboard.map((t, i) => {
                      const tier = whaleTier(t.volume)
                      return (
                        <TableRow key={t.address} hover>
                          <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                            #{i + 1}
                          </TableCell>
                          <TableCell>
                            <PepeIdentity address={t.address} size={36} />
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={`${tier.icon} ${tier.label}`}
                              size="small"
                              sx={{
                                fontWeight: 'bold',
                                ...tier.style
                              }}
                            />
                          </TableCell>
                          <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                            {fUsd(t.volume)}
                          </TableCell>
                          <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>{t.count}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>
                            <Box component="span" sx={{ color: t.openCount > 0 ? 'success.main' : 'text.disabled', fontWeight: 'bold' }}>
                              {t.openCount}
                            </Box>
                          </TableCell>
                          <TableCell align="right">
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => pickAddress(t.address)}
                              sx={{ textTransform: 'none' }}
                            >
                              View →
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}

          {/* ── C. Per-address search ──────────────────────────────────────────── */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Typography variant="overline" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
              Address Lookup
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5 }}>
              <TextField
                placeholder="0x… Ethereum address"
                value={inputAddr}
                onChange={e => setInputAddr(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                slotProps={{ htmlInput: { style: { fontFamily: MONO } } }}
                size="small"
                sx={{ flexGrow: 1 }}
              />
              <Button
                variant="contained"
                onClick={handleSearch}
                disabled={loading || !inputAddr.trim()}
              >
                {loading ? '…' : 'Search'}
              </Button>
            </Box>

            {/* Featured whale quick-select */}
            <Stack spacing={1}>
              <Typography variant="caption" sx={{ textTransform: 'uppercase', fontWeight: 'bold', color: 'text.secondary' }}>
                Featured Demo Whales
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {FEATURED_WHALES.map(w => (
                  <Chip
                    key={w.address}
                    label={w.label}
                    onClick={() => pickAddress(w.address)}
                    variant="outlined"
                    size="small"
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
                <Chip
                  label={MAINNET_DEMO.label}
                  onClick={() => pickAddress(MAINNET_DEMO.address, true)}
                  color="secondary"
                  variant="outlined"
                  size="small"
                  sx={{ cursor: 'pointer' }}
                  title="Mainnet address — for demo purposes only"
                />
              </Stack>
            </Stack>
          </Card>

          {/* Mainnet warning */}
          {isMainnetDemo && searchAddr && (
            <Alert severity="info">
              <Box component="span" sx={{ fontWeight: 'bold' }}>Mainnet address</Box> — PepeLab runs on Base Sepolia testnet.
              This address has no activity here. The search demonstrates the queryFilter capability for any address.
            </Alert>
          )}

          {/* Error */}
          {error && (
            <Alert severity="error">
              {error}
            </Alert>
          )}

          {/* ── D. Per-address results ─────────────────────────────────────────── */}
          {searchAddr && (
            <>
              {/* Address header + whale tier */}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mt: 1 }}>
                <Typography variant="subtitle1" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                  {searchAddr}
                </Typography>
                {explorerAddr(searchAddr, wallet.chainId) && (
                  <Link
                    href={explorerAddr(searchAddr, wallet.chainId)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="success.main"
                    sx={{ fontSize: '0.875rem', fontWeight: 'semibold', textDecoration: 'underline' }}
                  >
                    {explorerName(wallet.chainId)} ↗
                  </Link>
                )}
                {!loading && !isMainnetDemo && (
                  <Chip
                    label={`${tier.icon} ${tier.label}`}
                    size="small"
                    sx={{ fontWeight: 'bold', ...tier.style }}
                  />
                )}
              </Box>

              {/* Per-address stat cards */}
              {loading ? (
                <Grid container spacing={2}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Grid size={{ xs: 6, md: 3 }} key={i}>
                      <Card sx={{ p: 3 }}>
                        <TableSkeleton rows={2} cols={1} />
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              ) : (
                <Grid container spacing={2}>
                  <Grid size={{ xs: 6, md: 3 }}>
                    <StatCard title="Positions Opened" value={String(openedEvents.length)} sub="total lifetime" />
                  </Grid>
                  <Grid size={{ xs: 6, md: 3 }}>
                    <StatCard
                      title="Total Volume"
                      value={fUsd(totalVolume)}
                      sub="margin × leverage"
                      valueColor={Number(totalVolume) / 1e18 >= 10_000 ? 'primary.main' : undefined}
                    />
                  </Grid>
                  <Grid size={{ xs: 6, md: 3 }}>
                    <StatCard title="Open Positions" value={String(openPositions.length)} sub="currently active" />
                  </Grid>
                  <Grid size={{ xs: 6, md: 3 }}>
                    <StatCard
                      title="Win Rate"
                      value={winRate !== null ? `${winRate}%` : '—'}
                      sub={`${wins}/${closedEvents.length} closes`}
                      valueColor={winRate !== null && winRate >= 60 ? 'success.main' : undefined}
                    />
                  </Grid>
                </Grid>
              )}

              {/* Current Open Positions */}
              <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
                  Current Open Positions
                </Typography>
                {loading ? (
                  <TableSkeleton rows={3} cols={6} />
                ) : openPositions.length === 0 ? (
                  <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                    No open positions.
                  </Typography>
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          {['Asset', 'Side', 'Lev', 'Entry', 'Current', 'Margin', 'Notional', 'PnL'].map(h => (
                            <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                          ))}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {openPositions.map(row => {
                          const notional = row.margin * row.leverage
                          return (
                            <TableRow key={String(row.id)} hover>
                              <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                                {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
                              </TableCell>
                              <TableCell sx={{ fontWeight: 'bold', color: row.isLong ? 'success.main' : 'error.main' }}>
                                {row.isLong ? 'LONG ↑' : 'SHORT ↓'}
                              </TableCell>
                              <TableCell sx={{ fontFamily: MONO }}>{String(row.leverage)}×</TableCell>
                              <TableCell sx={{ fontFamily: MONO }}>{fUsd(row.entryPrice)}</TableCell>
                              <TableCell sx={{ fontFamily: MONO }}>
                                {row.currentPrice === 0n ? '—' : fUsd(row.currentPrice)}
                              </TableCell>
                              <TableCell sx={{ fontFamily: MONO }}>{f18(row.margin)}</TableCell>
                              <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>{f18(notional)}</TableCell>
                              <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: pnlColor(row.pnl) }}>
                                {(Number(row.pnl) >= 0 ? '+' : '') + f18(row.pnl, 4)}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Card>

              {/* Activity Timeline */}
              <Card>
                <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
                  <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
                    Activity Timeline
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    From deploy block #{DEPLOY_BLOCK.toLocaleString()}
                  </Typography>
                </Box>

                {loading ? (
                  <TableSkeleton rows={6} cols={5} />
                ) : activity.length === 0 ? (
                  <EmptyState
                    icon="📭"
                    title="No activity found"
                    description={
                      isMainnetDemo
                        ? 'This is a mainnet address — no PepeLab activity on Base Sepolia.'
                        : `No events found for ${shortAddr(searchAddr)} since block #${DEPLOY_BLOCK.toLocaleString()}.`
                    }
                  />
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: 'background.neutral' }}>
                          {['Time', 'Type', 'Details', 'Block', 'Tx'].map(h => (
                            <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                          ))}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {activity.map((e, i) => (
                          <TableRow key={i} hover>
                            <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary', whitespace: 'nowrap' }}>
                              {fTime(e.timestamp)}
                            </TableCell>
                            <TableCell>
                              <Chip
                                label={KIND_LABEL[e.kind]}
                                size="small"
                                sx={{ fontWeight: 'bold', ...KIND_STYLE[e.kind] }}
                              />
                            </TableCell>
                            <TableCell sx={{ fontSize: '0.75rem', color: 'text.primary' }}>
                              {renderDetail(e)}
                            </TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
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
                                  title={e.txHash}
                                >
                                  ↗
                                </Link>
                              ) : (
                                <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
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
            </>
          )}
        </>
      )}

      {/* Footer note */}
      {wallet.isConnected && !globalLoading && (
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block', mt: 2 }}>
          Data scanned from block #{DEPLOY_BLOCK.toLocaleString()} · {FETCH_BLOCKS.toLocaleString()} block window per chunk
        </Typography>
      )}
    </Container>
  )
}
