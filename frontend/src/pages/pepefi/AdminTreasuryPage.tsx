import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import type { EventLog } from 'ethers'
import { parseEther, formatEther, formatUnits } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { t, interpolate } from 'src/locales'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import EmptyState from 'src/components/pepefi/EmptyState'
import StatCard from 'src/components/pepefi/StatCard'
import { Iconify } from 'src/components/iconify'

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

/**
 * 只在鏈上 `feeRouter.platformTreasury()` 還沒讀回來之前拿來顯示的後備值。
 * **不再用它判斷授權**——寫死一個 EOA 等於把權限判斷跟鏈上狀態脫鉤：treasury
 * 一改，這頁就對真正的 owner 說「Not authorized」，同時對舊位址開門。
 * 這一頁本來就已經把 platformTreasury 抓回來了，只是沒拿來用。
 */
const FALLBACK_TREASURY_HINT = '0xE80A81360608C1342e66743F70a00f75d792Eb93'

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

  const [walletPepeBal,   setWalletPepeBal]   = useState<bigint | null>(null)
  const [contractPepeBal, setContractPepeBal] = useState<bigint | null>(null)
  const [pepeFundAmt,     setPepeFundAmt]     = useState('')

  // 授權以鏈上的 platformTreasury() 為準。還沒讀到（null）時不放行也不誤判，
  // 由下方的畫面顯示「確認中」。
  const isOwner =
    platformTreasury !== null &&
    wallet.address !== null &&
    wallet.address !== undefined &&
    platformTreasury.toLowerCase() === wallet.address.toLowerCase()
  const treasuryUnknown = platformTreasury === null

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
        const args = (log as EventLog).args
        records.push({
          type:        'claim',
          amount:      (args.amount ?? args[1] ?? 0n) as bigint,
          txHash:      log.transactionHash,
          blockNumber: log.blockNumber,
        })
      }
      for (const log of swapLogs) {
        const args = (log as EventLog).args
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

  // ── Fetch PEPE balances ────────────────────────────────────────────────────
  const fetchPepeBalances = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const [walletBal, contractBal] = await Promise.all([
        contracts.pepeToken.balanceOf(wallet.address),
        contracts.pepeToken.balanceOf(contracts.pepeIncentives.target),
      ])
      setWalletPepeBal(walletBal as bigint)
      setContractPepeBal(contractBal as bigint)
    } catch (e) {
      console.error('[pepe balance fetch]', e)
    }
  }, [contracts, wallet.address])

  useEffect(() => {
    void fetchStats()
    void fetchHistory()
    void fetchPepeBalances()
    const t = setInterval(() => {
      void fetchStats()
      void fetchPepeBalances()
    }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, fetchHistory, fetchPepeBalances])

  // ── Actions ───────────────────────────────────────────────────────────────
  const doClaim = async () => {
    if (!contracts) return
    setLoad('claim', true)
    try {
      const tx = asTx(await contracts.feeRouter.withdrawPlatformFees())
      await tx.wait()
      notify(t.admin.treasury.claim.done, true, tx.hash)
      await fetchStats()
      await fetchHistory()
    } catch (e) {
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
      notify(t.admin.treasury.swap.approved, true, tx.hash)
    } catch (e) {
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
      notify(interpolate(t.admin.treasury.swap.done, { amount: swapAmt, eth: ethOut }), true, tx.hash)
      setSwapAmt('')
      await fetchStats()
      await fetchHistory()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('swap', false) }
  }

  const doFundRouter = async () => {
    if (!contracts || !fundAmt) return
    setLoad('fund', true)
    try {
      const tx = asTx(await contracts.swapRouter.fundRouter({ value: parseEther(fundAmt) }))
      await tx.wait()
      notify(interpolate(t.admin.treasury.tools.done, { amount: fundAmt }), true, tx.hash)
      setFundAmt('')
      await fetchStats()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('fund', false) }
  }

  const doFundPepePool = async () => {
    if (!contracts || !pepeFundAmt) return
    setLoad('fundPepe', true)
    try {
      const parsedAmt = parseEther(pepeFundAmt)
      const tx = asTx(await contracts.pepeToken.transfer(String(contracts.pepeIncentives.target), parsedAmt))
      await tx.wait()
      notify(interpolate(t.admin.treasury.incentives.done, { amount: pepeFundAmt }), true, tx.hash)
      setPepeFundAmt('')
      await fetchPepeBalances()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('fundPepe', false) }
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.admin.treasury.connectWallet}</Typography>
      </Box>
    )
  }

  if (!isOwner) {
    const shown = platformTreasury ?? FALLBACK_TREASURY_HINT
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <Typography variant="h2">🔒</Typography>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
          {treasuryUnknown ? t.admin.treasury.checkingAuth : t.admin.treasury.notAuthorized}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {treasuryUnknown
            ? t.admin.treasury.checkingAuthBody
            : t.admin.treasury.notAuthorizedBody}
        </Typography>
        <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.disabled' }}>
          {treasuryUnknown
            ? t.admin.treasury.treasuryFallbackLabel
            : t.admin.treasury.treasuryOnChainLabel} {shown.slice(0, 10)}…{shown.slice(-6)}
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
                {t.admin.treasury.viewOnEtherscan}
              </Link>
            )}
          </Alert>
        ) : undefined}
      </Snackbar>

      {/* Header */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
          {t.admin.treasury.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t.admin.treasury.subtitle}
        </Typography>
      </Box>

      {/* A. Revenue Stats */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={t.admin.treasury.stat.pendingFees} value={stats ? f18(stats.platformEarnings) : '—'} sub="mUSDC" valueColor="primary.main" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={t.admin.treasury.stat.walletMusdc} value={stats ? f18(stats.myMusdc) : '—'} sub="mUSDC" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={t.admin.treasury.stat.walletEth} value={stats ? fEth(stats.myEth) : '—'} sub="ETH" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={t.admin.treasury.stat.routerEth} value={stats ? fEth(stats.routerEth) : '—'} sub="ETH" />
        </Grid>
      </Grid>

      {/* B. Step 1: Claim */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Chip label="1" size="small" color="primary" sx={{ fontWeight: 'bold' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {t.admin.treasury.claim.title}
          </Typography>
        </Box>

        {platformTreasury && (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            {interpolate(t.admin.treasury.claim.treasury, { address: platformTreasury })}
          </Typography>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              {t.admin.treasury.claim.pending}
            </Typography>
            <Typography variant="h4" color="primary.main" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
              {stats ? f18(stats.platformEarnings) : '—'} <Box component="span" sx={{ fontSize: '1rem', fontWeight: 'normal', color: 'text.secondary' }}>mUSDC</Box>
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => void doClaim()}
            disabled={busy['claim'] || !stats || stats.platformEarnings === 0n}
          >
            {busy['claim'] ? t.admin.treasury.claim.claiming : t.admin.treasury.claim.cta}
          </Button>
        </Box>

        <Typography variant="caption" color="text.secondary">
          {t.admin.treasury.claim.note}
        </Typography>
      </Card>

      {/* C. Step 2: Convert mUSDC → ETH */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Chip label="2" size="small" color="primary" sx={{ fontWeight: 'bold' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {t.admin.treasury.swap.title}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.admin.treasury.swap.placeholder}
            value={swapAmt}
            onChange={e => setSwapAmt(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
            sx={{ flexGrow: 1, minWidth: 200 }}
          />
          <Button
            variant="outlined"
            onClick={() => stats && setSwapAmt(formatUnits(stats.myMusdc, 18))}
            disabled={!stats || stats.myMusdc === 0n}
          >
            {t.admin.treasury.swap.max}
          </Button>
        </Box>

        {swapAmt && parseFloat(swapAmt) > 0 && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(t.admin.treasury.swap.estimate, {
              eth: (parseFloat(swapAmt) / 3000).toFixed(6),
            })}
          </Typography>
        )}

        {routerInsufficient && (
          <Alert severity="warning">
            {interpolate(t.admin.treasury.swap.routerInsufficient, {
              amount: stats ? fEth(stats.routerEth) : '0',
            })}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant="outlined"
            onClick={() => void doApprove()}
            disabled={busy['approve'] || !swapAmt || parseFloat(swapAmt) <= 0}
            sx={{ flexGrow: 1 }}
          >
            {busy['approve'] ? t.admin.treasury.swap.approving : t.admin.treasury.swap.approve}
          </Button>
          <Button
            variant="contained"
            color="success"
            onClick={() => void doSwapToEth()}
            disabled={busy['swap'] || !swapAmt || parseFloat(swapAmt) <= 0}
            sx={{ flexGrow: 1 }}
          >
            {busy['swap'] ? t.admin.treasury.swap.swapping : t.admin.treasury.swap.swap}
          </Button>
        </Box>
      </Card>

      {/* E. Treasury Tools */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.admin.treasury.tools.title}
        </Typography>

        <Box>
          <Typography variant="body2" sx={{ fontWeight: 'semibold', mb: 0.5 }}>
            {t.admin.treasury.tools.fundRouter}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            {t.admin.treasury.tools.fundRouterDesc}{' '}
            {t.admin.treasury.tools.currentReserve}{' '}
            <Box component="span" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{stats ? fEth(stats.routerEth) : '—'} ETH</Box>
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              type="number"
              size="small"
              placeholder={t.admin.treasury.tools.placeholder}
              value={fundAmt}
              onChange={e => setFundAmt(e.target.value)}
              slotProps={{ htmlInput: { min: "0", step: "0.01", style: { fontFamily: MONO } } }}
              sx={{ width: 200 }}
            />
            <Button
              variant="contained"
              onClick={() => void doFundRouter()}
              disabled={busy['fund'] || !fundAmt || parseFloat(fundAmt) <= 0}
            >
              {busy['fund'] ? t.admin.treasury.tools.funding : t.admin.treasury.tools.cta}
            </Button>
          </Box>
        </Box>
      </Card>

      {/* F. PepeLab Incentives Pool Refill */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ bgcolor: 'rgba(124,193,74,0.1)', p: 1, borderRadius: '50%', color: 'var(--palette-primary-main)', display: 'flex' }}>
            <Iconify icon="solar:palette-bold" sx={{ fontSize: 20 }} />
          </Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {t.admin.treasury.incentives.title}
          </Typography>
        </Box>

        <Typography variant="caption" color="text.secondary">
          {t.admin.treasury.incentives.description}
        </Typography>

        <Grid container spacing={2} sx={{ mt: 0.5 }}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Box sx={{ p: 2, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.05)' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>{t.admin.treasury.incentives.walletBalance}</Typography>
              <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#ffb300', fontFamily: MONO }}>
                {walletPepeBal !== null ? f18(walletPepeBal) : '—'} <Box component="span" sx={{ fontSize: '0.85rem', fontWeight: 'normal', color: 'text.secondary' }}>PEPE</Box>
              </Typography>
            </Box>
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Box sx={{ p: 2, bgcolor: 'rgba(124,193,74,0.04)', borderRadius: 1.5, border: '1px solid rgba(124,193,74,0.15)' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>{t.admin.treasury.incentives.poolBalance}</Typography>
              <Typography variant="h5" sx={{ fontWeight: 'bold', color: 'var(--palette-primary-main)', fontFamily: MONO }}>
                {contractPepeBal !== null ? f18(contractPepeBal) : '—'} <Box component="span" sx={{ fontSize: '0.85rem', fontWeight: 'normal', color: 'text.secondary' }}>PEPE</Box>
              </Typography>
            </Box>
          </Grid>
        </Grid>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mt: 1.5 }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.admin.treasury.incentives.placeholder}
            value={pepeFundAmt}
            onChange={e => setPepeFundAmt(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
            sx={{ width: 250, flexGrow: 1 }}
          />
          <Button
            variant="contained"
            color="success"
            onClick={() => void doFundPepePool()}
            disabled={busy['fundPepe'] || !pepeFundAmt || parseFloat(pepeFundAmt) <= 0}
            sx={{ fontWeight: 'bold', px: 3 }}
          >
            {busy['fundPepe'] ? t.admin.treasury.incentives.funding : t.admin.treasury.incentives.cta}
          </Button>
        </Box>
      </Card>

      {/* D. Cash Out History */}
      <Card>
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            {t.admin.treasury.history.title}
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchHistory()}
            sx={{ textTransform: 'none' }}
          >
            {t.admin.treasury.history.refresh}
          </Button>
        </Box>

        {history.length === 0 ? (
          <EmptyState
            icon="📋"
            title={t.admin.treasury.history.emptyTitle}
            description={t.admin.treasury.history.emptyDescription}
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableBody>
                {history.slice(0, 20).map((r, i) => (
                  <TableRow key={i} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                        <Chip
                          label={r.type === 'claim' ? t.admin.treasury.history.claimed : t.admin.treasury.history.swapped}
                          size="small"
                          color={r.type === 'claim' ? 'primary' : 'success'}
                          sx={{ fontWeight: 'bold' }}
                        />
                        <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                          {r.type === 'claim'
                            ? interpolate(t.admin.treasury.history.claimAmount, {
                                amount: f18(r.amount),
                              })
                            : interpolate(t.admin.treasury.history.swapAmount, {
                                usdcIn: r.usdcIn ? f18(r.usdcIn) : '—',
                                eth: fEth(r.amount),
                              })}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
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
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold' }}>{t.admin.treasury.info.revenueModelLabel}</Box> {t.admin.treasury.info.revenueModelBody}
          </Typography>
          <Typography variant="caption">
            {t.admin.treasury.info.swapNote}
          </Typography>
        </Stack>
      </Card>
    </Container>
  )
}
