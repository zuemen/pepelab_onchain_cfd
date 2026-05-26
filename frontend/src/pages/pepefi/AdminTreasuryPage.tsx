import { useState, useEffect, useCallback } from 'react'
import { parseEther, formatEther, formatUnits } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import EmptyState from 'src/components/pepefi/EmptyState'
import StatCard from 'src/components/pepefi/StatCard'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';

// ── Helpers ───────────────────────────────────────────────────────────────────
type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

const f18 = (v: bigint, d = 2) =>
  Number(formatUnits(v, 18)).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
const fEth = (v: bigint) => parseFloat(formatEther(v)).toFixed(6)

const DEMO_OWNER = '0xE80A81360608C1342e66743F70a00f75d792Eb93'

// ── Types ─────────────────────────────────────────────────────────────────────
interface RevenueStats {
  platformEarnings: bigint
  myMusdc:          bigint
  myEth:            bigint
  routerEth:        bigint
}

interface CashOutRecord {
  type:       'claim' | 'swap'
  amount:     bigint
  usdcIn?:    bigint
  txHash:     string
  blockNumber: number
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminTreasuryPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [stats,           setStats]           = useState<RevenueStats | null>(null)
  const [platformTreasury, setPlatformTreasury] = useState<string | null>(null)
  const [swapAmt,         setSwapAmt]         = useState('')
  const [fundAmt,         setFundAmt]         = useState('')
  const [history,         setHistory]         = useState<CashOutRecord[]>([])
  const [busy,            setBusy]            = useState<Record<string, boolean>>({})
  const [toast,           setToast]           = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const isOwner = wallet.address?.toLowerCase() === DEMO_OWNER.toLowerCase()

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // ── Fetch stats ───────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      const [pending, myMusdc, myEth, treasury] = await Promise.all([
        contracts.feeRouter.platformEarnings(),
        contracts.usdc.balanceOf(wallet.address),
        wallet.provider.getBalance(wallet.address),
        contracts.feeRouter.platformTreasury(),
      ])
      let routerEth = 0n
      try { routerEth = await contracts.swapRouter.ethReserve() as bigint }
      catch { /* swapRouter not deployed on this chain */ }
      setStats({
        platformEarnings: pending as bigint,
        myMusdc:          myMusdc as bigint,
        myEth:            myEth as bigint,
        routerEth,
      })
      setPlatformTreasury(treasury as string)
    } catch (e) {
      console.error('[treasury fetch]', e)
    }
  }, [contracts, wallet.address, wallet.provider])

  // ── Fetch history ─────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      const current   = await wallet.provider.getBlockNumber()
      const fromBlock = Math.max(0, current - 10000)

      const [claimLogs, swapLogs] = await Promise.all([
        contracts.feeRouter.queryFilter(
          contracts.feeRouter.filters.PlatformFeesWithdrawn(wallet.address),
          fromBlock, 'latest',
        ),
        contracts.swapRouter.queryFilter(
          contracts.swapRouter.filters.SwapUsdcToEth(wallet.address),
          fromBlock, 'latest',
        ),
      ])

      const records: CashOutRecord[] = []
      for (const log of claimLogs) {
        const args = (log as any).args
        records.push({
          type:        'claim',
          amount:      (args.amount ?? args[1] ?? 0n) as bigint,
          txHash:      log.transactionHash,
          blockNumber: log.blockNumber,
        })
      }
      for (const log of swapLogs) {
        const args = (log as any).args
        records.push({
          type:        'swap',
          amount:      (args.ethOut ?? args[2] ?? 0n) as bigint,
          usdcIn:      (args.usdcIn ?? args[1] ?? 0n) as bigint,
          txHash:      log.transactionHash,
          blockNumber: log.blockNumber,
        })
      }
      records.sort((a, b) => b.blockNumber - a.blockNumber)
      setHistory(records)
    } catch (e) {
      console.error('[history fetch]', e)
    }
  }, [contracts, wallet.address, wallet.provider])

  useEffect(() => {
    void fetchStats()
    void fetchHistory()
    const t = setInterval(() => { void fetchStats() }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, fetchHistory])

  // ── Actions ───────────────────────────────────────────────────────────────
  const doClaim = async () => {
    if (!contracts) return
    setLoad('claim', true)
    try {
      const tx = asTx(await contracts.feeRouter.withdrawPlatformFees())
      await tx.wait()
      notify('Platform fees claimed ✓', true, tx.hash)
      await fetchStats()
      await fetchHistory()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('claim', false) }
  }

  const doApprove = async () => {
    if (!contracts || !swapAmt) return
    setLoad('approve', true)
    try {
      const amt = parseEther(swapAmt)
      const tx  = asTx(await contracts.usdc.approve(String(contracts.swapRouter.target), amt))
      await tx.wait()
      notify('mUSDC approved ✓', true, tx.hash)
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const doSwapToEth = async () => {
    if (!contracts || !swapAmt) return
    setLoad('swap', true)
    try {
      const amt    = parseEther(swapAmt)
      const tx     = asTx(await contracts.swapRouter.swapUSDCForETH(amt))
      await tx.wait()
      const ethOut = (parseFloat(swapAmt) / 3000).toFixed(6)
      notify(`Swapped ${swapAmt} mUSDC → ${ethOut} ETH ✓`, true, tx.hash)
      setSwapAmt('')
      await fetchStats()
      await fetchHistory()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('swap', false) }
  }

  const doFundRouter = async () => {
    if (!contracts || !fundAmt) return
    setLoad('fund', true)
    try {
      const tx = asTx(await contracts.swapRouter.fundRouter({ value: parseEther(fundAmt) }))
      await tx.wait()
      notify(`Funded router with ${fundAmt} ETH ✓`, true, tx.hash)
      setFundAmt('')
      await fetchStats()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('fund', false) }
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to access Treasury Admin.</Typography>
      </Box>
    )
  }

  if (!isOwner) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <Typography variant="h2">🔒</Typography>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>Not authorized</Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>This page is restricted to the platform owner wallet.</Typography>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.disabled' }}>
          Owner: {DEMO_OWNER.slice(0, 10)}…{DEMO_OWNER.slice(-6)}
        </Typography>
      </Box>
    )
  }

  const ethNeeded = (() => {
    try { return swapAmt ? parseEther((parseFloat(swapAmt) / 3000).toFixed(18)) : 0n }
    catch { return 0n }
  })()
  const routerInsufficient = ethNeeded > 0n && !!stats && stats.routerEth < ethNeeded

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Snackbar notification */}
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {toast ? (
          <Alert
            severity={toast.ok ? 'success' : 'error'}
            onClose={() => setToast(null)}
            sx={{ width: '100%' }}
          >
            {toast.msg}
            {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
              <Link
                href={explorerTx(toast.hash, wallet.chainId)!}
                target="_blank"
                rel="noopener noreferrer"
                color="inherit"
                sx={{ display: 'block', mt: 0.5, typography: 'caption', textDecoration: 'underline' }}
              >
                View on Etherscan ↗
              </Link>
            )}
          </Alert>
        ) : undefined}
      </Snackbar>

      {/* Header */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
          Treasury Admin
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Cash out accumulated platform fees → ETH
        </Typography>
      </Box>

      {/* A. Revenue Stats */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Pending Platform Fees" value={stats ? f18(stats.platformEarnings) : '—'} sub="mUSDC" valueColor="primary.main" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Wallet mUSDC Balance" value={stats ? f18(stats.myMusdc) : '—'} sub="mUSDC" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Wallet ETH Balance" value={stats ? fEth(stats.myEth) : '—'} sub="ETH" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Router ETH Reserve" value={stats ? fEth(stats.routerEth) : '—'} sub="ETH" />
        </Grid>
      </Grid>

      {/* B. Step 1: Claim */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Chip label="1" size="small" color="primary" sx={{ fontWeight: 'bold' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            Claim Platform Fees from FeeRouter
          </Typography>
        </Box>

        {platformTreasury && (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            Treasury: {platformTreasury}
          </Typography>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Pending platform fees
            </Typography>
            <Typography variant="h4" color="primary.main" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
              {stats ? f18(stats.platformEarnings) : '—'} <Box component="span" sx={{ fontSize: '1rem', fontWeight: 'normal', color: 'text.secondary' }}>mUSDC</Box>
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => void doClaim()}
            disabled={busy['claim'] || !stats || stats.platformEarnings === 0n}
          >
            {busy['claim'] ? 'Claiming…' : 'Claim Platform Fees'}
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary">
          This transfers all accumulated platform-share fees (20% of each copy / performance fee) to your wallet.
        </Typography>
      </Card>

      {/* C. Step 2: Convert mUSDC → ETH */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Chip label="2" size="small" color="primary" sx={{ fontWeight: 'bold' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            Convert mUSDC → ETH via SwapRouter
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder="mUSDC amount"
            value={swapAmt}
            onChange={e => setSwapAmt(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: 'monospace' } } }}
            sx={{ flexGrow: 1, minWidth: 200 }}
          />
          <Button
            variant="outlined"
            onClick={() => stats && setSwapAmt(formatUnits(stats.myMusdc, 18))}
            disabled={!stats || stats.myMusdc === 0n}
          >
            Max
          </Button>
        </Box>

        {swapAmt && parseFloat(swapAmt) > 0 && (
          <Typography variant="caption" color="text.secondary">
            ≈ {(parseFloat(swapAmt) / 3000).toFixed(6)} ETH (rate: 1 ETH = 3000 mUSDC)
          </Typography>
        )}

        {routerInsufficient && (
          <Alert severity="warning">
            Router only has {stats ? fEth(stats.routerEth) : '0'} ETH available.
            Fund it using the Treasury Tools below before swapping.
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant="outlined"
            onClick={() => void doApprove()}
            disabled={busy['approve'] || !swapAmt || parseFloat(swapAmt) <= 0}
            sx={{ flexGrow: 1 }}
          >
            {busy['approve'] ? 'Approving…' : '① Approve mUSDC'}
          </Button>
          <Button
            variant="contained"
            color="success"
            onClick={() => void doSwapToEth()}
            disabled={busy['swap'] || !swapAmt || parseFloat(swapAmt) <= 0}
            sx={{ flexGrow: 1 }}
          >
            {busy['swap'] ? 'Swapping…' : '② Swap to ETH'}
          </Button>
        </Box>
      </Card>

      {/* E. Treasury Tools */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Treasury Tools
        </Typography>

        <Box>
          <Typography variant="body2" sx={{ fontWeight: 'semibold', mb: 0.5 }}>
            Fund SwapRouter with ETH
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            The router needs an ETH reserve to fulfill mUSDC→ETH swaps from users and admin.
            Current reserve: <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{stats ? fEth(stats.routerEth) : '—'} ETH</Box>
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              type="number"
              size="small"
              placeholder="ETH amount (e.g. 1)"
              value={fundAmt}
              onChange={e => setFundAmt(e.target.value)}
              slotProps={{ htmlInput: { min: "0", step: "0.01", style: { fontFamily: 'monospace' } } }}
              sx={{ width: 200 }}
            />
            <Button
              variant="contained"
              onClick={() => void doFundRouter()}
              disabled={busy['fund'] || !fundAmt || parseFloat(fundAmt) <= 0}
            >
              {busy['fund'] ? 'Funding…' : 'Fund Router'}
            </Button>
          </Box>
        </Box>
      </Card>

      {/* D. Cash Out History */}
      <Card>
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            Recent Cash Out History
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchHistory()}
            sx={{ textTransform: 'none' }}
          >
            ↺ Refresh
          </Button>
        </Box>

        {history.length === 0 ? (
          <EmptyState icon="📋" title="No cash out history yet" description="Fee claims and USDC→ETH swaps will appear here." />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableBody>
                {history.slice(0, 20).map((r, i) => (
                  <TableRow key={i} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                        <Chip
                          label={r.type === 'claim' ? 'Claimed' : 'Swapped'}
                          size="small"
                          color={r.type === 'claim' ? 'primary' : 'success'}
                          sx={{ fontWeight: 'bold' }}
                        />
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                          {r.type === 'claim'
                            ? `${f18(r.amount)} mUSDC`
                            : `${r.usdcIn ? f18(r.usdcIn) : '—'} mUSDC → ${fEth(r.amount)} ETH`}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                      #{r.blockNumber}
                    </TableCell>
                    <TableCell align="right">
                      {explorerTx(r.txHash, wallet.chainId) && (
                        <Link
                          href={explorerTx(r.txHash, wallet.chainId)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          color="success.main"
                          sx={{ fontWeight: 'bold', fontSize: '1.1rem', textDecoration: 'none' }}
                        >
                          ↗
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Info */}
      <Card sx={{ p: 2.5, bgcolor: 'background.neutral' }}>
        <Stack spacing={1} sx={{ typography: 'caption', color: 'text.secondary' }}>
          <Typography variant="caption">
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold' }}>Revenue model:</Box> Each copy-trade or performance fee is split 70% trader / 20% platform / 10% insurance vault. Platform fees accumulate in FeeRouter until this admin claims them.
          </Typography>
          <Typography variant="caption">
            After claiming mUSDC, use the swap above to convert to ETH at the mock rate (1 ETH = 3000 mUSDC). In production, you'd use a real DEX.
          </Typography>
        </Stack>
      </Card>
    </Container>
  )
}
