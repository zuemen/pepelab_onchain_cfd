import { useState, useEffect, useCallback } from 'react'
import { useParams, Link as RouterLink } from 'react-router'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { TableSkeleton, CardSkeleton } from 'src/components/pepefi/Skeleton'
import { useESG } from 'src/hooks/useESG'
import ESGBadge from 'src/components/pepefi/ESGBadge'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import StatCard from 'src/components/pepefi/StatCard'
import { getPepeAvatar } from 'src/utils/pepefi-assets'
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

interface RawAlloc {
  asset: string; weight: bigint; isLong: boolean; leverage: bigint
}

interface HistVer {
  versionId: number
  createdAt: bigint
  allocs:    RawAlloc[]
  expanded:  boolean
}

interface SlashEvent {
  trader:    string
  amount:    bigint
  recipient: string
  txHash:    string
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const fmtDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })

export default function TraderProfilePage() {
  const wallet = usePepefiWallet()
  const { address: traderAddr } = useParams<{ address: string }>()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint>(0n)
  const [followerList,  setFollowerList]  = useState<string[]>([])
  const [allocs,        setAllocs]        = useState<RawAlloc[]>([])
  const [hasStrategy,   setHasStrategy]   = useState(false)
  const [stratHistory,  setStratHistory]  = useState<HistVer[]>([])
  const [stakeInfo,     setStakeInfo]     = useState<StakeInfo | null>(null)
  const [repScore,      setRepScore]      = useState<bigint | null>(null)
  const [eligible,      setEligible]      = useState<boolean | null>(null)
  const [earnings,      setEarnings]      = useState<bigint | null>(null)
  const [stratCount,    setStratCount]    = useState<number | null>(null)
  const [slashHistory,  setSlashHistory]  = useState<SlashEvent[]>([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  const toggleVer = useCallback((versionId: number) => {
    setStratHistory(prev =>
      prev.map(v => v.versionId === versionId ? { ...v, expanded: !v.expanded } : v),
    )
  }, [])

  useEffect(() => {
    if (!contracts || !traderAddr) return
    setLoading(true)
    setError(null)
    const go = async () => {
      let traderRaw: [boolean, string, bigint] | null = null
      try {
        traderRaw = (await contracts.registry.traders(traderAddr)) as unknown as [boolean, string, bigint]
      } catch { traderRaw = null }
      if (traderRaw) {
        setName(traderRaw[1])
        setRegistered(traderRaw[0])
      }
      try {
        const fc = await contracts.copyTracker.getFollowerCount(traderAddr)
        setFollowers(fc as bigint)
      } catch { /* no follower data */ }

      // followersByTrader (first 10)
      try {
        const list: string[] = []
        for (let i = 0; i < 10; i++) {
          try {
            const addr = await contracts.copyTracker.followersByTrader(traderAddr, BigInt(i))
            list.push(addr as string)
          } catch { break }
        }
        setFollowerList(list)
      } catch { /* no followers */ }

      // strategy + history
      let count = 0
      try {
        count = Number((await contracts.registry.getStrategyCount(traderAddr)) as bigint)
      } catch { count = 0 }
      setStratCount(count)
      if (count > 0) {
        try {
          const vers = await Promise.all(
            Array.from({ length: count }, (_, i) => i).map(async (i): Promise<HistVer> => {
              const res = (await contracts.registry.getStrategyVersion(traderAddr, BigInt(i))) as unknown as [unknown[], bigint]
              return {
                versionId: i,
                createdAt: res[1],
                allocs:    (res[0] as unknown[]).map(a => {
                  const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
                  return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
                }),
                expanded: false,
              }
            }),
          )
          const sorted = [...vers].reverse()
          setStratHistory(sorted)
          setAllocs(sorted[0]?.allocs ?? [])
          setHasStrategy(sorted[0]?.allocs.length > 0)
        } catch { setHasStrategy(false) }
      } else {
        setHasStrategy(false)
      }

      // stake + reputation
      try {
        const [si, score, elig] = await Promise.all([
          contracts.traderStake.getStake(traderAddr),
          contracts.traderStake.reputationScore(traderAddr),
          contracts.traderStake.isEligible(traderAddr),
        ])
        setStakeInfo(si as unknown as StakeInfo)
        setRepScore(score as bigint)
        setEligible(elig as boolean)
      } catch { /* TraderStake not deployed */ }

      // fee earnings
      try {
        const raw = (await contracts.feeRouter.traderEarnings(traderAddr)) as bigint
        setEarnings(raw)
      } catch { /* FeeRouter not deployed */ }

      // slash history from Slashed events
      try {
        const filter = contracts.traderStake.filters['Slashed'](traderAddr, null)
        const events = await contracts.traderStake.queryFilter(filter, -10000)
        setSlashHistory(events.map((e: unknown) => {
          const ev = e as { args: { trader: string; amount: bigint; recipient: string }; transactionHash: string }
          return {
            trader:    ev.args.trader,
            amount:    ev.args.amount,
            recipient: ev.args.recipient,
            txHash:    ev.transactionHash,
          }
        }))
      } catch { /* events not available */ }

      setLoading(false)
    }
    void go()
  }, [contracts, traderAddr])

  if (!traderAddr) return <Box sx={{ p: 4 }}><Typography color="text.secondary">Invalid address.</Typography></Box>

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to view trader profiles.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Breadcrumbs */}
      <Breadcrumbs separator="/" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/marketplace" color="inherit" underline="hover" sx={{ fontSize: '0.875rem' }}>
          Marketplace
        </Link>
        <Typography variant="body2" color="text.primary">
          {name || shortAddr(traderAddr)}
        </Typography>
      </Breadcrumbs>

      {error && (
        <Alert severity="error">
          {error}
        </Alert>
      )}

      {loading ? (
        <Stack spacing={3}>
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </Stack>
      ) : (
        <>
          {/* ─── A. Header ────────────────────────────────────────── */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Stack direction="row" spacing={3} alignItems="center">
              <Avatar
                src={getPepeAvatar(repScore, traderAddr)}
                sx={{
                  width: 80,
                  height: 80,
                  border: '3px solid',
                  borderColor: repScore && repScore >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
                  boxShadow: '0 0 16px rgba(0,0,0,0.5)',
                }}
              />
              <Box sx={{ flexGrow: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
                  <Box>
                    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                      <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                        {name || 'Unknown'}
                      </Typography>
                      <TraderRankBadge reputation={repScore} />
                    </Stack>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: 'block', mt: 0.5 }}>
                      {traderAddr}
                    </Typography>
                  </Box>
                  {repScore !== null && (
                    <Chip
                      label={`◆ ${String(repScore)} rep`}
                      size="small"
                      sx={{
                        fontWeight: 'bold',
                        ...(repScore >= 80n ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                          : repScore >= 50n ? { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' }
                          : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                        )
                      }}
                    />
                  )}
                </Box>

                <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1, mt: 1.5, alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    <Box component="span" sx={{ fontWeight: 'bold', color: 'text.primary' }}>{String(followers)}</Box> follower{followers !== 1n ? 's' : ''}
                  </Typography>
                  {registered && (
                    <Chip
                      label="Registered"
                      color="success"
                      variant="outlined"
                      size="small"
                      sx={{ fontWeight: 'bold' }}
                    />
                  )}
                  {eligible !== null && (
                    <Chip
                      label={eligible ? '◆ Staked' : '✗ Not staked'}
                      color={eligible ? 'primary' : 'error'}
                      variant="outlined"
                      size="small"
                      sx={{ fontWeight: 'bold' }}
                    />
                  )}
                </Stack>
              </Box>
            </Stack>

            <Button
              component={RouterLink}
              to={`/copy/${traderAddr}`}
              variant="contained"
              color="primary"
              fullWidth
              disabled={!hasStrategy}
              sx={{ fontWeight: 'bold', py: 1.2 }}
            >
              {!hasStrategy ? 'No Strategy to Copy 🔒' : 'Copy This Trader →'}
            </Button>
          </Card>

          {/* ─── B. Stats grid (4 cards) ──────────────────────────── */}
          <Grid container spacing={2}>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard title="Staked" value={stakeInfo ? f18(stakeInfo.amount) : '—'} sub="mUSDC" />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard title="Followers" value={String(followers)} sub="copiers" />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard title="Earnings" value={earnings !== null ? f18(earnings, 4) : '—'} sub="mUSDC" valueColor="success.main" />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <StatCard title="Strategies" value={stratCount !== null ? String(stratCount) : '—'} sub="versions" />
            </Grid>
          </Grid>

          {/* ─── C. Latest Strategy ────────────────────────────────── */}
          <Card sx={{ p: 3 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
              Latest Strategy
            </Typography>
            {!hasStrategy ? (
              <Typography color="text.secondary">No strategy published yet.</Typography>
            ) : (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {allocs.map((a, i) => (
                  <Chip
                    key={i}
                    label={`${a.isLong ? '↑' : '↓'} ${ASSET_LABEL[a.asset] ?? '?'} ${(Number(a.weight) / 100).toFixed(0)}% · ${String(a.leverage)}×`}
                    size="small"
                    sx={{
                      fontWeight: 'bold',
                      ...(a.isLong
                        ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                        : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                      )
                    }}
                  />
                ))}
              </Stack>
            )}
          </Card>

          {/* ─── D. Strategy History ───────────────────────────────── */}
          {stratHistory.length > 0 && (
            <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                Strategy History <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>({stratHistory.length} version{stratHistory.length !== 1 ? 's' : ''})</Box>
              </Typography>
              <Stack spacing={1.5}>
                {stratHistory.map(ver => (
                  <Card key={ver.versionId} sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
                    <Box
                      component="button"
                      onClick={() => toggleVer(ver.versionId)}
                      sx={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        px: 2,
                        py: 1.5,
                        bgcolor: 'transparent',
                        border: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        '&:hover': { bgcolor: 'action.hover' }
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flexGrow: 1 }}>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          v{ver.versionId}
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 'bold', color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ver.allocs.map(a =>
                            `${ASSET_LABEL[a.asset] ?? '?'} ${a.isLong ? 'L' : 'S'} ${String(a.leverage)}×`,
                          ).join(' · ')}
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 2, shrink: 0 }}>
                        <Typography variant="caption" color="text.secondary">
                          {fmtDate(ver.createdAt)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {ver.expanded ? '▲' : '▼'}
                        </Typography>
                      </Box>
                    </Box>
                    {ver.expanded && (
                      <Box sx={{ borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.neutral', px: 2, py: 1.5 }}>
                        <TableContainer>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                {['Asset', 'ESG', 'Side', 'Lev', 'Weight'].map(h => (
                                  <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                                ))}
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {ver.allocs.map((a, idx) => (
                                <TableRow key={idx}>
                                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>
                                    {ASSET_LABEL[a.asset] ?? '?'}
                                  </TableCell>
                                  <TableCell>
                                    {esg[a.asset] ? (
                                      <ESGBadge composite={esg[a.asset].composite} rating={esg[a.asset].rating} />
                                    ) : (
                                      <Typography variant="caption" color="text.disabled">—</Typography>
                                    )}
                                  </TableCell>
                                  <TableCell sx={{ fontWeight: 'bold', color: a.isLong ? 'success.main' : 'error.main' }}>
                                    {a.isLong ? 'Long ↑' : 'Short ↓'}
                                  </TableCell>
                                  <TableCell sx={{ fontFamily: 'monospace' }}>{String(a.leverage)}×</TableCell>
                                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>
                                    {(Number(a.weight) / 100).toFixed(0)}%
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </Box>
                    )}
                  </Card>
                ))}
              </Stack>
            </Card>
          )}

          {/* ─── D. Followers ──────────────────────────────────────── */}
          {followerList.length > 0 && (
            <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                Followers <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>(first {followerList.length})</Box>
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableBody>
                    {followerList.map((addr, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                          {shortAddr(addr)}
                        </TableCell>
                        <TableCell align="right" sx={{ color: 'text.secondary' }}>
                          #{i + 1}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}

          {/* ─── E. Slash History ──────────────────────────────────── */}
          {slashHistory.length > 0 && (
            <Card sx={{ p: 3, border: '1px solid', borderColor: 'error.main', bgcolor: 'rgba(255, 86, 48, 0.08)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="subtitle1" color="error.main" sx={{ fontWeight: 'bold' }}>
                Slash History <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>({slashHistory.length} event{slashHistory.length !== 1 ? 's' : ''})</Box>
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableBody>
                    {slashHistory.map((ev, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Typography variant="body2" color="error.main" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                            −{f18(ev.amount)} mUSDC
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            → {shortAddr(ev.recipient)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          {wallet.chainId === 11155111 && (
                            <Link
                              href={`https://sepolia.etherscan.io/tx/${ev.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              color="info.main"
                              sx={{ fontSize: '0.875rem', textDecoration: 'underline' }}
                            >
                              Etherscan ↗
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}

          {/* Actions */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              component={RouterLink}
              to="/marketplace"
              variant="outlined"
              color="inherit"
              sx={{ textTransform: 'none' }}
            >
              ← Back to Marketplace
            </Button>
          </Box>
        </>
      )}
    </Container>
  )
}
