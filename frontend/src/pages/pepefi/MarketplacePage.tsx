import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useLivePrices } from 'src/hooks/useLivePrices'
import { ASSET_IDS } from 'src/contracts/addresses'
import Skeleton from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { useESG } from 'src/hooks/useESG'
import ESGBadge from 'src/components/pepefi/ESGBadge'
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta'

// ── Config ───────────────────────────────────────────────────────────────────
const FETCH_BLOCKS_VOLUME = 50_000   // ~7 days on Sepolia

// ── Types ────────────────────────────────────────────────────────────────────
type SortKey = 'reputation' | 'followers' | 'volume' | 'pnl' | 'esg'

const ESG_FRIENDLY_THRESHOLD = 60   // weighted composite ≥ 60

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
  reputation:    bigint | null
  stake:         bigint | null
  totalSlashed:  bigint | null
  totalVolume:   bigint   // margin × leverage, last 7d
  pnl7d:         bigint   // sum realizedPnL from PositionClosed, last 7d
}

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

const cmpBigDesc = (a: bigint, b: bigint) =>
  a === b ? 0 : b > a ? 1 : -1

const fVol = (v: bigint): string => {
  const n = Number(v) / 1e18
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k'
  return n.toFixed(0)
}

const fPnL = (v: bigint): string => {
  const n = Number(v) / 1e18
  const prefix = n >= 0 ? '+' : ''
  if (Math.abs(n) >= 1_000) return prefix + (n / 1_000).toFixed(1) + 'k'
  return prefix + n.toFixed(1)
}

const repBadge = (score: bigint) =>
  score >= 80n ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
  : score >= 60n ? 'bg-yellow-900/60 border-yellow-700 text-yellow-300'
  : 'bg-red-900/60 border-red-800 text-red-300'

// Address-derived avatar color
const avatarHue = (addr: string): string => {
  const n = parseInt(addr.slice(2, 8), 16) % 360
  return `hsl(${n}, 60%, 40%)`
}

