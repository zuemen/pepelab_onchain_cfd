import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import { parseUnits, formatUnits } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import Skeleton from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'

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

interface VaultStats {
  totalAssets:  bigint
  totalSupply:  bigint
  sharePrice:   bigint
  myShares:     bigint
  myUsdcValue:  bigint
  feesRouted:   bigint  // N1: cumulative trading fees routed to the vault
  feeShareBps:  bigint  // N1: % of trading fee routed to LPs
}

interface ActivityEntry {
  type:   'Deposited' | 'Withdrawn' | 'ProtocolDeposit' | 'Bailout'
  label:  string
  amount: string
  from:   string
  block:  number
}

const ZERO = 0n

function f18(v: bigint, dec = 2): string {
  return Number(formatUnits(v, 18)).toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  })
}

async function fetchActivity(vault: Contract): Promise<ActivityEntry[]> {
  const events: ActivityEntry[] = []
  try {
    const filter1 = vault.filters.Deposited()
    const filter2 = vault.filters.Withdrawn()
    const filter3 = vault.filters.ProtocolDeposit()
    const filter4 = vault.filters.Bailout()

    const [dep, wit, pro, bai] = await Promise.all([
      vault.queryFilter(filter1, -200),
      vault.queryFilter(filter2, -200),
      vault.queryFilter(filter3, -200),
      vault.queryFilter(filter4, -200),
    ])

    for (const e of dep) {
      const args = (e as any).args
      events.push({ type: 'Deposited', label: 'LP Deposit', amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber ?? 0 })
    }
    for (const e of wit) {
      const args = (e as any).args
      events.push({ type: 'Withdrawn', label: 'LP Withdraw', amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber ?? 0 })
    }
    for (const e of pro) {
      const args = (e as any).args
      events.push({ type: 'ProtocolDeposit', label: 'Protocol Fee', amount: f18(args.amount) + ' USDC', from: args.from, block: e.blockNumber ?? 0 })
    }
    for (const e of bai) {
      const args = (e as any).args
      events.push({ type: 'Bailout', label: 'Bailout Paid', amount: f18(args.amount) + ' USDC', from: args.trader, block: e.blockNumber ?? 0 })
    }

    events.sort((a, b) => b.block - a.block)
  } catch { /* ignore */ }
  return events
}

