import { useState, useEffect, useCallback } from 'react'
import { Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'

import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (v: unknown) => v as TxResp

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)

export default function TraderStakePage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [info,       setInfo]       = useState<StakeInfo | null>(null)
  const [repScore,   setRepScore]   = useState<bigint | null>(null)
  const [eligible,   setEligible]   = useState<boolean | null>(null)
  const [minStake,   setMinStake]   = useState<bigint>(100n * 10n ** 18n)
  const [cooldown,   setCooldown]   = useState<bigint>(86400n)
  const [stakeInput, setStakeInput] = useState('100')
  const [unstakeAmt, setUnstakeAmt] = useState('')
  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const [rawInfo, score, elig, min, cd] = await Promise.all([
        contracts.traderStake.getStake(wallet.address),
        contracts.traderStake.reputationScore(wallet.address),
        contracts.traderStake.isEligible(wallet.address),
        contracts.traderStake.MIN_STAKE(),
        contracts.traderStake.UNSTAKE_COOLDOWN(),
      ])
      const s = rawInfo as unknown as StakeInfo
      setInfo(s)
      setRepScore(score as bigint)
      setEligible(elig as boolean)
      setMinStake(min as bigint)
      setCooldown(cd as bigint)
    } catch (e) {
      console.error('[stake fetch]', e)
    }
  }, [contracts, wallet.address])

  useEffect(() => { void fetchAll() }, [fetchAll])

  const doApproveAndStake = async () => {
    if (!contracts || !wallet.address) return
    const amt = parseEther(stakeInput || '0')
    if (amt === 0n) { notify('Enter a valid amount', false); return }
    setLoad('stake', true)
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.traderStake.target), amt))
      await approveTx.wait()
      const stakeTx = asTx(await contracts.traderStake.stake(amt))
      await stakeTx.wait()
      notify('Staked successfully ✓', true, stakeTx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('stake', false) }
  }

  const doRequestUnstake = async () => {
    if (!contracts) return
    const amt = parseEther(unstakeAmt || '0')
    if (amt === 0n) { notify('Enter amount to unstake', false); return }
    setLoad('reqUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.requestUnstake(amt))
      await tx.wait()
      notify('Unstake requested ✓ — wait 24 h then execute', true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('reqUnstake', false) }
  }

  const doExecuteUnstake = async () => {
    if (!contracts) return
    setLoad('execUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.executeUnstake())
      await tx.wait()
      notify('Unstake executed ✓', true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('execUnstake', false) }
  }

  const doCancelUnstake = async () => {
    if (!contracts) return
    setLoad('cancelUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.cancelUnstake())
      await tx.wait()
      notify('Unstake cancelled ✓', true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('cancelUnstake', false) }
  }

  const cooldownEnds = info && info.unstakeRequestedAt > 0n
    ? new Date(Number(info.unstakeRequestedAt + cooldown) * 1000).toLocaleString()
    : null

  const canExecute = info && info.unstakeAmount > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) >= (info.unstakeRequestedAt + cooldown)

  const repPct = repScore !== null ? Math.min(Number(repScore), 100) : 0
  const repBarColor = repScore === null ? 'text.disabled'
    : repScore >= 80n ? 'success.main'
    : repScore >= 50n ? 'warning.main'
    : 'error.main'

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to manage your stake.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

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
            {toast.hash && wallet.chainId === 11155111 && (
              <Link
                href={`https://sepolia.etherscan.io/tx/${toast.hash}`}
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

      {/* ─── A. Current Stake ────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            Your Stake
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchAll()}
            sx={{ textTransform: 'none' }}
          >
            ↺ Refresh
          </Button>
        </Box>

        <Grid container spacing={2}>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                Staked
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>
                {info ? f18(info.amount) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>mUSDC</Box>
              </Typography>
            </Card>
          </Grid>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                Total Slashed
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'error.main' }}>
                {info ? f18(info.totalSlashed) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>mUSDC</Box>
              </Typography>
            </Card>
          </Grid>
        </Grid>

        {/* Reputation score with progress bar */}
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
              Reputation Score
            </Typography>
            <Typography variant="subtitle1" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: repBarColor }}>
              {repScore !== null ? `${String(repScore)} / 100` : '…'}
            </Typography>
          </Box>
          <Box sx={{ h: 8, bgcolor: 'background.neutral', borderRadius: 1, overflow: 'hidden' }}>
            <Box
              sx={{
                bgcolor: repBarColor,
                height: '100%',
                width: `${repPct}%`,
                transition: 'width 0.5s'
              }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary">
            Formula: stake × 100 ÷ (stake + totalSlashed × 5)
          </Typography>
        </Stack>

        {/* Eligibility badge */}
        {eligible !== null && (
          <Chip
            label={eligible ? '✓ Eligible to publish strategies' : '✗ Need 100 mUSDC stake'}
            color={eligible ? 'success' : 'error'}
            variant="outlined"
            size="small"
            sx={{ alignSelf: 'flex-start', fontWeight: 'bold' }}
          />
        )}

        <Typography variant="caption" color="text.secondary">
          Minimum stake: {f18(minStake)} mUSDC · Skin-in-the-game for your followers
        </Typography>
      </Card>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Stake mUSDC
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Staking puts your capital at risk — followers can trigger slashing if your strategy causes &gt; 30% loss.
          In return, you earn credibility (reputation score) and can publish strategies.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder="100"
            value={stakeInput}
            onChange={e => setStakeInput(e.target.value)}
            slotProps={{ htmlInput: { min: "100", step: "100", style: { fontFamily: 'monospace' } } }}
            sx={{ width: 140 }}
          />
          <Typography variant="body2" color="text.secondary">mUSDC</Typography>
          <Button
            variant="contained"
            onClick={() => void doApproveAndStake()}
            disabled={busy['stake'] || !stakeInput}
            sx={{ flexGrow: 1 }}
          >
            {busy['stake'] ? 'Staking…' : 'Approve + Stake'}
          </Button>
        </Box>
      </Card>

      {/* ─── C. Unstake Request ──────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Unstake (24 h cooldown)
        </Typography>

        {info && info.unstakeAmount > 0n ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert severity="warning">
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                Pending unstake: {f18(info.unstakeAmount)} mUSDC
              </Typography>
              {canExecute ? 'Cooldown elapsed — ready to execute.' : `Available at: ${cooldownEnds}`}
            </Alert>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                color="warning"
                onClick={() => void doExecuteUnstake()}
                disabled={!canExecute || busy['execUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['execUnstake'] ? 'Executing…' : 'Execute Unstake'}
              </Button>
              <Button
                variant="outlined"
                onClick={() => void doCancelUnstake()}
                disabled={busy['cancelUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['cancelUnstake'] ? 'Cancelling…' : 'Cancel'}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">Request unstake — funds unlock after 24 h cooldown.</Typography>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                type="number"
                size="small"
                placeholder="50"
                value={unstakeAmt}
                onChange={e => setUnstakeAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", step: "50", style: { fontFamily: 'monospace' } } }}
                sx={{ width: 140 }}
              />
              <Typography variant="body2" color="text.secondary">mUSDC</Typography>
              <Button
                variant="outlined"
                onClick={() => void doRequestUnstake()}
                disabled={busy['reqUnstake'] || !unstakeAmt}
                sx={{ flexGrow: 1 }}
              >
                {busy['reqUnstake'] ? 'Requesting…' : 'Request Unstake'}
              </Button>
            </Box>
          </Box>
        )}
      </Card>

      {/* ─── Info ────────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, bgcolor: 'rgba(0, 184, 217, 0.08)', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        <Typography variant="subtitle2" color="info.lighter" sx={{ fontWeight: 'bold', mb: 1 }}>
          How Trader Stake works
        </Typography>
        <Stack spacing={1} sx={{ typography: 'caption', color: 'text.secondary', mb: 2 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>Stake ≥ 100 mUSDC to publish strategies on the Marketplace.</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>If a follower suffers &gt; 30% loss, 50% of that loss amount (capped at 50% of your stake) is slashed and sent to them.</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>Reputation = stake × 100 ÷ (stake + totalSlashed × 5) — degrades as you get slashed.</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>Unstaking requires a 24-hour cooldown.</Box>
          </Box>
        </Stack>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Link component={RouterLink} to="/marketplace" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            ← Back to Marketplace
          </Link>
          <Link component={RouterLink} to="/trader" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            Trader Dashboard →
          </Link>
        </Box>
      </Card>

    </Container>
  )
}