// ── Component ────────────────────────────────────────────────────────────────
export default function MarketplacePage() {
  const wallet = usePepefiWallet()
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)
  const livePrices = useLivePrices()

  const [traders,    setTraders]    = useState<TraderCard[]>([])
  const [isLoading,  setIsLoading]  = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [sortKey,    setSortKey]    = useState<SortKey>('reputation')
  const [esgOnly,    setEsgOnly]    = useState(false)

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.provider) return
    setIsLoading(true)
    setFetchError(null)
    try {
      const currentBlock = await wallet.provider.getBlockNumber()
      const fromBlock    = Math.max(0, currentBlock - FETCH_BLOCKS_VOLUME)

      // ── Batch: fetch all position events + trader list in parallel ──────────
      const [openedRes, closedRes, addressesRes] = await Promise.allSettled([
        contracts.exchange.queryFilter(contracts.exchange.filters.PositionOpened(), fromBlock, 'latest'),
        contracts.exchange.queryFilter(contracts.exchange.filters.PositionClosed(), fromBlock, 'latest'),
        contracts.registry.getAllTraders() as Promise<string[]>,
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allOpened  = openedRes.status    === 'fulfilled' ? openedRes.value    : []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allClosed  = closedRes.status    === 'fulfilled' ? closedRes.value    : []
      const addresses  = addressesRes.status === 'fulfilled' ? addressesRes.value : []

      // Build address → volume / PnL maps
      const volumeMap: Record<string, bigint> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const log of allOpened as any[]) {
        const owner = (log.args.owner as string).toLowerCase()
        const vol   = (log.args.margin as bigint) * (log.args.leverage as bigint)
        volumeMap[owner] = (volumeMap[owner] ?? 0n) + vol
      }
      const pnlMap: Record<string, bigint> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const log of allClosed as any[]) {
        const owner = (log.args.owner as string).toLowerCase()
        pnlMap[owner] = (pnlMap[owner] ?? 0n) + (log.args.pnl as bigint)
      }

      // ── Per-trader metadata ─────────────────────────────────────────────────
      const cards = await Promise.all(
        (addresses as string[]).map(async (addr): Promise<TraderCard> => {
          const [traderRaw, fc] = await Promise.all([
            contracts.registry.traders(addr),
            contracts.copyTracker.getFollowerCount(addr),
          ])
          const tRaw = traderRaw as unknown as [boolean, string, bigint]

          let allocs: RawAlloc[] = []
          let hasStrategy = false
          try {
            const stratRaw = (await contracts.registry.getLatestStrategy(addr)) as unknown as [unknown[], bigint]
            allocs      = parseAllocs(stratRaw[0] as unknown[])
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
            reputation   = score as bigint
            const s      = si as unknown as { amount: bigint; totalSlashed: bigint }
            stake        = s.amount
            totalSlashed = s.totalSlashed
          } catch { /* TraderStake not deployed */ }

          const key = addr.toLowerCase()
          return {
            address:      addr,
            displayName:  tRaw[1],
            allocs,
            followerCount: fc as bigint,
            hasStrategy,
            reputation,
            stake,
            totalSlashed,
            totalVolume: volumeMap[key] ?? 0n,
            pnl7d:       pnlMap[key]    ?? 0n,
          }
        }),
      )

      setTraders(cards)
    } catch (e) {
      console.error('[marketplace fetch]', e)
      setFetchError(e instanceof Error ? e.message.slice(0, 140) : 'Network error — check wallet')
    } finally { setIsLoading(false) }
  }, [contracts, wallet.provider])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // ── ESG composite per trader (weighted by allocation weight) ─────────────
  const getEsgComposite = (t: TraderCard): number | null => {
    if (!t.hasStrategy || t.allocs.length === 0) return null
    const totalW = t.allocs.reduce((s, a) => s + Number(a.weight), 0)
    if (totalW === 0) return null
    let wavg = 0
    for (const a of t.allocs) {
      const info = esg[a.asset]
      if (!info) return null
      wavg += info.composite * Number(a.weight)
    }
    return Math.round(wavg / totalW)
  }

  // ── Sorted + filtered view ────────────────────────────────────────────────
  const sorted = [...traders]
    .filter(t => {
      if (!esgOnly) return true
      const score = getEsgComposite(t)
      return score !== null && score >= ESG_FRIENDLY_THRESHOLD
    })
    .sort((a, b) => {
      switch (sortKey) {
        case 'followers':   return cmpBigDesc(a.followerCount, b.followerCount)
        case 'volume':      return cmpBigDesc(a.totalVolume, b.totalVolume)
        case 'pnl':         return cmpBigDesc(a.pnl7d, b.pnl7d)
        case 'esg': {
          const ea = getEsgComposite(a) ?? -1
          const eb = getEsgComposite(b) ?? -1
          return eb - ea
        }
        case 'reputation':
        default: {
          if (a.reputation === null && b.reputation === null) return 0
          if (a.reputation === null) return 1
          if (b.reputation === null) return -1
          return cmpBigDesc(a.reputation, b.reputation)
        }
      }
    })

  const MEDALS    = ['🥇', '🥈', '🥉']
  const MEDAL_CSS = [
    'border-yellow-500/70 shadow-[0_0_12px_rgba(234,179,8,0.15)]',
    'border-gray-400/50',
    'border-amber-600/50',
  ]

  const isStarTrader = (t: TraderCard) =>
    t.reputation !== null && t.reputation > 80n && t.followerCount > 3n

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

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">⭐ Star Trader Leaderboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">Browse and copy on-chain verified strategies</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEsgOnly(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              esgOnly
                ? 'bg-emerald-900/60 border-emerald-700 text-emerald-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
            title="Only show strategies with weighted ESG ≥ 60"
          >
            🌱 ESG {esgOnly ? '已篩選' : '全部'}
          </button>
          <select
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            className="rounded-lg bg-gray-800 border border-gray-700 text-gray-300 text-xs px-3 py-1.5 focus:outline-none focus:border-brand-200"
          >
            <option value="reputation">Sort: Reputation</option>
            <option value="followers">Sort: Followers</option>
            <option value="volume">Sort: Volume (7d)</option>
            <option value="pnl">Sort: PnL (7d)</option>
            <option value="esg">Sort: ESG Score</option>
          </select>
          <button
            onClick={() => void fetchAll()}
            disabled={isLoading}
            className="text-xs text-gray-500 hover:text-white disabled:opacity-40 transition-colors"
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Live Prices ticker */}
      <div className="rounded-card border border-surface-border bg-surface p-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        <span className="text-xs text-gray-500 uppercase font-semibold tracking-wide self-center">Live</span>
        {Object.entries(ASSET_LABEL).map(([id, label]) => {
          const p = livePrices[id]
          if (!p) return null
          return (
            <span key={id} className="flex items-center gap-1.5">
              <span className="text-gray-400 text-xs font-medium">{label}</span>
              <span className={`font-mono text-xs ${p.isMock ? 'text-yellow-400' : 'text-emerald-400'}`}>
                ${p.usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
            </span>
          )
        })}
      </div>

      {fetchError && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          <strong>Failed to load:</strong> {fetchError}
        </div>
      )}

      {/* Leaderboard grid */}
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
          description="Run SeedWhales to populate the leaderboard, or register a strategy on the Trader page."
          ctaText="Become a Trader"
          ctaHref="/trader"
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((t, idx) => {
              const star   = isStarTrader(t)
              const medal  = MEDALS[idx]
              const border = idx < 3 ? MEDAL_CSS[idx] : 'border-surface-border'

              // Weighted ESG composite — reuse helper (avoids duplication)
              const esgScore = getEsgComposite(t)
              const esgComposite = esgScore !== null
                ? {
                    composite: esgScore,
                    rating: esgScore >= 80 ? 'AAA' : esgScore >= 70 ? 'AA' : esgScore >= 60 ? 'A' : esgScore >= 50 ? 'BBB' : 'CCC',
                  }
                : null

              return (
                <div
                  key={t.address}
                  className={`rounded-card border bg-surface shadow-card hover:shadow-card-hover transition-all flex flex-col gap-0 ${border}`}
                >
                  {/* Star Trader banner */}
                  {star && (
                    <div className="rounded-t-card bg-gradient-to-r from-yellow-900/60 to-amber-900/40 border-b border-yellow-700/40 px-4 py-1 flex items-center gap-1.5">
                      <span className="text-xs font-bold text-yellow-300">⭐ Star Trader</span>
                      <span className="text-xs text-yellow-500/70">· Verified On-Chain</span>
                    </div>
                  )}

                  <div className="p-5 flex flex-col gap-3 flex-1">
                    {/* Row 1: Avatar + Identity + Rank + Rep */}
                    <div className="flex items-start gap-3">
                      {/* Avatar */}
                      <div
                        className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-base select-none"
                        style={{ background: avatarHue(t.address) }}
                        title={t.address}
                      >
                        {(t.displayName || '?')[0]?.toUpperCase() ?? '?'}
                      </div>

                      {/* Name + address */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {medal ? (
                            <span className="text-base leading-none shrink-0" title={`#${idx + 1}`}>{medal}</span>
                          ) : (
                            <span className="text-[10px] text-gray-600 font-mono shrink-0">#{idx + 1}</span>
                          )}
                          <Link
                            to={`/trader/${t.address}`}
                            className="font-bold text-white text-sm leading-tight truncate hover:text-brand-100 transition-colors"
                          >
                            {t.displayName || '—'}
                          </Link>
                        </div>
                        <div className="font-mono text-[11px] text-gray-500 mt-0.5">{shortAddr(t.address)}</div>
                      </div>

                      {/* Reputation badge */}
                      {t.reputation !== null && (
                        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold border ${repBadge(t.reputation)}`}>
                          ◆ {String(t.reputation)}
                        </span>
                      )}
                    </div>

                    {/* Row 2: Strategy pills + ESG */}
                    <div className="flex flex-wrap gap-1.5 min-h-[26px]">
                      {!t.hasStrategy ? (
                        <span className="inline-flex items-center rounded-full border border-surface-border bg-surface-elev px-2.5 py-0.5 text-xs text-gray-500">
                          No strategy
                        </span>
                      ) : (
                        t.allocs.map((a, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${
                              a.isLong
                                ? 'bg-green-950 border-green-800 text-green-300'
                                : 'bg-red-950  border-red-800  text-red-300'
                            }`}
                          >
                            {a.isLong ? '↑' : '↓'}{ASSET_LABEL[a.asset] ?? '?'} {(Number(a.weight) / 100).toFixed(0)}% {String(a.leverage)}×
                          </span>
                        ))
                      )}
                      {esgComposite && (
                        <ESGBadge composite={esgComposite.composite} rating={esgComposite.rating} size="sm" />
                      )}
                    </div>

                    {/* Row 3: Metrics grid */}
                    <div className="grid grid-cols-4 gap-0 divide-x divide-surface-border rounded-lg border border-surface-border bg-surface-elev/40 text-center py-2">
                      <MetricCell
                        label="Vol 7d"
                        value={t.totalVolume > 0n ? fVol(t.totalVolume) : '—'}
                        highlight={t.totalVolume >= 10_000n * 10n ** 18n}
                      />
                      <MetricCell
                        label="PnL 7d"
                        value={t.pnl7d !== 0n ? fPnL(t.pnl7d) : '—'}
                        positive={t.pnl7d > 0n}
                        negative={t.pnl7d < 0n}
                      />
                      <MetricCell
                        label="Followers"
                        value={String(t.followerCount)}
                      />
                      <MetricCell
                        label="Stake"
                        value={t.stake !== null && t.stake > 0n
                          ? fVol(t.stake)
                          : '—'}
                      />
                    </div>

                    {/* Slashed warning */}
                    {t.totalSlashed !== null && t.totalSlashed > 0n && (
                      <div className="text-xs text-danger flex items-center gap-1">
                        ⚠ {(Number(t.totalSlashed) / 1e18).toFixed(0)} mUSDC slashed
                      </div>
                    )}

                    {/* Row 4: Actions */}
                    <div className="flex gap-2 pt-1 mt-auto">
                      <Link
                        to={`/trader/${t.address}`}
                        className="flex-1 py-1.5 rounded-lg border border-surface-border text-gray-300 text-xs font-medium hover:border-gray-400 hover:text-white transition-colors text-center"
                      >
                        Profile
                      </Link>
                      {t.hasStrategy ? (
                        <Link
                          to={`/copy/${t.address}`}
                          className="flex-1 py-1.5 rounded-lg bg-brand-200 hover:bg-brand-300 text-white text-xs font-bold transition-colors text-center"
                        >
                          Copy →
                        </Link>
                      ) : (
                        <span className="flex-1 py-1.5 rounded-lg bg-gray-800 text-gray-600 text-xs text-center cursor-not-allowed">
                          No Strategy
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>
              {sorted.length} trader{sorted.length !== 1 ? 's' : ''} ·{' '}
              {sorted.reduce((s, t) => s + Number(t.followerCount), 0)} total followers ·{' '}
              {sorted.filter(isStarTrader).length} star trader{sorted.filter(isStarTrader).length !== 1 ? 's' : ''}
            </span>
            <span>Volume + PnL from last ~{FETCH_BLOCKS_VOLUME.toLocaleString()} blocks (~7d)</span>
          </div>

          {/* Raw text debug (collapsed) */}
          <details className="text-xs text-gray-700">
            <summary className="cursor-pointer hover:text-gray-500 w-fit">Raw strategy data</summary>
            <pre className="mt-2 p-3 rounded bg-gray-900 border border-gray-800 overflow-x-auto text-gray-500 text-[11px]">
              {traders.map(t => `${t.displayName} (${shortAddr(t.address)}): ${summarize(t.allocs) || 'no strategy'}`).join('\n')}
            </pre>
          </details>
        </>
      )}
    </div>
  )
}

// ── Metric cell sub-component ─────────────────────────────────────────────────
function MetricCell({
  label, value, highlight = false, positive = false, negative = false,
}: {
  label: string; value: string; highlight?: boolean; positive?: boolean; negative?: boolean
}) {
  const valueClass = positive ? 'text-green-400' : negative ? 'text-red-400' : highlight ? 'text-brand-100' : 'text-white'
  return (
    <div className="px-1 py-0.5 space-y-0.5">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide leading-none">{label}</div>
      <div className={`text-xs font-mono font-semibold leading-tight ${valueClass}`}>{value}</div>
    </div>
  )
}

// Keep ASSET_IDS import used (for backwards compat with any outside callers)
void ASSET_IDS
