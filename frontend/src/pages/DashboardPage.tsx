import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  PieChart, Pie, Cell, Tooltip as PieTooltip, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as LineTooltip, ResponsiveContainer,
} from 'recharts'
import type { WalletAPI } from '../hooks/useWallet'
import type { WhaleAlert } from '../hooks/useWhaleAlerts'
import type { LivePrice } from '../hooks/useLivePrices'
import { useContracts } from '../hooks/useContracts'
import { useLivePrices } from '../hooks/useLivePrices'
import { useESG } from '../hooks/useESG'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { ASSET_IDS } from '../contracts/addresses'
import { ASSET_META } from '../lib/assetMeta'
import ESGBadge from '../components/ESGBadge'
import Skeleton from '../components/Skeleton'

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Display category: 'etf' merged into commodity ────────────────────────────

type DisplayCat = 'crypto' | 'equity' | 'commodity' | 'bond'
const DISPLAY_CATS: DisplayCat[] = ['crypto', 'equity', 'commodity', 'bond']

const displayCatOf = (assetId: string): DisplayCat => {
  const cat = ASSET_META[assetId]?.category
  if (cat === 'equity') return 'equity'
  if (cat === 'bond')   return 'bond'
  if (cat === 'commodity' || cat === 'etf') return 'commodity'
  return 'crypto'
}

const CAT_CONFIG: Record<DisplayCat, {
  label: string; icon: string; color: string
  bg: string; border: string
}> = {
  crypto:    { label: 'Crypto',          icon: '₿', color: '#6366f1', bg: 'from-indigo-900/40 to-indigo-950/20', border: 'border-indigo-800/50' },
  equity:    { label: 'Equity',          icon: '◈', color: '#a855f7', bg: 'from-purple-900/40 to-purple-950/20', border: 'border-purple-800/50' },
  commodity: { label: 'Commodity & ETF', icon: '◆', color: '#f59e0b', bg: 'from-amber-900/40  to-amber-950/20', border: 'border-amber-800/50' },
  bond:      { label: 'Bond',            icon: '◉', color: '#10b981', bg: 'from-emerald-900/40 to-emerald-950/20', border: 'border-emerald-800/50' },
}

const PIE_COLORS = DISPLAY_CATS.map(c => CAT_CONFIG[c].color)

// ── Types ─────────────────────────────────────────────────────────────────────

interface PosRow {
  id:            bigint
  asset:         string
  isLong:        boolean
  entryPrice:    bigint   // 18-dec
  margin:        bigint   // 18-dec USDC
  leverage:      bigint
  unrealizedPnL: bigint   // signed int256 as bigint, 18-dec
  oraclePrice18: bigint   // oracle current price converted to 18-dec
}

// ── Derived per-position ──────────────────────────────────────────────────────

interface DerivedRow extends PosRow {
  notional:      bigint   // margin × leverage, 18-dec
  quantity:      bigint   // notional × 1e18 / entryPrice, 18-dec asset units
  currentPrice18: bigint  // live or oracle, 18-dec
  holdingsValue: bigint   // quantity × currentPrice18 / 1e18, 18-dec USDC
  livePnL:       bigint   // (currentPrice - entryPrice) × quantity / 1e18 × dir, 18-dec
}

function deriveRow(pos: PosRow, livePrices: Record<string, LivePrice>): DerivedRow {
  const notional = pos.margin * pos.leverage
  const quantity = pos.entryPrice > 0n
    ? (notional * 10n ** 18n) / pos.entryPrice
    : 0n

  const liveUsd = livePrices[pos.asset]?.usd
  const currentPrice18 = liveUsd
    ? BigInt(Math.floor(liveUsd * 1e10))
    : pos.oraclePrice18

  const holdingsValue = (quantity * currentPrice18) / 10n ** 18n

  const priceDiff = currentPrice18 - pos.entryPrice
  const livePnL = pos.isLong
    ? (priceDiff * quantity) / 10n ** 18n
    : (-priceDiff * quantity) / 10n ** 18n

  return { ...pos, notional, quantity, currentPrice18, holdingsValue, livePnL }
}

