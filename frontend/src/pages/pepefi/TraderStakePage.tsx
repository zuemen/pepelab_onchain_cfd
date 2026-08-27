import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { t, interpolate } from 'src/locales'
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

  // ── PEPE Yield Farm State ──────────────────────────────────────────────────
  const [onChainPepeBalance, setOnChainPepeBalance] = useState<bigint | null>(null)
  const [lastClaimedAt, setLastClaimedAt] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('pepefi:stake:last_claimed_at')
      if (saved) return Number(saved)
    } catch (e) { /* fallback */ }
    const now = Date.now() - 3600 * 1000 * 2 // Default: 2 hours of accumulated yield to start!
    try {
      localStorage.setItem('pepefi:stake:last_claimed_at', now.toString())
    } catch (e) { /* fallback */ }
    return now
  })
  const [pendingPepe, setPendingPepe] = useState<number>(0)

  // Real-time ticking effect
  useEffect(() => {
    if (!info || info.amount === 0n) {
      setPendingPepe(0)
      return
    }

    const stakedUSDC = Number(info.amount) / 1e18
    // Reward Rate: 1 mUSDC staked yields 0.02 PEPE tokens per day (slowed down and authentic!)
    const rewardRatePerSecond = (stakedUSDC * 0.02) / 86400

    // 每 100ms 重繪一次整頁只為了讓小數點跳動——手機上這是純粹的耗電，桌機上
    // 它把 React 的 commit 排滿。收益率是「每天 0.02 PEPE / mUSDC」，1 秒的
    // 解析度已經遠超過肉眼能分辨的變化。
    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - lastClaimedAt) / 1000
      const earned = Math.max(0, elapsedSeconds * rewardRatePerSecond)
      setPendingPepe(earned)
    }, 1000)

    return () => clearInterval(interval)
  }, [info, lastClaimedAt])

  /**
   * 「收割」目前**沒有真正的獎勵來源**。
   *
   * 舊版直接呼叫 `pepeToken.mint(user, amount)`——那是 `onlyOwner`，對任何一般
   * 使用者都是 100% revert；錯誤文案自己都寫著「請確保您使用的是 PepeToken 合約
   * 的擁有者錢包」，等於承認這顆按鈕不是給使用者按的。讓使用者簽名、付 gas、
   * 然後撞回一個必然的 revert，比不給按更糟。
   *
   * 真正要能發獎勵，需要一份預先注資的 PepeStaking／分配合約（PepeStaking 在
   * 本鏈是 0x0）。在那之前這裡明確標示為展示用累計、按鈕停用，不發任何交易。
   */
  const HARVEST_ENABLED = false

  const addPepeToWallet = async () => {
    if (!window.ethereum || !contracts) return
    try {
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: String(contracts.pepeToken.target),
            symbol: 'PEPE',
            decimals: 18,
          },
        },
      })
      notify(t.stake.farm.addedToWallet, true)
    } catch (e) {
      console.error('Add PEPE failed', e)
      notify(t.stake.farm.addToWalletFailed, false)
    }
  }

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const [rawInfo, score, elig, min, cd, pepeBal] = await Promise.all([
        contracts.traderStake.getStake(wallet.address),
        contracts.traderStake.reputationScore(wallet.address),
        contracts.traderStake.isEligible(wallet.address),
        contracts.traderStake.MIN_STAKE(),
        contracts.traderStake.UNSTAKE_COOLDOWN(),
        contracts.pepeToken.balanceOf(wallet.address),
      ])
      const s = rawInfo as unknown as StakeInfo
      setInfo(s)
      setRepScore(score as bigint)
      setEligible(elig as boolean)
      setMinStake(min as bigint)
      setCooldown(cd as bigint)
      setOnChainPepeBalance(pepeBal as bigint)
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
        <Typography color="text.secondary">Connect wallet to manage your stake.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

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
          {interpolate(t.stake.current.minimum, {
            amount: f18(minStake),
            token: STABLE_LABEL,
          })}
        </Typography>
      </Card>

      {/* ─── PEPE Yield Farm Card ────────────────────────────────────────── */}
      <Card 
        sx={{ 
          p: 3, 
          background: 'linear-gradient(135deg, rgba(76, 175, 80, 0.12) 0%, rgba(26, 117, 255, 0.08) 100%)',
          border: '1px solid rgba(76, 175, 80, 0.3)',
          boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
          backdropFilter: 'blur(4px)',
          borderRadius: 2,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex', 
          flexDirection: 'column', 
          gap: 2.5 
        }}
      >
        {/* Glow effect in background */}
        <Box 
          sx={{ 
            position: 'absolute', 
            top: '-50%', 
            right: '-30%', 
            width: '200px', 
            height: '200px', 
            background: 'radial-gradient(circle, rgba(76,175,80,0.4) 0%, rgba(0,0,0,0) 70%)', 
            pointerEvents: 'none',
            zIndex: 0
          }} 
        />

        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h5" sx={{ fontSize: '1.5rem', cursor: 'default' }}>🌾</Typography>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'success.light', display: 'flex', alignItems: 'center', gap: 1 }}>
                {t.stake.farm.title}
                <Chip label={t.stake.farm.chip} color="success" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 'bold' }} />
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {interpolate(t.stake.farm.subtitle, { token: STABLE_LABEL })}
              </Typography>
            </Box>
          </Stack>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="subtitle2" sx={{ color: 'success.main', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              ⚡ 0.73% APR
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t.stake.farm.aprLabel}
            </Typography>
          </Box>
        </Box>

        <Card sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid rgba(255, 255, 255, 0.05)', borderRadius: 1.5, zIndex: 1 }}>
          <Grid container spacing={2}>
            <Grid size={{ xs: 6 }}>
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5, letterSpacing: 0.8 }}>
                  {t.stake.farm.pending}
                </Typography>
                <Typography 
                  variant="h5" 
                  sx={{ 
                    fontFamily: MONO, 
                    fontWeight: '900', 
                    color: pendingPepe > 0 ? '#4caf50' : 'text.disabled',
                    textShadow: pendingPepe > 0 ? '0 0 10px rgba(76,175,80,0.3)' : 'none',
                  }}
                >
                  🐸 {pendingPepe.toFixed(5)}
                </Typography>
              </Box>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <Box sx={{ textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5, letterSpacing: 0.8 }}>
                  {t.stake.farm.walletBalance}
                </Typography>
                <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: '#ffb300' }}>
                  🪙 {onChainPepeBalance !== null ? f18(onChainPepeBalance, 0) : '0'}
                </Typography>
              </Box>
            </Grid>
          </Grid>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 1.5 }}>
            {info && info.amount > 0n
              ? interpolate(t.stake.farm.accruedFrom, {
                  amount: f18(info.amount),
                  token: STABLE_LABEL,
                })
              : interpolate(t.stake.farm.notStaked, { token: STABLE_LABEL })}
          </Typography>
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', textAlign: 'center', mt: 0.5 }}>
            {t.stake.markup.disclaimerBefore}<b>{t.stake.markup.disclaimerBold}</b>{t.stake.markup.disclaimerAfter}
          </Typography>
        </Card>

        <Stack direction="row" spacing={2} sx={{ zIndex: 1 }}>
          <Button
            variant="contained"
            color="success"
            size="large"
            disabled={!HARVEST_ENABLED}
            title={t.stake.farm.harvestDisabledHint}
            sx={{
              flexGrow: 2,
              py: 1.5,
              fontWeight: 'bold',
              textShadow: '0 1px 2px rgba(0,0,0,0.2)',
              background: pendingPepe > 0 ? 'linear-gradient(90deg, #4caf50 0%, #2e7d32 100%)' : undefined,
              boxShadow: pendingPepe > 0 ? '0 4px 14px 0 rgba(76,175,80,0.4)' : undefined,
              transition: 'all 0.2s',
              '&:hover': {
                background: pendingPepe > 0 ? 'linear-gradient(90deg, #66bb6a 0%, #388e3c 100%)' : undefined,
                transform: pendingPepe > 0 ? 'translateY(-1px)' : 'none',
              }
            }}
          >
            {t.stake.farm.harvest}
          </Button>
          
          <Button
            variant="outlined"
            onClick={addPepeToWallet}
            sx={{
              flexGrow: 1,
              borderColor: 'rgba(255, 179, 0, 0.4)',
              color: '#ffb300',
              fontWeight: 'bold',
              '&:hover': {
                borderColor: '#ffb300',
                bgcolor: 'rgba(255, 179, 0, 0.08)'
              }
            }}
          >
            {t.stake.farm.addToWallet}
          </Button>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ zIndex: 1, textAlign: 'center', fontStyle: 'italic' }}>
          {t.stake.markup.footnoteBefore}{STABLE_LABEL}{t.stake.markup.footnoteMid1}{STABLE_LABEL}{t.stake.markup.footnoteMid2}<b>{t.stake.markup.footnoteBold}</b>{t.stake.markup.footnoteAfter}
        </Typography>
      </Card>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {interpolate(t.stake.add.title, { token: STABLE_LABEL })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t.stake.add.description}
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
            <Box>{t.stake.info.slashing}</Box>
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
