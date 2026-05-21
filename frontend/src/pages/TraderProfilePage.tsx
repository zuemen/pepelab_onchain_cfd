import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { CardSkeleton } from '../components/Skeleton'
import { useESG } from '../hooks/useESG'
import ESGBadge from '../components/ESGBadge'
import { ASSET_LABEL } from '../lib/assetMeta'

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

interface RawAlloc {
  asset: string; weight: bigint; isLong: boolean; leverage: bigint
}

interface HistVer {
  versionId: number
  createdAt: bigint
  allocs:    RawAlloc[]
  expanded:  boolean
}

interface SlashEvent {
  trader:    string
  amount:    bigint
  recipient: string
  txHash:    string
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const fmtDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })

interface Props { wallet: WalletAPI }

export default function TraderProfilePage({ wallet }: Props) {
  const { address: traderAddr } = useParams<{ address: string }>()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const esg       = useESG(contracts?.esgRegistry ?? null)

  const [name,          setName]          = useState('')
  const [registered,    setRegistered]    = useState(false)
  const [followers,     setFollowers]     = useState<bigint>(0n)
  const [followerList,  setFollowerList]  = useState<string[]>([])
  const [allocs,        setAllocs]        = useState<RawAlloc[]>([])
  const [hasStrategy,   setHasStrategy]   = useState(false)
  const [stratHistory,  setStratHistory]  = useState<HistVer[]>([])
  const [stakeInfo,     setStakeInfo]     = useState<StakeInfo | null>(null)
  const [repScore,      setRepScore]      = useState<bigint | null>(null)
  const [eligible,      setEligible]      = useState<boolean | null>(null)
  const [earnings,      setEarnings]      = useState<bigint | null>(null)
  const [stratCount,    setStratCount]    = useState<number | null>(null)
  const [slashHistory,  setSlashHistory]  = useState<SlashEvent[]>([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  const toggleVer = useCallback((versionId: number) => {
    setStratHistory(prev =>
      prev.map(v => v.versionId === versionId ? { ...v, expanded: !v.expanded } : v),
    )
  }, [])

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

      // strategy + history
      try {
        const count = Number((await contracts.registry.getStrategyCount(traderAddr)) as bigint)
        setStratCount(count)
        if (count > 0) {
          const vers = await Promise.all(
            Array.from({ length: count }, (_, i) => i).map(async (i): Promise<HistVer> => {
              const res = (await contracts.registry.getStrategyVersion(traderAddr, BigInt(i))) as unknown as [unknown[], bigint]
              return {
                versionId: i,
                createdAt: res[1],
                allocs:    (res[0] as unknown[]).map(a => {
                  const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
                  return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
                }),
                expanded: false,
              }
            }),
          )
          const sorted = [...vers].reverse()
          setStratHistory(sorted)
          setAllocs(sorted[0]?.allocs ?? [])
          setHasStrategy(sorted[0]?.allocs.length > 0)
        } else {
          setHasStrategy(false)
        }
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

      // fee earnings
      try {
        const raw = (await contracts.feeRouter.traderEarnings(traderAddr)) as bigint
        setEarnings(raw)
      } catch { /* FeeRouter not deployed */ }

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
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
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

          {/* ─── B. Stats grid (4 cards) ──────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-surface rounded-card border border-surface-border p-4 text-center space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Staked</p>
              <p className="text-lg font-bold font-mono text-white">
                {stakeInfo ? f18(stakeInfo.amount) : '—'}
              </p>
              <p className="text-xs text-gray-600">mUSDC</p>
            </div>
            <div className="bg-surface rounded-card border border-surface-border p-4 text-center space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Followers</p>
              <p className="text-lg font-bold font-mono text-white">{String(followers)}</p>
              <p className="text-xs text-gray-600">copiers</p>
            </div>
            <div className="bg-surface rounded-card border border-surface-border p-4 text-center space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Earnings</p>
              <p className="text-lg font-bold font-mono text-emerald-400">
                {earnings !== null ? f18(earnings, 4) : '—'}
              </p>
              <p className="text-xs text-gray-600">mUSDC</p>
            </div>
            <div className="bg-surface rounded-card border border-surface-border p-4 text-center space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Strategies</p>
              <p className="text-lg font-bold font-mono text-white">
                {stratCount !== null ? stratCount : '—'}
              </p>
              <p className="text-xs text-gray-600">versions</p>
            </div>
          </div>

          {/* ─── C. Latest Strategy ────────────────────────────────── */}
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

          {/* ─── D. Strategy History ───────────────────────────────── */}
          {stratHistory.length > 0 && (
            <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
              <h2 className="text-base font-bold text-white">
                Strategy History
                <span className="ml-2 text-xs font-normal text-gray-500">({stratHistory.length} version{stratHistory.length !== 1 ? 's' : ''})</span>
              </h2>
              <div className="space-y-2">
                {stratHistory.map(ver => (
                  <div key={ver.versionId} className="rounded-lg border border-surface-border overflow-hidden">
                    <button
                      onClick={() => toggleVer(ver.versionId)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-elev transition-colors text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs font-mono text-gray-500 shrink-0">v{ver.versionId}</span>
                        <span className="text-sm text-white truncate">
                          {ver.allocs.map(a =>
                            `${ASSET_LABEL[a.asset] ?? '?'} ${a.isLong ? 'L' : 'S'} ${String(a.leverage)}×`,
                          ).join(' · ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <span className="text-xs text-gray-500">{fmtDate(ver.createdAt)}</span>
                        <span className="text-gray-500 text-xs">{ver.expanded ? '▲' : '▼'}</span>
                      </div>
                    </button>
                    {ver.expanded && (
                      <div className="border-t border-surface-border bg-surface-sub px-4 py-3 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                              <th className="py-1.5 pr-4 text-left">Asset</th>
                              <th className="py-1.5 pr-4 text-left">ESG</th>
                              <th className="py-1.5 pr-4 text-left">Side</th>
                              <th className="py-1.5 pr-4 text-left">Lev</th>
                              <th className="py-1.5 text-right">Weight</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-surface-border">
                            {ver.allocs.map((a, idx) => (
                              <tr key={idx} className="text-gray-300">
                                <td className="py-2 pr-4 font-mono text-white">{ASSET_LABEL[a.asset] ?? '?'}</td>
                                <td className="py-2 pr-4">
                                  {esg[a.asset]
                                    ? <ESGBadge composite={esg[a.asset].composite} rating={esg[a.asset].rating} />
                                    : <span className="text-gray-600 text-xs">—</span>
                                  }
                                </td>
                                <td className={`py-2 pr-4 font-bold text-xs ${a.isLong ? 'text-green-400' : 'text-red-400'}`}>
                                  {a.isLong ? 'Long ↑' : 'Short ↓'}
                                </td>
                                <td className="py-2 pr-4 font-mono">{String(a.leverage)}×</td>
                                <td className="py-2 text-right font-mono font-semibold text-white">
                                  {(Number(a.weight) / 100).toFixed(0)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

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
