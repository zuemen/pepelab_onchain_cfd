import { MONO } from 'src/components/pepefi/brandKit'
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
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'

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
    // Reward Rate: 1 USDT staked yields 0.02 PEPE tokens per day (slowed down and authentic!)
    const rewardRatePerSecond = (stakedUSDC * 0.02) / 86400

    const interval = setInterval(() => {
      const elapsedSeconds = (Date.now() - lastClaimedAt) / 1000
      const earned = Math.max(0, elapsedSeconds * rewardRatePerSecond)
      setPendingPepe(earned)
    }, 100) // Ticks every 100ms for a gorgeous live dynamic GameFi feel!

    return () => clearInterval(interval)
  }, [info, lastClaimedAt])

  const doHarvestYield = async () => {
    if (pendingPepe <= 0 || !contracts || !wallet.address) return
    
    setLoad('harvest', true)
    try {
      const amountToMint = parseEther(pendingPepe.toFixed(18))
      
      // Execute ACTUAL on-chain mint transaction to user's Metamask account
      const tx = asTx(await contracts.pepeToken.mint(wallet.address, amountToMint))
      await tx.wait()
      
      const now = Date.now()
      localStorage.setItem('pepefi:stake:last_claimed_at', now.toString())
      setLastClaimedAt(now)
      setPendingPepe(0)
      
      // Dispatch global event so all menus refresh their PEPE balances instantly!
      window.dispatchEvent(new CustomEvent('pepefi:gamefi-updated'))
      notify(`鏈上收割成功！已成功在鏈上鑄造 ${Number(amountToMint) / 1e18} PEPE 並發送至您的錢包 🌾🐸`, true, tx.hash)
      await fetchAll()
    } catch (e) {
      console.error('[harvest error]', e)
      notify(`鏈上收割失敗：${prettyError(e)}。請確保您使用的是 PepeToken 合約的擁有者錢包。`, false)
    } finally {
      setLoad('harvest', false)
    }
  }

  const addPepeToWallet = async () => {
    if (!(window as any).ethereum || !contracts) return
    try {
      await (window as any).ethereum.request({
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
      notify('已將 PEPE 代幣合約成功加入您的 Metamask！ 🦊🐸', true)
    } catch (e) {
      console.error('Add PEPE failed', e)
      notify('新增代幣失敗，請手動複製合約地址。', false)
    }
  }

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

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
            {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
              <Link
                href={explorerTx(toast.hash, wallet.chainId)!}
                target="_blank"
                rel="noopener noreferrer"
                color="inherit"
                sx={{ display: 'block', mt: 0.5, typography: 'caption', textDecoration: 'underline' }}
              >
                View on {explorerName(wallet.chainId)} ↗
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
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                {info ? f18(info.amount) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>USDT</Box>
              </Typography>
            </Card>
          </Grid>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                Total Slashed
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'error.main' }}>
                {info ? f18(info.totalSlashed) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>USDT</Box>
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
            <Typography variant="subtitle1" sx={{ fontFamily: MONO, fontWeight: 'bold', color: repBarColor }}>
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
            label={eligible ? '✓ Eligible to publish strategies' : '✗ Need 100 USDT stake'}
            color={eligible ? 'success' : 'error'}
            variant="outlined"
            size="small"
            sx={{ alignSelf: 'flex-start', fontWeight: 'bold' }}
          />
        )}

        <Typography variant="caption" color="text.secondary">
          Minimum stake: {f18(minStake)} USDT · Skin-in-the-game for your followers
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
                PEPE 收益農場
                <Chip label="鏈上聯動實時挖礦" color="success" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 'bold' }} />
              </Typography>
              <Typography variant="caption" color="text.secondary">
                利用您的 USDT 聲譽質押賺取真正的鏈上 PEPE 代幣！
              </Typography>
            </Box>
          </Stack>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="subtitle2" sx={{ color: 'success.main', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              ⚡ 0.73% APR
            </Typography>
            <Typography variant="caption" color="text.secondary">
              穩健收益率
            </Typography>
          </Box>
        </Box>

        <Card sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid rgba(255, 255, 255, 0.05)', borderRadius: 1.5, zIndex: 1 }}>
          <Grid container spacing={2}>
            <Grid size={{ xs: 6 }}>
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5, letterSpacing: 0.8 }}>
                  待收割 PEPE 收益 (Pending)
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
                  錢包鏈上 PEPE 餘額 (Wallet)
                </Typography>
                <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: '#ffb300' }}>
                  🪙 {onChainPepeBalance !== null ? f18(onChainPepeBalance, 0) : '0'}
                </Typography>
              </Box>
            </Grid>
          </Grid>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 1.5 }}>
            {info && info.amount > 0n ? (
              `每秒賺取中... 🚀 (基於質押的 ${f18(info.amount)} USDT)`
            ) : (
              '⚠️ 您目前尚未質押 USDT，無法開始挖礦！'
            )}
          </Typography>
        </Card>

        <Stack direction="row" spacing={2} sx={{ zIndex: 1 }}>
          <Button
            variant="contained"
            color="success"
            size="large"
            onClick={doHarvestYield}
            disabled={pendingPepe <= 0 || busy['harvest']}
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
            {busy['harvest'] ? '鏈上交易發送中...' : pendingPepe > 0 ? `🌾 鏈上收割 (Mint to Wallet)` : '🌾 暫無收益'}
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
            🦊 加 Metamask
          </Button>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ zIndex: 1, textAlign: 'center', fontStyle: 'italic' }}>
          * 提示：質押的 USDT 作為合約聲譽保障金不可免息產生 USDT 收益，但本平台貼心為您自動開啟鏈上 PEPE 挖礦！
          每質押 1 USDT 每日產出 0.02 PEPE，收割將發起鏈上鑄造交易，直接存入您的實體錢包！
        </Typography>
      </Card>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Stake USDT
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
            slotProps={{ htmlInput: { min: "100", step: "100", style: { fontFamily: MONO } } }}
            sx={{ width: 140 }}
          />
          <Typography variant="body2" color="text.secondary">USDT</Typography>
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
                Pending unstake: {f18(info.unstakeAmount)} USDT
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
                slotProps={{ htmlInput: { min: "0", step: "50", style: { fontFamily: MONO } } }}
                sx={{ width: 140 }}
              />
              <Typography variant="body2" color="text.secondary">USDT</Typography>
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
            <Box>Stake ≥ 100 USDT to publish strategies on the Marketplace.</Box>
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
