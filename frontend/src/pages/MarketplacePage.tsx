import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useLivePrices } from '../hooks/useLivePrices'
import { ASSET_IDS } from '../contracts/addresses'
import Skeleton from '../components/Skeleton'
import EmptyState from '../components/EmptyState'
import { useESG } from '../hooks/useESG'
import ESGBadge from '../components/ESGBadge'

// ── Config ──────────────────────────────────────────────────────────────────
const ASSET_LABEL: Record<string, string> = {
  [ASSET_IDS.sBTC]:  'sBTC',
  [ASSET_IDS.sETH]:  'sETH',
  [ASSET_IDS.sAAPL]: 'sAAPL',
  [ASSET_IDS.sTSLA]: 'sTSLA',
}

type SortKey = 'reputation' | 'followers' | 'stake'

// ── Types ────────────────────────────────────────────────────────────────────
interface RawAlloc {
  asset:    string
  weight:   bigint
  isLong:   boolean
  leverage: bigint
}

interface TraderCard {
  address:       string
  displayName:   string
  allocs:        RawAlloc[]
  followerCount: bigint
  hasStrategy:   boolean
  reputation:    bigint | null   // null = TraderStake not deployed
  stake:         bigint | null
  totalSlashed:  bigint | null
}

const MOCK_TRADERS: TraderCard[] = [
  {
    address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    displayName: 'Crypto_Chad',
    allocs: [
      { asset: ASSET_IDS.sBTC, weight: 10000n, isLong: true, leverage: 5n }
    ],
    followerCount: 1250n,
    hasStrategy: true,
    reputation: 95n,
    stake: 5000n * 10n**18n,
    totalSlashed: 0n,
  },
  {
    address: '0x1563915e194D8CfBA1943570603F7606A3115508',
    displayName: 'Tech_Bear_Fund',
    allocs: [
      { asset: ASSET_IDS.sBTC, weight: 10000n, isLong: false, leverage: 2n }
    ],
    followerCount: 840n,
    hasStrategy: true,
    reputation: 82n,
    stake: 10000n * 10n**18n,
    totalSlashed: 500n * 10n**18n,
  },
  {
    address: '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB',
    displayName: 'Stable_Quant',
    allocs: [
      { asset: ASSET_IDS.sBTC, weight: 10000n, isLong: true, leverage: 1n }
    ],
    followerCount: 312n,
    hasStrategy: true,
    reputation: 99n,
    stake: 25000n * 10n**18n,
    totalSlashed: 0n,
  }
]

// ── Helpers ──────────────────────────────────────────────────────────────────
const parseAllocs = (arr: unknown[]): RawAlloc[] =>
  arr.map(a => {
    const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
    return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
  })

const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

const summarize = (allocs: RawAlloc[]): string =>
  allocs
    .map(a =>
      `${a.isLong ? 'L' : 'S'} ${ASSET_LABEL[a.asset] ?? '?'} ` +
      `${(Number(a.weight) / 100).toFixed(0)}% ${String(a.leverage)}×`,
    )
    .join(' | ')

const repBadge = (score: bigint) =>
  score >= 80n ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
  : score >= 60n ? 'bg-yellow-900/60 border-yellow-700 text-yellow-300'
  : 'bg-red-900/60 border-red-800 text-red-300'