export default function VaultPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const vault     = contracts?.insuranceVault ?? null
  const usdc      = contracts?.usdc ?? null
  const exchange  = contracts?.exchange ?? null

  const [stats, setStats]         = useState<VaultStats | null>(null)
  const [activity, setActivity]   = useState<ActivityEntry[]>([])
  const [depositAmt, setDepositAmt] = useState('')
  const [withdrawAmt, setWithdrawAmt] = useState('')
  const [busy, setBusy]           = useState(false)
  const [toast, setToast]         = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const notify = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  const fetchStats = useCallback(async () => {
    if (!vault || !wallet.address) return
    try {
      const [totalAssets, totalSupply, sharePrice, myShares] = await Promise.all([
        vault.totalAssets()    as Promise<bigint>,
        vault.totalSupply()    as Promise<bigint>,
        vault.getSharePrice()  as Promise<bigint>,
        vault.balanceOf(wallet.address) as Promise<bigint>,
      ])
      // N1: trading-fee routing stats (best-effort; older ABIs lack these).
      let feesRouted = ZERO
      let feeShareBps = ZERO
      if (exchange) {
        try {
          ;[feesRouted, feeShareBps] = await Promise.all([
            exchange.cumulativeVaultFees() as Promise<bigint>,
            exchange.vaultFeeShareBps()    as Promise<bigint>,
          ])
        } catch { /* feature not deployed */ }
      }
      const myUsdcValue = totalSupply > ZERO
        ? myShares * totalAssets / totalSupply
        : ZERO
      setStats({ totalAssets, totalSupply, sharePrice, myShares, myUsdcValue, feesRouted, feeShareBps })
    } catch { /* not deployed */ }
  }, [vault, exchange, wallet.address])

  useEffect(() => {
    void fetchStats()
    if (vault) void fetchActivity(vault).then(setActivity)
    const t = setInterval(() => { void fetchStats() }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, vault])

  const doDeposit = async () => {
    if (!vault || !usdc || !wallet.signer) return
    setBusy(true)
    try {
      const amount = parseUnits(depositAmt.trim(), 18)
      const approveTx = await usdc.approve(await vault.getAddress(), amount)
      await approveTx.wait()
      const tx = await vault.deposit(amount)
      await tx.wait()
      notify(`Deposited ${depositAmt} USDC ✓`, true, tx.hash)
      setDepositAmt('')
      await fetchStats()
      if (vault) setActivity(await fetchActivity(vault))
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  const doWithdraw = async () => {
    if (!vault || !wallet.signer) return
    setBusy(true)
    try {
      const shares = parseUnits(withdrawAmt.trim(), 18)
      const tx = await vault.withdraw(shares)
      await tx.wait()
      notify(`Withdrew ${withdrawAmt} pIV shares ✓`, true, tx.hash)
      setWithdrawAmt('')
      await fetchStats()
      if (vault) setActivity(await fetchActivity(vault))
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to use the LP Vault.</Typography>
      </Box>
    )
  }

  const activityColorMui: Record<ActivityEntry['type'], string> = {
    Deposited:      'success.main',
    Withdrawn:      'warning.main',
    ProtocolDeposit:'info.main',
    Bailout:        'error.main',
  }

  return (
    <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Stats */}
      <Grid container spacing={2}>
        {[
          { label: 'Total Assets', value: stats ? f18(stats.totalAssets) + ' USDC' : null },
          { label: 'Share Price',  value: stats ? f18(stats.sharePrice) + ' USDC/pIV' : null },
          { label: 'Total Supply', value: stats ? f18(stats.totalSupply) + ' pIV' : null },
          { label: 'My pIV Value', value: stats ? f18(stats.myUsdcValue) + ' USDC' : null },
        ].map(s => (
          <Grid size={{ xs: 6, md: 3 }} key={s.label}>
            <Card sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                {s.label}
              </Typography>
              {s.value === null ? (
                <Skeleton height={28} sx={{ width: '80%', mt: 0.5 }} />
              ) : (
                <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                  {s.value}
                </Typography>
              )}
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* N1: trading-fee → LP routing (market-making yield) */}
      {stats && stats.feeShareBps > ZERO && (
        <Card sx={{ p: 2, bgcolor: 'background.neutral', borderLeft: '3px solid', borderColor: 'success.main' }}>
          <Typography variant="body2" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'baseline' }}>
            <Box component="span" sx={{ fontWeight: 'bold', color: 'success.main' }}>
              Market-making yield active:
            </Box>
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {Number(stats.feeShareBps) / 100}% of every trade's fee is routed to LPs —
            </Box>
            <Box component="span" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
              {f18(stats.feesRouted)} USDC
            </Box>
            <Box component="span" sx={{ color: 'text.secondary' }}>routed to date.</Box>
          </Typography>
        </Card>
      )}

      {/* Your position */}
      {stats && stats.myShares > ZERO && (
        <Card sx={{ p: 3, bgcolor: 'background.neutral' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2, fontWeight: 'bold' }}>
            Your Position
          </Typography>
          <Stack direction="row" spacing={4}>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                pIV held
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {f18(stats.myShares, 4)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                USDC value
              </Typography>
              <Typography variant="body1" color="success.main" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {f18(stats.myUsdcValue)}
              </Typography>
            </Box>
          </Stack>
        </Card>
      )}

      {/* Deposit + Withdraw */}
      <Grid container spacing={2}>
        {/* Deposit */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              Deposit USDC
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              Receive pIV shares proportional to current pool size. Earn yield from protocol fees.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                type="number"
                size="small"
                placeholder="USDC amount"
                value={depositAmt}
                onChange={e => setDepositAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
                sx={{ flexGrow: 1 }}
              />
              <Button
                variant="contained"
                onClick={() => void doDeposit()}
                disabled={busy || !depositAmt}
              >
                {busy ? '…' : 'Deposit'}
              </Button>
            </Box>
            {stats && depositAmt && (
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                ≈ {f18((stats.totalSupply > ZERO && stats.totalAssets > ZERO)
                  ? BigInt(Math.floor(Number(depositAmt) * 1e18)) * stats.totalSupply / stats.totalAssets
                  : BigInt(Math.floor(Number(depositAmt) * 1e18)), 4)} pIV
              </Typography>
            )}
          </Card>
        </Grid>

        {/* Withdraw */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              Withdraw Shares
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              Burn pIV shares to receive proportional USDC from the pool.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                type="number"
                size="small"
                placeholder="pIV shares"
                value={withdrawAmt}
                onChange={e => setWithdrawAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
                sx={{ flexGrow: 1 }}
              />
              <Button
                variant="contained"
                color="warning"
                onClick={() => void doWithdraw()}
                disabled={busy || !withdrawAmt}
              >
                {busy ? '…' : 'Withdraw'}
              </Button>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {stats && withdrawAmt ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  ≈ {f18(stats.totalSupply > ZERO
                    ? BigInt(Math.floor(Number(withdrawAmt) * 1e18)) * stats.totalAssets / stats.totalSupply
                    : 0n, 4)} USDC
                </Typography>
              ) : <Box />}
              {stats && stats.myShares > ZERO && (
                <Button
                  size="small"
                  variant="text"
                  color="inherit"
                  onClick={() => setWithdrawAmt(formatUnits(stats.myShares, 18))}
                  sx={{ textDecoration: 'underline', p: 0, minWidth: 0, textTransform: 'none', typography: 'caption', color: 'text.secondary', '&:hover': { color: 'text.primary', bgcolor: 'transparent' } }}
                >
                  Max ({f18(stats.myShares, 4)} pIV)
                </Button>
              )}
            </Box>
          </Card>
        </Grid>
      </Grid>

      {/* Toast Notification */}
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

      {/* Activity Feed */}
      <Card>
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            Recent Activity
          </Typography>
        </Box>
        {activity.length === 0 ? (
          <EmptyState icon="🏦" title="No activity yet" description="Deposit USDC to start earning yield from protocol fees." />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableBody>
                {activity.slice(0, 20).map((a, i) => (
                  <TableRow key={i} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 'bold', color: activityColorMui[a.type] }}>
                        {a.label}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                        {a.from.slice(0, 10)}…
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'semibold' }}>
                        {a.amount}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                        #{a.block}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Info box */}
      <Card sx={{ p: 2.5, bgcolor: 'background.neutral' }}>
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold' }}>How it works:</Box> LPs deposit USDC and receive pIV shares. The vault earns 10% of all copy-trading and performance fees via the FeeRouter. It also absorbs remaining collateral from liquidated positions.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            When a trader's loss exceeds their margin (extreme event), the vault pays a 10% bailout floor directly to the trader. LPs bear this risk in exchange for the yield.
          </Typography>
        </Stack>
      </Card>
    </Container>
  )
}
