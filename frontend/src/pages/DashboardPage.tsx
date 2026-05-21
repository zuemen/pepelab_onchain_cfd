import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  PieChart, Pie, Cell, Tooltip as PieTooltip, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as LineTooltip, ResponsiveContainer,
} from 'recharts'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useLivePrices } from '../hooks/useLivePrices'
import { useESG } from '../hooks/useESG'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { ASSET_IDS } from '../contracts/addresses'
import { ASSET_META, ASSET_LABEL } from '../lib/assetMeta'
import Skeleton from '../components/Skeleton'

// ── Constants ─────────────────────────────────────────────────────────────────

// Defined at module level so array reference is stable (no useCallback churn)
const TREND_ASSET_IDS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sAAPL,
]

const TREND_COLORS: Record<string, string> = {
  [ASSET_IDS.sBTC]:  '#f7931a',
  [ASSET_IDS.sETH]:  '#627eea',
  [ASSET_IDS.sGOLD]: '#ffd700',
  [ASSET_IDS.sAAPL]: '#a2aaad',
}

const CAT_CONFIG = {
  crypto:    { label: 'Crypto',    icon: '₿', color: '#6366f1', bg: 'from-indigo-900/40 to-indigo-950/20', border: 'border-indigo-800/50' },
  equity:    { label: 'Equity',    icon: '◈', color: '#a855f7', bg: 'from-purple-900/40 to-purple-950/20', border: 'border-purple-800/50' },
  commodity: { label: 'Commodity', icon: '◆', color: '#f59e0b', bg: 'from-amber-900/40  to-amber-950/20',  border: 'border-amber-800/50' },
  bond:      { label: 'Bond',      icon: '◉', color: '#10b981', bg: 'from-emerald-900/40 to-emerald-950/20', border: 'border-emerald-800/50' },
} as const

const CAT_ORDER = ['crypto', 'equity', 'commodity', 'bond'] as const
type Category   = typeof CAT_ORDER[number]

const PIE_COLORS = CAT_ORDER.map(c => CAT_CONFIG[c].color)

// ── Types ────────────────────────────────────────────────────────────────────

