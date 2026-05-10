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
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

interface RawAlloc {
  asset: string; weight: bigint; isLong: boolean; leverage: bigint
}

interface SlashEvent {
  trader:    string
  amount:    bigint
  recipient: string
  txHash:    string
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

interface Props { wallet: WalletAPI }

export default function TraderProfilePage({ wallet }: Props) {
  const { address: traderAddr } = useParams<{ address: string }>()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint>(0n)
  const [followerList,  setFollowerList]  = useState<string[]>([])
  const [allocs,        setAllocs]        = useState<RawAlloc[]>([])
  const [hasStrategy,   setHasStrategy]   = useState(false)
  const [stakeInfo,     setStakeInfo]     = useState<StakeInfo | null>(null)
  const [repScore,      setRepScore]      = useState<bigint | null>(null)
  const [eligible,      setEligible]      = useState<boolean | null>(null)
  const [slashHistory,  setSlashHistory]  = useState<SlashEvent[]>([])
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

      // strategy
      try {
        const stratRaw = (await contracts.registry.getLatestStrategy(traderAddr)) as unknown as [unknown[], bigint]
        setAllocs((stratRaw[0] as unknown[]).map(a => {
          const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
          return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
        }))
        setHasStrategy(true)
      } catch { setHasStrategy(false) }

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

  const repBadge = repScore === null ? ''
    : repScore >= 80n ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
    : repScore >= 50n ? 'bg-yellow-900/60 border-yellow-700 text-yellow-300'
    : 'bg-red-900/60 border-red-800 text-red-300'

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
          {/* ─── A. Header ────────────────────────────────────────── */}
          <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-xl font-bold text-white">{name || 'Unknown'}</h1>
                <p className="text-xs font-mono text-gray-500 mt-0.5">{traderAddr}</p>
              </div>
              {repScore !== null && (
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold border ${repBadge}`}>
                  ◆ {String(repScore)}
                </span>
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

            <Link
              to={`/copy/${traderAddr}`}
              className="block w-full py-2.5 text-center rounded-lg bg-brand-200 hover:bg-brand-300 text-white text-sm font-semibold transition-colors"
            >
              Copy This Trader →
            </Link>
          </div>

          {/* ─── B. Stake Status ───────────────────────────────────── */}
          {stakeInfo && (
            <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
              <h2 className="text-base font-bold text-white">Skin-in-the-Game</h2>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-surface-elev rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500">Staked</p>
                  <p className="text-base font-bold font-mono text-white">{f18(stakeInfo.amount)}</p>
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
                  <p className="text-xs text-gray-500">Reputation</p>
                  <p className={`text-base font-bold font-mono ${repColor}`}>
                    {repScore !== null ? String(repScore) : '—'}
                  </p>
                  <p className="text-xs text-gray-600">/ 100</p>
                </div>
              </div>
            </div>
          )}

          {/* ─── C. Strategy History ───────────────────────────────── */}
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

          {/* ─── D. Followers ──────────────────────────────────────── */}
          {followerList.length > 0 && (
            <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
              <h2 className="text-base font-bold text-white">
                Followers
                <span className="ml-2 text-xs font-normal text-gray-500">(first {followerList.length})</span>
              </h2>
              <div className="space-y-1">
                {followerList.map((addr, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-surface-border last:border-0">
                    <span className="font-mono text-gray-300">{shortAddr(addr)}</span>
                    <span className="text-gray-600">#{i + 1}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─── E. Slash History ──────────────────────────────────── */}
          {slashHistory.length > 0 && (
            <div className="rounded-card border border-red-900/40 bg-red-950/10 shadow-card p-5 space-y-3">
              <h2 className="text-base font-bold text-red-300">
                Slash History
                <span className="ml-2 text-xs font-normal text-gray-500">({slashHistory.length} event{slashHistory.length !== 1 ? 's' : ''})</span>
              </h2>
              <div className="space-y-2">
                {slashHistory.map((ev, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-2 border-b border-surface-border last:border-0">
                    <div>
                      <p className="text-danger font-mono font-semibold">−{f18(ev.amount)} mUSDC</p>
                      <p className="text-gray-500 mt-0.5">→ {shortAddr(ev.recipient)}</p>
                    </div>
                    {wallet.chainId === 11155111 && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${ev.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info hover:underline text-xs"
                      >
                        Etherscan ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
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
