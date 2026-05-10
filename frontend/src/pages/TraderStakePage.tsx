import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { parseEther } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (v: unknown) => v as TxResp

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)

interface Props { wallet: WalletAPI }

export default function TraderStakePage({ wallet }: Props) {
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
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Stake failed', false)
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
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Request failed', false)
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
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Execute failed', false)
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
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Cancel failed', false)
    } finally { setLoad('cancelUnstake', false) }
  }

  const cooldownEnds = info && info.unstakeRequestedAt > 0n
    ? new Date(Number(info.unstakeRequestedAt + cooldown) * 1000).toLocaleString()
    : null

  const canExecute = info && info.unstakeAmount > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) >= (info.unstakeRequestedAt + cooldown)

  // reputation score 0-100 as percentage for progress bar
  const repPct = repScore !== null ? Math.min(Number(repScore), 100) : 0
  const repBarColor = repScore === null ? 'bg-gray-600'
    : repScore >= 80n ? 'bg-emerald-500'
    : repScore >= 50n ? 'bg-yellow-500'
    : 'bg-red-500'

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to manage your stake.
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-xl ${
          toast.ok ? 'bg-emerald-800 text-emerald-100' : 'bg-red-900 text-red-100'
        }`}>
          {toast.msg}
          {toast.hash && wallet.chainId === 11155111 && (
            <a href={`https://sepolia.etherscan.io/tx/${toast.hash}`}
               target="_blank" rel="noopener noreferrer"
               className="block mt-1 text-xs underline opacity-80 hover:opacity-100">
              View on Etherscan ↗
            </a>
          )}
        </div>
      )}

      {/* ─── A. Current Stake ────────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Your Stake</h2>
          <button onClick={() => void fetchAll()} className="text-xs text-gray-500 hover:text-white transition-colors">
            ↺ Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-surface-elev rounded-lg p-3 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Staked</p>
            <p className="text-xl font-bold font-mono text-white">
              {info ? f18(info.amount) : '…'}
              <span className="text-xs font-normal text-gray-500 ml-1">mUSDC</span>
            </p>
          </div>
          <div className="bg-surface-elev rounded-lg p-3 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Slashed</p>
            <p className="text-xl font-bold font-mono text-danger">
              {info ? f18(info.totalSlashed) : '…'}
              <span className="text-xs font-normal text-gray-500 ml-1">mUSDC</span>
            </p>
          </div>
        </div>

        {/* Reputation score with progress bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Reputation Score</p>
            <span className={`text-sm font-bold font-mono ${
              repScore === null ? 'text-gray-400'
              : repScore >= 80n ? 'text-emerald-400'
              : repScore >= 50n ? 'text-yellow-400'
              : 'text-red-400'
            }`}>
              {repScore !== null ? `${String(repScore)} / 100` : '…'}
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${repBarColor}`}
              style={{ width: `${repPct}%` }}
            />
          </div>
          <p className="text-xs text-gray-600">
            Formula: stake × 100 ÷ (stake + totalSlashed × 5)
          </p>
        </div>

        {/* Eligibility badge */}
        {eligible !== null && (
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${
            eligible
              ? 'bg-emerald-900/40 border-emerald-700 text-emerald-300'
              : 'bg-red-900/40 border-red-700 text-red-300'
          }`}>
            {eligible ? '✓ Eligible to publish strategies' : '✗ Need 100 mUSDC stake'}
          </div>
        )}

        <p className="text-xs text-gray-600">
          Minimum stake: {f18(minStake)} mUSDC · Skin-in-the-game for your followers
        </p>
      </div>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Stake mUSDC</h2>
        <p className="text-xs text-gray-500">
          Staking puts your capital at risk — followers can trigger slashing if your strategy causes &gt; 30% loss.
          In return, you earn credibility (reputation score) and can publish strategies.
        </p>
        <div className="flex gap-3">
          <input
            type="number"
            min="100"
            step="100"
            placeholder="100"
            value={stakeInput}
            onChange={e => setStakeInput(e.target.value)}
            className="w-40 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-200"
          />
          <span className="self-center text-sm text-gray-400">mUSDC</span>
          <button
            onClick={() => void doApproveAndStake()}
            disabled={busy['stake'] || !stakeInput}
            className="flex-1 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
          >
            {busy['stake'] ? 'Staking…' : 'Approve + Stake'}
          </button>
        </div>
      </div>

      {/* ─── C. Unstake Request ──────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Unstake (24 h cooldown)</h2>

        {/* ─── D. Pending Unstake ──────────────────────────────────────────── */}
        {info && info.unstakeAmount > 0n ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm space-y-1">
              <p className="text-warn font-semibold">Pending unstake: {f18(info.unstakeAmount)} mUSDC</p>
              <p className="text-xs text-gray-400">
                {canExecute ? 'Cooldown elapsed — ready to execute.' : `Available at: ${cooldownEnds}`}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => void doExecuteUnstake()}
                disabled={!canExecute || busy['execUnstake']}
                className="flex-1 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
              >
                {busy['execUnstake'] ? 'Executing…' : 'Execute Unstake'}
              </button>
              <button
                onClick={() => void doCancelUnstake()}
                disabled={busy['cancelUnstake']}
                className="flex-1 py-2 rounded-lg bg-surface-elev hover:bg-surface-border disabled:opacity-40 text-gray-300 text-sm font-medium transition-colors border border-surface-border"
              >
                {busy['cancelUnstake'] ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Request unstake — funds unlock after 24 h cooldown.</p>
            <div className="flex gap-3">
              <input
                type="number"
                min="0"
                step="50"
                placeholder="50"
                value={unstakeAmt}
                onChange={e => setUnstakeAmt(e.target.value)}
                className="w-40 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-200"
              />
              <span className="self-center text-sm text-gray-400">mUSDC</span>
              <button
                onClick={() => void doRequestUnstake()}
                disabled={busy['reqUnstake'] || !unstakeAmt}
                className="flex-1 py-2 rounded-lg bg-surface-elev hover:bg-surface-border disabled:opacity-40 text-gray-300 text-sm font-medium transition-colors border border-surface-border"
              >
                {busy['reqUnstake'] ? 'Requesting…' : 'Request Unstake'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── Info ────────────────────────────────────────────────────── */}
      <div className="rounded-card border border-info/20 bg-info/5 p-4 text-xs text-gray-400 space-y-1.5">
        <p className="text-info font-semibold text-sm">How Trader Stake works</p>
        <ul className="space-y-1 list-disc list-inside leading-relaxed">
          <li>Stake ≥ 100 mUSDC to publish strategies on the Marketplace.</li>
          <li>If a follower suffers &gt; 30% loss, 50% of that loss amount (capped at 50% of your stake) is slashed and sent to them.</li>
          <li>Reputation = stake × 100 ÷ (stake + totalSlashed × 5) — degrades as you get slashed.</li>
          <li>Unstaking requires a 24-hour cooldown.</li>
        </ul>
        <div className="pt-2">
          <Link to="/marketplace" className="text-info hover:underline">← Back to Marketplace</Link>
          {' · '}
          <Link to="/trader" className="text-info hover:underline">Trader Dashboard →</Link>
        </div>
      </div>

    </div>
  )
}