interface PosRow {
  asset:         string
  isLong:        boolean
  unrealizedPnL: bigint
  currentValue:  bigint
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fUsd  = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fPnL = (v: bigint) => {
  const n = Number(v) / 1e18
  return (n >= 0 ? '+' : '') + n.toFixed(2)
}

const pnlColor = (v: bigint) => Number(v) >= 0 ? 'text-green-400' : 'text-red-400'

const ESG_COMMENT = (score: number): string => {
  if (score >= 80) return '您的投資組合符合高標準 ESG 準則，表現優異 🌱'
  if (score >= 65) return '投資組合 ESG 表現良好，仍有進一步優化空間'
  if (score >= 50) return '部分持倉 ESG 評級偏低，建議調整資產配置'
  return '投資組合 ESG 風險較高，請考慮改善整體配置'
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props { wallet: WalletAPI }

export default function DashboardPage({ wallet }: Props) {
  const contracts   = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const livePrices  = useLivePrices()
  const esg         = useESG(contracts?.esgRegistry ?? null)
  const { history: priceHistory } = usePriceHistory(
    contracts?.oracle ?? null,
    wallet.provider,
    TREND_ASSET_IDS,
    livePrices,
  )

  const [positions,  setPositions]  = useState<PosRow[]>([])
  const [isLoading,  setIsLoading]  = useState(false)
  const [isLoaded,   setIsLoaded]   = useState(false)

  // Asset toggles for trend chart
  const [enabled, setEnabled] = useState<Set<string>>(new Set(TREND_ASSET_IDS))
  const toggleAsset = (id: string) =>
    setEnabled(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // ── Fetch open positions ───────────────────────────────────────────────────

  const fetchPositions = useCallback(async () => {
    if (!contracts || !wallet.address) return
    setIsLoading(true)
    try {
      const posIds = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[]
      const rows = await Promise.all(
        posIds.map(async (id): Promise<PosRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as {
              asset: string; isLong: boolean; isOpen: boolean
            }
            if (!raw.isOpen) return null
            const [pnl, val] = await Promise.all([
              contracts.exchange.getUnrealizedPnL(id),
              contracts.exchange.getPositionValue(id),
            ])
            return {
              asset:         raw.asset,
              isLong:        raw.isLong,
              unrealizedPnL: pnl as bigint,
              currentValue:  val as bigint,
            }
          } catch { return null }
        }),
      )
      setPositions(rows.filter((r): r is PosRow => r !== null))
      setIsLoaded(true)
    } catch (e) {
      console.error('[dashboard fetch]', e)
      setIsLoaded(true)
    } finally { setIsLoading(false) }
  }, [contracts, wallet.address])

  useEffect(() => { void fetchPositions() }, [fetchPositions])

  // ── Derived: category breakdown ────────────────────────────────────────────

  const byCategory = useMemo(() => {
    const out: Record<Category, PosRow[]> = { crypto: [], equity: [], commodity: [], bond: [] }
    for (const pos of positions) {
      const cat = ASSET_META[pos.asset]?.category as Category | undefined
      if (cat && out[cat]) out[cat].push(pos)
    }
    return out
  }, [positions])

  const catTotals = useMemo(
    () =>
      CAT_ORDER.map(cat => {
        const poses = byCategory[cat]
        const totalValue = poses.reduce((s, p) => s + p.currentValue, 0n)
        const totalPnL   = poses.reduce((s, p) => s + p.unrealizedPnL, 0n)
        const assets     = [...new Set(poses.map(p => ASSET_LABEL[p.asset] ?? '?'))]
        return { cat, totalValue, totalPnL, assets, count: poses.length }
      }),
    [byCategory],
  )

  // ── Derived: summary stats ─────────────────────────────────────────────────

  const totalValue   = positions.reduce((s, p) => s + p.currentValue, 0n)
  const totalPnL     = positions.reduce((s, p) => s + p.unrealizedPnL, 0n)

  // ── Derived: pie chart data ────────────────────────────────────────────────

  const pieData = useMemo(
    () =>
      catTotals
        .filter(c => c.totalValue > 0n)
        .map(c => ({
          name:     CAT_CONFIG[c.cat].label,
          value:    Number(c.totalValue) / 1e18,
          category: c.cat,
        })),
    [catTotals],
  )

  // ── Derived: ESG composite ────────────────────────────────────────────────

  const portfolioESG = useMemo(() => {
    if (positions.length === 0) return null
    let totalVal = 0
    let wavg     = 0
    for (const pos of positions) {
      const info = esg[pos.asset]
      if (!info) return null   // not all assets rated yet
      const val = Number(pos.currentValue) / 1e18
      totalVal += val
      wavg     += info.composite * val
    }
    if (totalVal === 0) return null
    const composite = Math.round(wavg / totalVal)
    const rating =
      composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' :
      composite >= 50 ? 'BBB' : 'CCC'
    return { composite, rating }
  }, [positions, esg])

  // ── Derived: trend chart data (normalized % change) ───────────────────────

  const chartData = useMemo(() => {
    const allTimes = Array.from(
      new Set(TREND_ASSET_IDS.flatMap(id => (priceHistory[id] ?? []).map(p => p.time))),
    ).sort((a, b) => a - b)
    if (allTimes.length === 0) return []

    const basePrice: Record<string, number> = {}
    for (const id of TREND_ASSET_IDS) {
      const pts = priceHistory[id]
      if (pts && pts.length > 0) basePrice[id] = pts[0].price
    }

    return allTimes.map(t => {
      const row: Record<string, number | string> = {
        time: new Date(t * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
      }
      for (const id of TREND_ASSET_IDS) {
        const pts = priceHistory[id]
        if (!pts || !basePrice[id]) continue
        const pt = pts.filter(p => p.time <= t).at(-1)
        if (pt) row[id] = +((pt.price / basePrice[id] - 1) * 100).toFixed(3)
      }
      return row
    })
  }, [priceHistory])

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to view your dashboard.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Portfolio Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">四類資產收益 · 配置佔比 · 趨勢走勢 · ESG 評分</p>
        </div>
        <button
          onClick={() => void fetchPositions()}
          disabled={isLoading}
          className="text-xs text-gray-500 hover:text-white disabled:opacity-40 transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {/* Summary stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: 'Total Value',
            value: isLoaded ? fUsd(totalValue) : '—',
            sub:   'open positions',
            cls:   'text-white',
          },
          {
            label: 'Unrealized PnL',
            value: isLoaded ? fPnL(totalPnL) + ' USDC' : '—',
            sub:   'across all assets',
            cls:   isLoaded ? pnlColor(totalPnL) : 'text-white',
          },
          {
            label: 'Open Positions',
            value: isLoaded ? String(positions.length) : '—',
            sub:   'across all categories',
            cls:   'text-white',
          },
          {
            label: 'ESG Score',
            value: portfolioESG ? `${portfolioESG.rating} · ${portfolioESG.composite}` : '—',
            sub:   portfolioESG ? ESG_COMMENT(portfolioESG.composite).slice(0, 20) + '…' : 'no positions',
            cls:   portfolioESG
              ? portfolioESG.composite >= 65 ? 'text-emerald-400' : portfolioESG.composite >= 50 ? 'text-yellow-400' : 'text-red-400'
              : 'text-gray-500',
          },
        ].map(({ label, value, sub, cls }) => (
          <div key={label} className="rounded-card border border-surface-border bg-surface shadow-card p-4 space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
            {isLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <p className={`text-lg font-bold font-mono ${cls}`}>{value}</p>
            )}
            <p className="text-[11px] text-gray-600">{sub}</p>
          </div>
        ))}
      </div>

      {/* ── Section A: Category breakdown cards (2×2) ─────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          A · 四類資產收益
        </h2>
        <div className="grid grid-cols-2 gap-4">
          {catTotals.map(({ cat, totalValue: tv, totalPnL: tp, assets, count }) => {
            const cfg = CAT_CONFIG[cat]
            return (
              <div
                key={cat}
                className={`rounded-card border ${cfg.border} bg-gradient-to-br ${cfg.bg} p-5 space-y-3`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{cfg.icon}</span>
                  <span className="font-semibold text-white">{cfg.label}</span>
                  <span className="ml-auto text-xs text-gray-500">{count} position{count !== 1 ? 's' : ''}</span>
                </div>

                {isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                ) : count === 0 ? (
                  <p className="text-sm text-gray-600 italic">No positions</p>
                ) : (
                  <>
                    <div>
                      <p className="text-2xl font-bold font-mono text-white">{fUsd(tv)}</p>
                      <p className={`text-sm font-semibold font-mono mt-0.5 ${pnlColor(tp)}`}>
                        {fPnL(tp)} USDC
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {assets.map(a => (
                        <span
                          key={a}
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
                          style={{ borderColor: cfg.color + '60', color: cfg.color, background: cfg.color + '15' }}
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Section B + D: Pie chart + ESG ────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">

        {/* B. Allocation pie chart */}
        <section className="md:col-span-2 rounded-card border border-surface-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            B · 資產配置佔比
          </h2>
          {isLoading ? (
            <div className="flex items-center justify-center h-52"><Skeleton className="h-44 w-44 rounded-full" /></div>
          ) : pieData.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-52 text-gray-600 text-sm text-center gap-2">
              <span className="text-3xl opacity-30">◕</span>
              <p>開倉後顯示配置佔比</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%" cy="50%"
                  outerRadius={80}
                  innerRadius={40}
                  paddingAngle={3}
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.category} fill={PIE_COLORS[CAT_ORDER.indexOf(entry.category as Category)]} />
                  ))}
                </Pie>
                <PieTooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) => [`$${(value as number).toFixed(2)}`, '']}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => <span style={{ color: '#9ca3af', fontSize: 12 }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* D. ESG composite */}
        <section className="md:col-span-3 rounded-card border border-surface-border bg-surface p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            D · ESG 組合評分
          </h2>

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : !portfolioESG ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-600 text-sm text-center gap-2">
              <span className="text-3xl opacity-30">🌱</span>
              <p>{positions.length === 0 ? '開倉後顯示 ESG 評分' : 'ESG 資料載入中…'}</p>
            </div>
          ) : (
            <>
              {/* Score display */}
              <div className="flex items-end gap-4">
                <div>
                  <p className="text-5xl font-extrabold font-mono" style={{
                    color: portfolioESG.composite >= 65 ? '#34d399'
                         : portfolioESG.composite >= 50 ? '#fbbf24' : '#f87171',
                  }}>
                    {portfolioESG.composite}
                  </p>
                  <p className="text-sm text-gray-400 mt-1">Portfolio ESG Score</p>
                </div>
                <div className="pb-1">
                  <span
                    className="inline-flex items-center rounded-full px-3 py-1 text-sm font-bold border"
                    style={{
                      background: portfolioESG.composite >= 65 ? '#064e3b' : portfolioESG.composite >= 50 ? '#451a03' : '#450a0a',
                      borderColor: portfolioESG.composite >= 65 ? '#10b981' : portfolioESG.composite >= 50 ? '#f59e0b' : '#ef4444',
                      color:       portfolioESG.composite >= 65 ? '#6ee7b7' : portfolioESG.composite >= 50 ? '#fde68a' : '#fca5a5',
                    }}
                  >
                    {portfolioESG.rating}
                  </span>
                </div>
              </div>

              {/* Score bar */}
              <div className="space-y-1">
                <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${portfolioESG.composite}%`,
                      background: portfolioESG.composite >= 65 ? '#10b981' : portfolioESG.composite >= 50 ? '#f59e0b' : '#ef4444',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-gray-600">
                  <span>0</span><span>50</span><span>100</span>
                </div>
              </div>

              {/* Commentary */}
              <p className="text-sm text-gray-300">{ESG_COMMENT(portfolioESG.composite)}</p>

              {/* Per-asset breakdown */}
              <div className="space-y-1.5 pt-1">
                {positions.map(pos => {
                  const info = esg[pos.asset]
                  if (!info) return null
                  return (
                    <div key={pos.asset + String(pos.unrealizedPnL)} className="flex items-center gap-3 text-xs">
                      <span className="w-14 text-gray-400 shrink-0">{ASSET_LABEL[pos.asset] ?? '?'}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${info.composite}%`,
                            background: info.composite >= 65 ? '#10b981' : info.composite >= 50 ? '#f59e0b' : '#ef4444',
                          }}
                        />
                      </div>
                      <span className="w-8 text-right font-mono text-gray-400">{info.composite}</span>
                      <span className="text-gray-600 w-7">{info.rating}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── Section C: Price trend chart ──────────────────────────────────────── */}
      <section className="rounded-card border border-surface-border bg-surface p-5 space-y-4">
        <div className="flex items-center flex-wrap gap-3 justify-between">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            C · 四資產趨勢（價格 % 變化）
          </h2>
          {/* Asset toggles */}
          <div className="flex flex-wrap gap-2">
            {TREND_ASSET_IDS.map(id => (
              <button
                key={id}
                onClick={() => toggleAsset(id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  enabled.has(id)
                    ? 'border-transparent text-white'
                    : 'border-gray-700 text-gray-600 bg-transparent'
                }`}
                style={enabled.has(id) ? { background: TREND_COLORS[id] + '30', borderColor: TREND_COLORS[id] + '80', color: TREND_COLORS[id] } : {}}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: TREND_COLORS[id] }} />
                {ASSET_LABEL[id]}
              </button>
            ))}
          </div>
        </div>

        {chartData.length < 2 ? (
          <div className="flex flex-col items-center justify-center h-52 text-gray-600 text-sm text-center gap-2">
            <span className="text-3xl opacity-30">📈</span>
            <p>趨勢資料累積中…</p>
            <p className="text-xs text-gray-700">每次載入頁面記錄一個快照點，幾分鐘後即可看到走勢</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fill: '#6b7280', fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: '#6b7280', fontSize: 10 }}
                tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
                width={52}
              />
              <LineTooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#6b7280' }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(value: any, name: any) => [
                  `${(value as number) >= 0 ? '+' : ''}${(value as number).toFixed(2)}%`,
                  ASSET_LABEL[name as string] ?? (name as string),
                ]}
              />
              {TREND_ASSET_IDS.filter(id => enabled.has(id)).map(id => (
                <Line
                  key={id}
                  type="monotone"
                  dataKey={id}
                  stroke={TREND_COLORS[id]}
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

    </div>
  )
}