// ── Formatters ────────────────────────────────────────────────────────────────

const fUsd = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fUsdFloat = (v: number) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fPnL = (v: bigint) => {
  const n = Number(v) / 1e18
  return (n >= 0 ? '+' : '') + n.toFixed(2)
}

const fPct = (pnl: bigint, notional: bigint): string => {
  if (notional === 0n) return '0.00%'
  const pct = (Number(pnl) / Number(notional)) * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
}

const fQty = (qty: bigint, assetId: string): string => {
  const n = Number(qty) / 1e18
  const cat = ASSET_META[assetId]?.category
  if (cat === 'crypto') return n.toPrecision(4)
  return n.toFixed(2)
}

const pnlColor = (v: bigint) => Number(v) >= 0 ? 'text-green-400' : 'text-red-400'

const fNotional = (n: bigint) => {
  const v = Number(n) / 1e18
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

const timeAgo = (ts: number): string => {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 120)   return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const ESG_TIER = (score: number): { name: string; color: string } => {
  if (score >= 80) return { name: 'ESG Champion',           color: '#34d399' }
  if (score >= 60) return { name: 'ESG Aware',              color: '#86efac' }
  return                  { name: 'Consider greener assets', color: '#fbbf24' }
}

const ESG_COMMENT = (score: number): string => {
  if (score >= 80) return '投資組合符合高標準 ESG 準則，表現優異 🌱'
  if (score >= 65) return '投資組合 ESG 表現良好，仍有進一步優化空間'
  if (score >= 50) return '部分持倉 ESG 評級偏低，建議調整資產配置'
  return '投資組合 ESG 風險較高，請考慮改善整體配置'
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { wallet: WalletAPI; whaleAlerts?: WhaleAlert[] }

export default function DashboardPage({ wallet, whaleAlerts = [] }: Props) {
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const livePrices = useLivePrices()
  const esg        = useESG(contracts?.esgRegistry ?? null)
  const { history: priceHistory } = usePriceHistory(
    contracts?.oracle ?? null,
    wallet.provider,
    TREND_ASSET_IDS,
    livePrices,
  )

  const [positions,  setPositions]  = useState<PosRow[]>([])
  const [freeMargin, setFreeMargin] = useState<bigint>(0n)
  const [isLoading,  setIsLoading]  = useState(false)
  const [isLoaded,   setIsLoaded]   = useState(false)

  const [enabled, setEnabled] = useState<Set<string>>(new Set(TREND_ASSET_IDS))
  const toggleAsset = (id: string) =>
    setEnabled(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    setIsLoading(true)
    try {
      const [posIds, fmRaw] = await Promise.all([
        contracts.exchange.getUserPositions(wallet.address),
        contracts.exchange.freeMargin(wallet.address),
      ])
      setFreeMargin(fmRaw as bigint)

      const rows = await Promise.all(
        (posIds as bigint[]).map(async (id): Promise<PosRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as {
              asset: string; isLong: boolean; isOpen: boolean
              entryPrice: bigint; margin: bigint; leverage: bigint
            }
            if (!raw.isOpen) return null
            const [pnlRaw, priceRaw] = await Promise.all([
              contracts.exchange.getUnrealizedPnL(id),
              contracts.oracle.getPrice(raw.asset),
            ])
            const price8 = (priceRaw as [bigint, bigint])[0]
            return {
              id, asset: raw.asset, isLong: raw.isLong,
              entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
              unrealizedPnL: pnlRaw as bigint,
              oraclePrice18: price8 * 10n ** 10n,
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

  useEffect(() => { void fetchAll() }, [fetchAll])

  // ── Derived: live-updated from livePrices tick ────────────────────────────

  const derived = useMemo(() => {
    const rows = positions.map(p => deriveRow(p, livePrices))
    const totalHoldings = rows.reduce((s, r) => s + r.holdingsValue, 0n)
    const totalPnL      = rows.reduce((s, r) => s + r.livePnL,      0n)
    const totalMargin   = rows.reduce((s, r) => s + r.margin,        0n)
    const totalNotional = rows.reduce((s, r) => s + r.notional,      0n)
    return { rows, totalHoldings, totalPnL, totalMargin, totalNotional }
  }, [positions, livePrices])

  // ── Category breakdown ────────────────────────────────────────────────────

  const catSummary = useMemo(() => {
    const out: Record<DisplayCat, { value: bigint; pnl: bigint; symbols: string[] }> = {
      crypto:    { value: 0n, pnl: 0n, symbols: [] },
      equity:    { value: 0n, pnl: 0n, symbols: [] },
      commodity: { value: 0n, pnl: 0n, symbols: [] },
      bond:      { value: 0n, pnl: 0n, symbols: [] },
    }
    for (const row of derived.rows) {
      const dcat = displayCatOf(row.asset)
      out[dcat].value += row.holdingsValue
      out[dcat].pnl   += row.livePnL
      const sym = ASSET_META[row.asset]?.symbol ?? '?'
      if (!out[dcat].symbols.includes(sym)) out[dcat].symbols.push(sym)
    }
    return out
  }, [derived.rows])

  // ── Pie data ──────────────────────────────────────────────────────────────

  const pieData = useMemo(
    () =>
      DISPLAY_CATS
        .filter(c => catSummary[c].value > 0n)
        .map(c => ({
          name:    CAT_CONFIG[c].label,
          value:   Number(catSummary[c].value) / 1e18,
          dcat:    c,
        })),
    [catSummary],
  )

  // ── ESG composite ─────────────────────────────────────────────────────────

  const portfolioESG = useMemo(() => {
    if (derived.rows.length === 0) return null
    let totalVal = 0; let wavg = 0
    for (const row of derived.rows) {
      const info = esg[row.asset]
      if (!info) return null
      const val = Number(row.holdingsValue) / 1e18
      totalVal += val
      wavg     += info.composite * val
    }
    if (totalVal === 0) return null
    const composite = Math.round(wavg / totalVal)
    const rating =
      composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' :
      composite >= 60 ? 'A'   : composite >= 50 ? 'BBB' : 'CCC'
    return { composite, rating }
  }, [derived.rows, esg])

  // ── Trend chart data ──────────────────────────────────────────────────────

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

  const pnlPctStr = derived.totalNotional > 0n
    ? fPct(derived.totalPnL, derived.totalNotional) : '—'

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Portfolio Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">持倉現值 · 四類收益 · 配置佔比 · ESG 評分 · 趨勢走勢</p>
        </div>
        <button
          onClick={() => void fetchAll()}
          disabled={isLoading}
          className="text-xs text-gray-500 hover:text-white disabled:opacity-40 transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {/* ── A. 頂部總覽 ───────────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: '總資產現值',
            value: isLoaded ? fUsd(derived.totalHoldings) : '—',
            sub:   '所有持倉 notional 現值',
            cls:   'text-white',
          },
          {
            label: '未實現損益',
            value: isLoaded ? `${fPnL(derived.totalPnL)} USDC` : '—',
            sub:   pnlPctStr,
            cls:   isLoaded ? pnlColor(derived.totalPnL) : 'text-white',
          },
          {
            label: '可用餘額',
            value: isLoaded ? fUsd(freeMargin) : '—',
            sub:   'Free Margin',
            cls:   'text-white',
          },
          {
            label: 'ESG 評分',
            value: portfolioESG ? `${portfolioESG.composite}` : '—',
            sub:   portfolioESG ? ESG_TIER(portfolioESG.composite).name : 'no positions',
            cls:   portfolioESG ? '' : 'text-gray-500',
            style: portfolioESG ? { color: ESG_TIER(portfolioESG.composite).color } as React.CSSProperties : undefined,
          },
        ].map(({ label, value, sub, cls, style }) => (
          <div key={label} className="rounded-card border border-surface-border bg-surface shadow-card p-4 space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
            {isLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <p className={`text-lg font-bold font-mono ${cls}`} style={style}>{value}</p>
            )}
            <p className="text-[11px] text-gray-600">{sub}</p>
          </div>
        ))}
      </section>

      {/* ── B. 四類資產收益卡 (2×2) ──────────────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">B · 四類資產收益</h2>
        <div className="grid grid-cols-2 gap-4">
          {DISPLAY_CATS.map(cat => {
            const cfg = CAT_CONFIG[cat]
            const s   = catSummary[cat]
            const cnt = s.symbols.length
            return (
              <div key={cat} className={`rounded-card border ${cfg.border} bg-gradient-to-br ${cfg.bg} p-5 space-y-3`}>
                <div className="flex items-center gap-2">
                  <span className="text-xl">{cfg.icon}</span>
                  <span className="font-semibold text-white">{cfg.label}</span>
                  <span className="ml-auto text-xs text-gray-500">{cnt} asset{cnt !== 1 ? 's' : ''}</span>
                </div>
                {isLoading ? (
                  <div className="space-y-2"><Skeleton className="h-5 w-28" /><Skeleton className="h-3 w-20" /></div>
                ) : cnt === 0 ? (
                  <p className="text-sm text-gray-600 italic">No positions</p>
                ) : (
                  <>
                    <div>
                      <p className="text-2xl font-bold font-mono text-white">{fUsd(s.value)}</p>
                      <p className={`text-sm font-semibold font-mono mt-0.5 ${pnlColor(s.pnl)}`}>
                        {fPnL(s.pnl)} USDC
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {s.symbols.map(sym => (
                        <span
                          key={sym}
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
                          style={{ borderColor: cfg.color + '60', color: cfg.color, background: cfg.color + '15' }}
                        >
                          {sym}
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

      {/* ── Whale Activity ────────────────────────────────────────────────────── */}
      {whaleAlerts.length > 0 && (
        <section className="rounded-card border border-cyan-900/60 bg-cyan-950/20 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-cyan-300 uppercase tracking-wider flex items-center gap-2">
              🐋 Whale Activity
              <span className="text-xs font-normal text-cyan-600 normal-case">≥ $5k notional</span>
            </h2>
            <Link to="/whale" className="text-xs text-cyan-600 hover:text-cyan-300 transition-colors">
              Open Whale Tracker →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-600 border-b border-surface-border">
                  {['Address','Asset','Side','Notional','Time'].map(h => (
                    <th key={h} className={`pb-2 pr-4 font-medium ${h === 'Notional' || h === 'Time' ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border/50">
                {whaleAlerts.slice(0, 8).map(a => (
                  <tr key={a.txHash} className="hover:bg-cyan-950/20 transition-colors">
                    <td className="py-1.5 pr-4">
                      <Link to={`/whale?addr=${a.owner}`} className="font-mono text-cyan-400 hover:text-white transition-colors hover:underline">
                        {shortAddr(a.owner)}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 text-gray-300">{a.assetLabel}</td>
                    <td className="py-1.5 pr-4">
                      <span className={`font-semibold ${a.isLong ? 'text-green-400' : 'text-red-400'}`}>
                        {a.isLong ? 'LONG' : 'SHORT'} {String(a.leverage)}×
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono font-semibold text-white">{fNotional(a.notional)}</td>
                    <td className="py-1.5 text-right text-gray-500">{timeAgo(a.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── C. 資產配置圓餅圖 + E. ESG 組合評分 ─────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">

        {/* C. Pie chart */}
        <section className="md:col-span-2 rounded-card border border-surface-border bg-surface p-5">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">C · 資產配置佔比</h2>
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
                  data={pieData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={3}
                >
                  {pieData.map(entry => (
                    <Cell key={entry.dcat} fill={PIE_COLORS[DISPLAY_CATS.indexOf(entry.dcat as DisplayCat)]} />
                  ))}
                </Pie>
                <PieTooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) => [fUsdFloat(value as number), '']}
                />
                <Legend
                  iconType="circle" iconSize={8}
                  formatter={value => <span style={{ color: '#9ca3af', fontSize: 12 }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* E. ESG composite */}
        <section className="md:col-span-3 rounded-card border border-surface-border bg-surface p-5 space-y-4">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">E · ESG 組合評分</h2>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-32" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" />
            </div>
          ) : !portfolioESG ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-600 text-sm text-center gap-2">
              <span className="text-3xl opacity-30">🌱</span>
              <p>{derived.rows.length === 0 ? '開倉後顯示 ESG 評分' : 'ESG 資料載入中…'}</p>
            </div>
          ) : (
            <>
              <div className="flex items-end gap-4">
                <div>
                  <p className="text-5xl font-extrabold font-mono" style={{ color: ESG_TIER(portfolioESG.composite).color }}>
                    {portfolioESG.composite}
                  </p>
                  <p className="text-sm font-bold mt-1" style={{ color: ESG_TIER(portfolioESG.composite).color }}>
                    {ESG_TIER(portfolioESG.composite).name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">加權平均 ESG 評分</p>
                </div>
                <div className="pb-1">
                  <span
                    className="inline-flex items-center rounded-full px-3 py-1 text-sm font-bold border"
                    style={{
                      background:   portfolioESG.composite >= 65 ? '#064e3b' : portfolioESG.composite >= 50 ? '#451a03' : '#450a0a',
                      borderColor:  portfolioESG.composite >= 65 ? '#10b981' : portfolioESG.composite >= 50 ? '#f59e0b' : '#ef4444',
                      color:        portfolioESG.composite >= 65 ? '#6ee7b7' : portfolioESG.composite >= 50 ? '#fde68a' : '#fca5a5',
                    }}
                  >
                    {portfolioESG.rating}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width:      `${portfolioESG.composite}%`,
                      background: portfolioESG.composite >= 65 ? '#10b981' : portfolioESG.composite >= 50 ? '#f59e0b' : '#ef4444',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-gray-600">
                  <span>0</span><span>50</span><span>100</span>
                </div>
              </div>

              <p className="text-sm text-gray-300">{ESG_COMMENT(portfolioESG.composite)}</p>

              <div className="space-y-1.5 pt-1">
                {derived.rows.map(row => {
                  const info = esg[row.asset]
                  if (!info) return null
                  const sym = ASSET_META[row.asset]?.symbol ?? '?'
                  return (
                    <div key={`${row.asset}-${String(row.id)}`} className="flex items-center gap-3 text-xs">
                      <span className="w-14 text-gray-400 shrink-0 font-mono">{sym}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width:      `${info.composite}%`,
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

      {/* ── D. 持倉明細表 ─────────────────────────────────────────────────────── */}
      <section className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">D · 持倉明細</h2>
          <span className="text-xs text-gray-600">{derived.rows.length} open position{derived.rows.length !== 1 ? 's' : ''}</span>
        </div>

        {isLoading ? (
          <div className="p-5 space-y-3">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : derived.rows.length === 0 ? (
          <div className="py-16 text-center text-gray-600 text-sm space-y-2">
            <span className="text-3xl block opacity-30">◑</span>
            <p>尚未開倉，前往 <Link to="/exchange" className="text-emerald-500 hover:underline">Exchange</Link> 開設第一個倉位</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                  {['資產','多/空','持有數量','平均成本','現價','持倉現值','損益','ESG'].map(h => (
                    <th key={h} className={`px-4 py-3 font-medium whitespace-nowrap ${h === '損益' || h === '持倉現值' ? 'text-right' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {derived.rows.map(row => {
                  const meta = ASSET_META[row.asset]
                  const info = esg[row.asset]
                  const pnlPctRow = fPct(row.livePnL, row.notional)
                  return (
                    <tr key={String(row.id)} className="hover:bg-surface-elev/60 transition-colors">
                      {/* 資產 */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{meta?.icon ?? '?'}</span>
                          <div>
                            <p className="font-mono font-bold text-white text-sm">{meta?.symbol ?? row.asset.slice(0, 8)}</p>
                            <p className="text-[10px] text-gray-600 leading-none">{meta?.category?.toUpperCase()}</p>
                          </div>
                        </div>
                      </td>
                      {/* 多/空 */}
                      <td className="px-4 py-3">
                        <span className={`font-bold text-xs ${row.isLong ? 'text-green-400' : 'text-red-400'}`}>
                          {row.isLong ? 'LONG' : 'SHORT'} {String(row.leverage)}×
                        </span>
                      </td>
                      {/* 持有數量 */}
                      <td className="px-4 py-3 font-mono text-gray-300 tabular-nums">
                        {fQty(row.quantity, row.asset)}
                        <span className="text-[10px] text-gray-600 ml-1">{meta?.symbol?.replace(/^s/, '') ?? ''}</span>
                      </td>
                      {/* 平均成本 */}
                      <td className="px-4 py-3 font-mono text-gray-400 tabular-nums">
                        {fUsdFloat(Number(row.entryPrice) / 1e18)}
                      </td>
                      {/* 現價 */}
                      <td className="px-4 py-3 font-mono text-white tabular-nums">
                        {fUsdFloat(Number(row.currentPrice18) / 1e18)}
                        {livePrices[row.asset]?.isMock && (
                          <span className="text-[10px] text-gray-600 ml-1">~</span>
                        )}
                      </td>
                      {/* 持倉現值 */}
                      <td className="px-4 py-3 font-mono text-white tabular-nums text-right">
                        {fUsd(row.holdingsValue)}
                      </td>
                      {/* 損益 */}
                      <td className={`px-4 py-3 font-mono tabular-nums text-right ${pnlColor(row.livePnL)}`}>
                        <div className="font-semibold">{fPnL(row.livePnL)}</div>
                        <div className="text-[10px] opacity-70">{pnlPctRow}</div>
                      </td>
                      {/* ESG badge */}
                      <td className="px-4 py-3">
                        {info
                          ? <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                          : <span className="text-gray-700 text-xs">—</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {/* Footer: totals */}
              {derived.rows.length > 1 && (
                <tfoot>
                  <tr className="border-t border-surface-border text-xs text-gray-400">
                    <td colSpan={5} className="px-4 py-3 font-semibold">Total</td>
                    <td className="px-4 py-3 font-mono font-bold text-white text-right tabular-nums">{fUsd(derived.totalHoldings)}</td>
                    <td className={`px-4 py-3 font-mono font-bold text-right tabular-nums ${pnlColor(derived.totalPnL)}`}>
                      <div>{fPnL(derived.totalPnL)}</div>
                      <div className="text-[10px] opacity-70">{pnlPctStr}</div>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </section>

      {/* ── F. 四資產趨勢圖 ───────────────────────────────────────────────────── */}
      <section className="rounded-card border border-surface-border bg-surface p-5 space-y-4">
        <div className="flex items-center flex-wrap gap-3 justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">F · 四資產趨勢（% 變化）</h2>
          <div className="flex flex-wrap gap-2">
            {TREND_ASSET_IDS.map(id => {
              const sym = ASSET_META[id]?.symbol ?? id.slice(0, 6)
              return (
                <button
                  key={id}
                  onClick={() => toggleAsset(id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    enabled.has(id)
                      ? 'border-transparent text-white'
                      : 'border-gray-700 text-gray-600 bg-transparent'
                  }`}
                  style={enabled.has(id)
                    ? { background: TREND_COLORS[id] + '30', borderColor: TREND_COLORS[id] + '80', color: TREND_COLORS[id] }
                    : {}}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: TREND_COLORS[id] }} />
                  {sym}
                </button>
              )
            })}
          </div>
        </div>

        {chartData.length < 2 ? (
          <div className="flex flex-col items-center justify-center h-52 text-gray-600 text-sm text-center gap-2">
            <span className="text-3xl opacity-30">📈</span>
            <p>趨勢資料累積中…</p>
            <p className="text-xs text-gray-700">每次載入頁面記錄一個快照，幾分鐘後即可看到走勢</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} interval="preserveStartEnd" />
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
                  ASSET_META[name as string]?.symbol ?? (name as string),
                ]}
              />
              {TREND_ASSET_IDS.filter(id => enabled.has(id)).map(id => (
                <Line
                  key={id} type="monotone" dataKey={id}
                  stroke={TREND_COLORS[id]} dot={false} strokeWidth={1.5} connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

    </div>
  )
}
