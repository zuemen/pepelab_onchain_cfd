import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { ASSET_IDS } from '../contracts/addresses'

const ASSET_LABEL: Record<string, string> = {
  [ASSET_IDS.sBTC]:  'sBTC',
  [ASSET_IDS.sETH]:  'sETH',
  [ASSET_IDS.sAAPL]: 'sAAPL',
  [ASSET_IDS.sTSLA]: 'sTSLA',
}

interface StakeInfo {
  stakedAmount:  bigint
  totalSlashed:  bigint
  slashCount:    bigint
}

interface RawAlloc {
  asset: string; weight: bigint; isLong: boolean; leverage: bigint
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)

interface Props { wallet: WalletAPI }

export default function TraderProfilePage({ wallet }: Props) {
  const { address: traderAddr } = useParams<{ address: string }>()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint>(0n)
  const [allocs,        setAllocs]        = useState<RawAlloc[]>([])
  const [hasStrategy,   setHasStrategy]   = useState(false)
  const [stakeInfo,     setStakeInfo]     = useState<StakeInfo | null>(null)
  const [repScore,      setRepScore]      = useState<bigint | null>(null)
  const [eligible,      setEligible]      = useState<boolean | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  useEffect(() => {
    if (!contracts || !traderAddr) return
    setLoading(true)
    setError(null)
    const go = async () => {
      try {
        const [traderRaw, fc] = await Promise.all([
          contracts.registry.traders(traderAddr),
          contracts.copyTracker.getFollowerCount(traderAddr),
        ])
        const t = traderRaw as unknown as [boolean, string, bigint]
        setName(t[1])
        setRegistered(t[0])
        setFollowers(fc as bigint)
      } catch (e) {
        setError(e instanceof Error ? e.message.slice(0, 120) : 'Could not load trader')
        setLoading(false)
        return
      }

      try {
        const stratRaw = (await contracts.registry.getLatestStrategy(traderAddr)) as unknown as [unknown[], bigint]
        setAllocs((stratRaw[0] as unknown[]).map(a => {
          const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
          return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
        }))
        setHasStrategy(true)
      } catch { setHasStrategy(false) }

      try {
        const [si, score, elig] = await Promise.all([
          contracts.traderStake.getStake(traderAddr),
          contracts.traderStake.reputationScore(traderAddr),
          contracts.traderStake.isEligible(traderAddr),
        ])
        const s = si as unknown as StakeInfo
        setStakeInfo(s)
        setRepScore(score as bigint)
        setEligible(elig as boolean)
      } catch { /* TraderStake not deployed yet */ }

      setLoading(false)
    }
    void go()
  }, [contracts, traderAddr])

  if (!traderAddr) return <div className="p-8 text-gray-400">Invalid address.</div>

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to view trader profiles.
      </div>
    )
  }

  const repColor = repScore === null ? 'text-gray-400'
    : repScore >= 80n ? 'text-emerald-400'
    : repScore >= 50n ? 'text-yellow-400'
    : 'text-red-400'

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link to="/marketplace" className="hover:text-white transition-colors">Marketplace</Link>
        <span>/</span>
        <span className="text-gray-300">{name || traderAddr.slice(0, 10) + '…'}</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-12 text-center text-gray-500">
          Loading profile…
        </div>
      ) : (
        <>
          {/* ─── Identity ──────────────────────────────────────────── */}
          <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-xl font-bold text-white">{name || 'Unknown'}</h1>
                <p className="text-xs font-mono text-gray-500 mt-0.5">{traderAddr}</p>
              </div>
              {repScore !== null && (
                <div className="text-right">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Reputation</p>
                  <p className={`text-2xl font-bold font-mono ${repColor}`}>{String(repScore)}</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-3 text-sm">
              <span className="text-gray-400">
                <span className="font-semibold text-white">{String(followers)}</span>
                {' '}follower{followers !== 1n ? 's' : ''}
              </span>
              {registered && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-900/40 border border-emerald-800 text-emerald-300 text-xs">
                  ✓ Registered
                </span>
              )}
              {eligible !== null && (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                  eligible
                    ? 'bg-brand-400/20 border-brand-300/30 text-brand-100'
                    : 'bg-red-900/30 border-red-800 text-red-300'
                }`}>
                  {eligible ? '◆ Staked' : '✗ Not staked'}
                </span>
              )}
            </div>
          </div>

          {/* ─── Stake info ─────────────────────────────────────────── */}
          {stakeInfo && (
            <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
              <h2 className="text-base font-bold text-white">Skin-in-the-Game</h2>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-surface-elev rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500">Staked</p>
                  <p className="text-base font-bold font-mono text-white">{f18(stakeInfo.stakedAmount)}</p>
                  <p className="text-xs text-gray-600">mUSDC</p>
                </div>
                <div className="bg-surface-elev rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500">Total Slashed</p>
                  <p className={`text-base font-bold font-mono ${stakeInfo.totalSlashed > 0n ? 'text-danger' : 'text-white'}`}>
                    {f18(stakeInfo.totalSlashed)}
                  </p>
                  <p className="text-xs text-gray-600">mUSDC</p>
                </div>
                <div className="bg-surface-elev rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500">Slash Events</p>
                  <p className={`text-base font-bold font-mono ${stakeInfo.slashCount > 0n ? 'text-danger' : 'text-white'}`}>
                    {String(stakeInfo.slashCount)}
                  </p>
                  <p className="text-xs text-gray-600">times</p>
                </div>
              </div>
            </div>
          )}

          {/* ─── Strategy ───────────────────────────────────────────── */}
          <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
            <h2 className="text-base font-bold text-white">Latest Strategy</h2>
            {!hasStrategy ? (
              <p className="text-sm text-gray-600">No strategy published yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {allocs.map((a, i) => (
                  <span key={i} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border ${
                    a.isLong
                      ? 'bg-green-950 border-green-800 text-green-300'
                      : 'bg-red-950  border-red-800  text-red-300'
                  }`}>
                    {a.isLong ? '↑' : '↓'}
                    {ASSET_LABEL[a.asset] ?? '?'}
                    <span className="text-xs opacity-70">
                      {(Number(a.weight) / 100).toFixed(0)}% · {String(a.leverage)}×
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ─── Actions ────────────────────────────────────────────── */}
          <div className="flex gap-3">
            <Link
              to={`/copy/${traderAddr}`}
              className="flex-1 py-2.5 text-center rounded-lg bg-brand-200 hover:bg-brand-300 text-white text-sm font-semibold transition-colors"
            >
              Copy This Trader →
            </Link>
            <Link
              to="/marketplace"
              className="px-4 py-2.5 rounded-lg border border-surface-border text-gray-300 text-sm font-medium hover:border-gray-400 hover:text-white transition-colors"
            >
              ← Back
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