// ── Component ────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function MarketplacePage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const esg       = useESG(contracts?.esgRegistry ?? null)

  const [traders,    setTraders]    = useState<TraderCard[]>([])
  const [isLoading,  setIsLoading]  = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [sortKey,    setSortKey]    = useState<SortKey>('reputation')
  const livePrices = useLivePrices()

  const fetchAll = useCallback(async () => {
    if (!contracts) return
    setIsLoading(true)
    setFetchError(null)
    try {
      const addresses = (await contracts.registry.getAllTraders()) as string[]

      const cards = await Promise.all(
        addresses.map(async (addr): Promise<TraderCard> => {
          const [traderRaw, fc] = await Promise.all([
            contracts.registry.traders(addr),
            contracts.copyTracker.getFollowerCount(addr),
          ])
          const tRaw = traderRaw as unknown as [boolean, string, bigint]

          let allocs: RawAlloc[] = []
          let hasStrategy = false
          try {
            const stratRaw = (await contracts.registry.getLatestStrategy(addr)) as unknown as [unknown[], bigint]
            allocs = parseAllocs(stratRaw[0] as unknown[])
            hasStrategy = allocs.length > 0
          } catch { /* no strategy yet */ }

          let reputation:   bigint | null = null
          let stake:        bigint | null = null
          let totalSlashed: bigint | null = null
          try {
            const [score, si] = await Promise.all([
              contracts.traderStake.reputationScore(addr),
              contracts.traderStake.getStake(addr),
            ])
            reputation = score as bigint
            const s = si as unknown as { amount: bigint; totalSlashed: bigint }
            stake        = s.amount
            totalSlashed = s.totalSlashed
          } catch { /* TraderStake not available */ }

          return {
            address:       addr,
            displayName:   tRaw[1],
            allocs,
            followerCount: fc as bigint,
            hasStrategy,
            reputation,
            stake,
            totalSlashed,
          }
        }),
      )

      setTraders([...cards, ...MOCK_TRADERS])
    } catch (e) {
      console.error('[marketplace fetch]', e)
      setFetchError(e instanceof Error ? e.message.slice(0, 140) : 'Network error — check your wallet network')
    } finally { setIsLoading(false) }
  }, [contracts])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // ── Sorted view ───────────────────────────────────────────────────────────
  const sorted = [...traders].sort((a, b) => {
    if (sortKey === 'followers') return Number(b.followerCount - a.followerCount)
    if (sortKey === 'stake') {
      const sa = a.stake ?? 0n
      const sb = b.stake ?? 0n
      return sa === sb ? 0 : sb > sa ? 1 : -1
    }
    // reputation (default): nulls last
    if (a.reputation === null && b.reputation === null) return 0
    if (a.reputation === null) return 1
    if (b.reputation === null) return -1
    return Number(b.reputation - a.reputation)
  })

  const MEDALS = ['🥇', '🥈', '🥉']

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to browse the marketplace.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Strategy Marketplace</h1>
          <p className="text-sm text-gray-400 mt-0.5">Browse and copy public trader strategies</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Sort dropdown */}
          <select
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            className="rounded-lg bg-gray-800 border border-gray-700 text-gray-300 text-xs px-2 py-1.5 focus:outline-none focus:border-brand-200"
          >
            <option value="reputation">Sort: Reputation</option>
            <option value="followers">Sort: Followers</option>
            <option value="stake">Sort: Stake</option>
          </select>
          <button
            onClick={() => void fetchAll()}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Live Prices ticker */}
      <div className="rounded-card border border-surface-border bg-surface p-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <span className="text-xs text-gray-500 uppercase font-semibold tracking-wide self-center">Live Prices</span>
        {Object.entries(ASSET_LABEL).map(([id, label]) => {
          const p = livePrices[id]
          if (!p) return null
          return (
            <span key={id} className="flex items-center gap-2">
              <span className="text-gray-400 font-medium">{label}</span>
              <span className={`font-mono ${p.isMock ? 'text-yellow-400' : 'text-emerald-400'}`}>
                ${p.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {p.isMock && <span className="text-xs text-gray-600">(simulated)</span>}
            </span>
          )
        })}
        <span className="text-xs text-gray-600 self-center ml-auto">Refresh 30s · CoinGecko + simulated</span>
      </div>

      {fetchError && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          <strong>Failed to load marketplace:</strong> {fetchError}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-1.5 flex-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
              <div className="flex gap-2 pt-1">
                <Skeleton className="h-7 flex-1" />
                <Skeleton className="h-7 flex-1" />
              </div>
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No traders yet"
          description="Be the first to publish a strategy and earn copy fees from followers."
          ctaText="Become a Trader"
          ctaHref="/trader"
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((t, idx) => (
              <div
                key={t.address}
                className={`rounded-card border bg-surface shadow-card hover:shadow-card-hover transition-shadow flex flex-col gap-3 p-5 ${
                  idx === 0 ? 'border-yellow-600/60' : idx === 1 ? 'border-gray-400/40' : idx === 2 ? 'border-amber-700/40' : 'border-surface-border'
                }`}
              >
                {/* Rank + Trader identity + reputation */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex items-start gap-2">
                    {idx < 3 && (
                      <span className="text-lg leading-none shrink-0 mt-0.5" title={`#${idx + 1}`}>
                        {MEDALS[idx]}
                      </span>
                    )}
                    {idx >= 3 && (
                      <span className="text-xs text-gray-600 font-mono shrink-0 mt-1">#{idx + 1}</span>
                    )}
                    <div className="min-w-0">
                      <Link
                        to={`/trader/${t.address}`}
                        className="font-bold text-white text-base leading-tight truncate block hover:text-brand-100 transition-colors"
                      >
                        {t.displayName || '—'}
                      </Link>
                      <div className="font-mono text-xs text-gray-500 mt-0.5">{shortAddr(t.address)}</div>
                    </div>
                  </div>
                  {t.reputation !== null && (
                    <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold border ${repBadge(t.reputation)}`}>
                      ◆ {String(t.reputation)}
                    </span>
                  )}
                </div>

                {/* Stake info row */}
                {t.stake !== null && (
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>Skin in game: <span className="text-white font-mono">{(Number(t.stake) / 1e18).toFixed(0)}</span> mUSDC</span>
                    {t.totalSlashed !== null && t.totalSlashed > 0n && (
                      <span className="text-danger">· {(Number(t.totalSlashed) / 1e18).toFixed(0)} slashed</span>
                    )}
                  </div>
                )}

                {/* Strategy chips */}
                <div className="flex-1 flex flex-wrap gap-1.5 min-h-[28px]">
                  {!t.hasStrategy ? (
                    <span className="inline-flex items-center rounded-full border border-surface-border bg-surface-elev px-2.5 py-0.5 text-xs text-gray-500">
                      No strategy yet
                    </span>
                  ) : (
                    t.allocs.map((a, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                          a.isLong
                            ? 'bg-green-950 border-green-800 text-green-300'
                            : 'bg-red-950  border-red-800  text-red-300'
                        }`}
                      >
                        {a.isLong ? '↑' : '↓'}
                        {' '}{ASSET_LABEL[a.asset] ?? '?'}
                        {' '}{(Number(a.weight) / 100).toFixed(0)}%
                        {' '}{String(a.leverage)}×
                      </span>
                    ))
                  )}
                </div>
                {/* Weighted-average ESG badge for the strategy */}
                {t.hasStrategy && (() => {
                  const totalWeight = t.allocs.reduce((s, a) => s + Number(a.weight), 0)
                  if (totalWeight === 0) return null
                  let wavg = 0
                  for (const a of t.allocs) {
                    const info = esg[a.asset]
                    if (!info) return null
                    wavg += info.composite * Number(a.weight)
                  }
                  const composite = Math.round(wavg / totalWeight)
                  const rating = composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' : composite >= 50 ? 'BBB' : 'CCC'
                  return <ESGBadge composite={composite} rating={rating} size="sm" />
                })()}

                <div className="flex items-center justify-between pt-2 border-t border-surface-border">
                  <span className="text-xs text-gray-500">
                    <span className="font-mono font-semibold text-white">{String(t.followerCount)}</span>
                    {' '}follower{t.followerCount !== 1n ? 's' : ''}
                  </span>
                  <div className="flex gap-2">
                    <Link
                      to={`/trader/${t.address}`}
                      className="px-3 py-1.5 rounded-lg border border-surface-border text-gray-300 text-xs font-medium hover:border-gray-400 hover:text-white transition-colors"
                    >
                      Profile
                    </Link>
                    {t.hasStrategy && (
                      <Link
                        to={`/copy/${t.address}`}
                        className="px-3 py-1.5 rounded-lg bg-brand-200 hover:bg-brand-300 text-white text-xs font-semibold transition-colors"
                      >
                        Copy
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-gray-600 text-right">
            {sorted.length} trader{sorted.length !== 1 ? 's' : ''} ·{' '}
            {sorted.reduce((s, t) => s + Number(t.followerCount), 0)} total followers
          </p>
        </>
      )}

      {traders.length > 0 && (
        <details className="text-xs text-gray-700">
          <summary className="cursor-pointer hover:text-gray-500 w-fit">Raw strategy text</summary>
          <pre className="mt-2 p-3 rounded bg-gray-900 border border-gray-800 overflow-x-auto text-gray-500">
            {traders.map(t => `${t.displayName}: ${summarize(t.allocs)}`).join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
