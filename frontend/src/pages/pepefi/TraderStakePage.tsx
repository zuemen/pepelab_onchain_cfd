import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { t, interpolate } from 'src/locales'
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel'

import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'
import { useToast } from 'src/components/pepefi/ToastProvider'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (v: unknown) => v as TxResp

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)

// 信譽質押本身不受跟單旗標影響（配置市集發布策略的前提）；只有提到跟單／跟隨者的
// 說明文字在旗標關閉時換成 t.stake.copyOff 的中性說法。
const COPY_ON = FEATURE_COPY_TRADING

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
  const { notify } = useToast()

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))

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
    if (amt === 0n) { notify(t.stake.add.enterAmount, false); return }
    setLoad('stake', true)
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.traderStake.target), amt))
      await approveTx.wait()
      const stakeTx = asTx(await contracts.traderStake.stake(amt))
      await stakeTx.wait()
      notify(t.stake.add.done, true, stakeTx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('stake', false) }
  }

  const doRequestUnstake = async () => {
    if (!contracts) return
    const amt = parseEther(unstakeAmt || '0')
    if (amt === 0n) { notify(t.stake.unstake.enterAmount, false); return }
    setLoad('reqUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.requestUnstake(amt))
      await tx.wait()
      notify(t.stake.unstake.requested, true, tx.hash)
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
      notify(t.stake.unstake.executed, true, tx.hash)
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
      notify(t.stake.unstake.cancelled, true, tx.hash)
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
        <Typography color="text.secondary">{t.common.wallet.connectPrompt.stake}</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* ─── Reputation Staking (TraderStake.sol) ───────────────────────── */}
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
          {t.stake.sections.reputation.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {interpolate(COPY_ON ? t.stake.sections.reputation.subtitle : t.stake.copyOff.subtitle, { token: STABLE_LABEL })}
        </Typography>
      </Box>

      {/* ─── A. Current Stake ────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            {t.stake.current.title}
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchAll()}
            sx={{ textTransform: 'none' }}
          >
            {t.stake.current.refresh}
          </Button>
        </Box>

        <Grid container spacing={2}>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                {t.stake.current.staked}
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                {info ? f18(info.amount) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>{STABLE_LABEL}</Box>
              </Typography>
            </Card>
          </Grid>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                {t.stake.current.totalSlashed}
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'error.main' }}>
                {info ? f18(info.totalSlashed) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>{STABLE_LABEL}</Box>
              </Typography>
            </Card>
          </Grid>
        </Grid>

        {/* Reputation score with progress bar */}
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
              {t.stake.current.reputation}
            </Typography>
            <Typography variant="subtitle1" sx={{ fontFamily: MONO, fontWeight: 'bold', color: repBarColor }}>
              {repScore !== null
                ? interpolate(t.stake.current.reputationValue, { score: String(repScore) })
                : '…'}
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
            {t.stake.current.formula}
          </Typography>
        </Stack>

        {/* Eligibility badge */}
        {eligible !== null && (
          <Chip
            label={
              eligible
                ? t.stake.current.eligible
                : interpolate(t.stake.current.notEligible, { token: STABLE_LABEL })
            }
            color={eligible ? 'success' : 'error'}
            variant="outlined"
            size="small"
            sx={{ alignSelf: 'flex-start', fontWeight: 'bold' }}
          />
        )}

        <Typography variant="caption" color="text.secondary">
          {interpolate(COPY_ON ? t.stake.current.minimum : t.stake.copyOff.minimum, {
            amount: f18(minStake),
            token: STABLE_LABEL,
          })}
        </Typography>
      </Card>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {interpolate(t.stake.add.title, { token: STABLE_LABEL })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {COPY_ON ? t.stake.add.description : t.stake.copyOff.addDescription}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.stake.add.placeholder}
            value={stakeInput}
            onChange={e => setStakeInput(e.target.value)}
            slotProps={{ htmlInput: { min: "100", step: "100", style: { fontFamily: MONO } } }}
            sx={{ width: 140 }}
          />
          <Typography variant="body2" color="text.secondary">{STABLE_LABEL}</Typography>
          <Button
            variant="contained"
            onClick={() => void doApproveAndStake()}
            disabled={busy['stake'] || !stakeInput}
            sx={{ flexGrow: 1 }}
          >
            {busy['stake'] ? t.stake.add.staking : t.stake.add.cta}
          </Button>
        </Box>
      </Card>

      {/* ─── C. Unstake Request ──────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.stake.unstake.title}
        </Typography>

        {info && info.unstakeAmount > 0n ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert severity="warning">
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {interpolate(t.stake.unstake.pending, {
                  amount: f18(info.unstakeAmount),
                  token: STABLE_LABEL,
                })}
              </Typography>
              {canExecute
                ? t.stake.unstake.ready
                : interpolate(t.stake.unstake.availableAt, { when: cooldownEnds ?? '' })}
            </Alert>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                color="warning"
                onClick={() => void doExecuteUnstake()}
                disabled={!canExecute || busy['execUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['execUnstake'] ? t.stake.unstake.executing : t.stake.unstake.execute}
              </Button>
              <Button
                variant="outlined"
                onClick={() => void doCancelUnstake()}
                disabled={busy['cancelUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['cancelUnstake'] ? t.stake.unstake.cancelling : t.stake.unstake.cancel}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">{t.stake.unstake.description}</Typography>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                type="number"
                size="small"
                placeholder={t.stake.unstake.placeholder}
                value={unstakeAmt}
                onChange={e => setUnstakeAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", step: "50", style: { fontFamily: MONO } } }}
                sx={{ width: 140 }}
              />
              <Typography variant="body2" color="text.secondary">{STABLE_LABEL}</Typography>
              <Button
                variant="outlined"
                onClick={() => void doRequestUnstake()}
                disabled={busy['reqUnstake'] || !unstakeAmt}
                sx={{ flexGrow: 1 }}
              >
                {busy['reqUnstake'] ? t.stake.unstake.requesting : t.stake.unstake.request}
              </Button>
            </Box>
          </Box>
        )}
      </Card>

      {/* ─── Info ────────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, bgcolor: 'rgba(0, 184, 217, 0.08)', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        <Typography variant="subtitle2" color="info.lighter" sx={{ fontWeight: 'bold', mb: 1 }}>
          {t.stake.info.title}
        </Typography>
        <Stack spacing={1} sx={{ typography: 'caption', color: 'text.secondary', mb: 2 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{interpolate(t.stake.info.publish, { token: STABLE_LABEL })}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{COPY_ON ? t.stake.info.slashing : t.stake.copyOff.slashing}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{t.stake.info.reputation}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{t.stake.info.cooldown}</Box>
          </Box>
        </Stack>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Link component={RouterLink} to="/marketplace" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            {t.stake.info.backToMarketplace}
          </Link>
          <Link component={RouterLink} to="/trader" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            {t.stake.info.traderDashboard}
          </Link>
        </Box>
      </Card>

    </Container>
  )
}
