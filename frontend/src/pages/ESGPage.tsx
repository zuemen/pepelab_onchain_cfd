import { useState, useMemo } from 'react'
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip as RadarTooltip,
} from 'recharts'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useESG } from '../hooks/useESG'
import { ASSET_IDS } from '../contracts/addresses'
import { ASSET_META } from '../lib/assetMeta'
import ESGBadge from '../components/ESGBadge'
import Skeleton from '../components/Skeleton'

// ── All 11 asset IDs ──────────────────────────────────────────────────────────

const ALL_ASSET_IDS = [
  ASSET_IDS.sBTC,  ASSET_IDS.sETH,   ASSET_IDS.sAAPL, ASSET_IDS.sTSLA,
  ASSET_IDS.sGOLD, ASSET_IDS.sBOND,  ASSET_IDS.sNVDA, ASSET_IDS.sMSFT,
  ASSET_IDS.sGOOGL,ASSET_IDS.sICLN,  ASSET_IDS.sESGU,
]

// ── Rating table (7 tiers, AAA → CCC) ────────────────────────────────────────

const RATING_TABLE = [
  { rating: 'AAA', min: 80,  label: 'ESG Champion',    desc: 'Best-in-class across all three dimensions',              color: '#34d399', bg: '#064e3b' },
  { rating: 'AA',  min: 70,  label: 'ESG Leader',      desc: 'Strong, consistent performance across E, S, and G',      color: '#86efac', bg: '#052e16' },
  { rating: 'A',   min: 60,  label: 'ESG Aware',       desc: 'Above-average; room for improvement in one dimension',   color: '#bef264', bg: '#1a2e05' },
  { rating: 'BBB', min: 50,  label: 'Satisfactory',    desc: 'Meets baseline standards; notable gaps remain',          color: '#fde047', bg: '#422006' },
  { rating: 'BB',  min: 40,  label: 'Developing',      desc: 'Below average; improvement initiatives underway',        color: '#fbbf24', bg: '#431407' },
  { rating: 'B',   min: 30,  label: 'Below Standard',  desc: 'Significant ESG risks not yet adequately managed',       color: '#f97316', bg: '#431407' },
  { rating: 'CCC', min: 0,   label: 'High Risk',       desc: 'Material ESG concerns with limited mitigation evidence', color: '#f87171', bg: '#450a0a' },
]

// ── One-line rationale per asset ──────────────────────────────────────────────

const ESG_RATIONALE: Record<string, string> = {
  [ASSET_IDS.sBTC]:   'Proof-of-work energy intensity dominates an otherwise permissionless, decentralized governance model.',
  [ASSET_IDS.sETH]:   'The PoS Merge cut energy use 99.95%; transparent on-chain governance and an inclusive developer culture lift all dimensions.',
  [ASSET_IDS.sAAPL]:  'Carbon-neutrality supply chain commitment and strong board independence; minor labour concerns in manufacturing cap the S score.',
  [ASSET_IDS.sTSLA]:  'EV mission drives E above industry average; CEO governance controversy and workforce-relations incidents weigh on S and G.',
  [ASSET_IDS.sGOLD]:  'Mining causes significant land disruption and CO₂; adoption of Responsible Mining standards remains uneven across producers.',
  [ASSET_IDS.sBOND]:  'US Treasuries carry no direct environmental impact and are backed by top-tier sovereign governance and social-stability mandates.',
  [ASSET_IDS.sNVDA]:  'Data-center GPU power demand is high, offset by an AI-efficiency roadmap; semiconductor-industry governance standards are above average.',
  [ASSET_IDS.sMSFT]:  'Carbon-negative pledge, 100 % renewable electricity target, and robust board governance deliver near-champion ESG performance.',
  [ASSET_IDS.sGOOGL]: "World's largest corporate renewable-energy buyer (E↑); antitrust investigations and data-privacy controversies moderately restrain S and G.",
  [ASSET_IDS.sICLN]:  'Tracks global clean-energy producers; near-perfect E score; land use and grid-stability considerations create nuanced social exposure.',
  [ASSET_IDS.sESGU]:  'Broad MSCI USA ESG-screened index delivers top-quartile performance across all three dimensions with strong sector diversification.',
}

// ── Radar accent color per asset ──────────────────────────────────────────────

const RADAR_COLOR: Record<string, string> = {
  [ASSET_IDS.sBTC]:   '#f7931a',
  [ASSET_IDS.sETH]:   '#627eea',
  [ASSET_IDS.sAAPL]:  '#a2aaad',
  [ASSET_IDS.sTSLA]:  '#cc0000',
  [ASSET_IDS.sGOLD]:  '#ffd700',
  [ASSET_IDS.sBOND]:  '#10b981',
  [ASSET_IDS.sNVDA]:  '#76b900',
  [ASSET_IDS.sMSFT]:  '#00a4ef',
  [ASSET_IDS.sGOOGL]: '#ea4335',
  [ASSET_IDS.sICLN]:  '#00c853',
  [ASSET_IDS.sESGU]:  '#2e7d32',
}

// ── Category badge style ──────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  crypto:    'bg-indigo-900/50 text-indigo-300 border-indigo-700',
  equity:    'bg-purple-900/50 text-purple-300 border-purple-700',
  commodity: 'bg-amber-900/50  text-amber-300  border-amber-700',
  etf:       'bg-teal-900/50   text-teal-300   border-teal-700',
  bond:      'bg-emerald-900/50 text-emerald-300 border-emerald-700',
}

// ── Bar color by score ("綠/黃/紅 按分數") ───────────────────────────────────

const barColor = (score: number) =>
  score >= 65 ? '#4ade80' :
  score >= 40 ? '#fbbf24' : '#f87171'

// ── Dimension config ──────────────────────────────────────────────────────────

const DIMS = [
  { key: 'environmental' as const, short: 'E', label: 'Environmental' },
  { key: 'social'        as const, short: 'S', label: 'Social'        },
  { key: 'governance'    as const, short: 'G', label: 'Governance'    },
]

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { wallet: WalletAPI }

export default function ESGPage({ wallet }: Props) {
  const contracts   = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const esg         = useESG(contracts?.esgRegistry ?? null)
  const [selected, setSelected] = useState<string>(ASSET_IDS.sESGU)

  const isLoading = !wallet.isConnected || Object.keys(esg).length === 0

  // Sort all 11 assets by composite (highest → lowest); unrated go to end
  const sorted = useMemo(
    () =>
      [...ALL_ASSET_IDS].sort((a, b) => {
        const ca = esg[a]?.composite ?? -1
        const cb = esg[b]?.composite ?? -1
        return cb - ca
      }),
    [esg],
  )

  const selInfo  = esg[selected]
  const selMeta  = ASSET_META[selected]
  const selColor = RADAR_COLOR[selected] ?? '#6366f1'

  const radarData = selInfo
    ? DIMS.map(d => ({ subject: d.label, value: selInfo[d.key], fullMark: 100 }))
    : []

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          🌱 ESG Asset Explorer
        </h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Environmental · Social · Governance — 11 synthetic assets, on-chain registry
        </p>
      </div>

      {!wallet.isConnected && (
        <div className="rounded-lg border border-surface-border bg-surface px-4 py-2 text-xs text-gray-500">
          Connect wallet to load live ESG scores from the on-chain ESGRegistry.
        </div>
      )}
      {wallet.isConnected && wallet.chainId !== 11155111 && (
        <div className="rounded-lg border border-yellow-800 bg-yellow-950/30 px-4 py-2 text-xs text-yellow-400">
          ESGRegistry is only deployed on Sepolia. Connect to Sepolia to see live on-chain scores.
        </div>
      )}

      {/* ── A. Methodology ───────────────────────────────────────────────────── */}
      <section className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-5">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">A · ESG 評分方法論</h2>

        {/* Three dimensions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              short: 'E', color: '#4ade80', label: 'Environmental',
              zh: '環境',
              items: ['Carbon footprint & energy mix', 'Physical climate risk', 'Land / water use impact', 'Waste & emission management'],
            },
            {
              short: 'S', color: '#60a5fa', label: 'Social',
              zh: '社會',
              items: ['Labour practices & worker safety', 'Community & stakeholder impact', 'Data privacy & security', 'Supply chain responsibility'],
            },
            {
              short: 'G', color: '#a78bfa', label: 'Governance',
              zh: '治理',
              items: ['Board independence & diversity', 'Executive accountability', 'Disclosure & transparency', 'Shareholder rights protection'],
            },
          ].map(({ short, color, label, zh, items }) => (
            <div key={short} className="rounded-lg border border-surface-border p-4 space-y-2"
              style={{ borderColor: color + '40', background: color + '08' }}>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-extrabold font-mono" style={{ color }}>{short}</span>
                <span className="text-sm font-semibold text-white">{label}</span>
                <span className="text-xs text-gray-500">{zh}</span>
              </div>
              <ul className="space-y-0.5">
                {items.map(item => (
                  <li key={item} className="text-xs text-gray-400 flex items-start gap-1.5">
                    <span style={{ color }} className="mt-0.5 shrink-0">·</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Rating table */}
        <div>
          <p className="text-xs text-gray-500 font-semibold mb-2 uppercase tracking-wide">七級評級對照表</p>
          <div className="grid grid-cols-2 md:grid-cols-7 gap-1.5">
            {RATING_TABLE.map(({ rating, min, label, desc, color, bg }) => (
              <div
                key={rating}
                className="rounded-lg p-2.5 space-y-1 text-center border"
                style={{ background: bg, borderColor: color + '50' }}
              >
                <p className="text-base font-extrabold font-mono" style={{ color }}>{rating}</p>
                <p className="text-[10px] font-semibold" style={{ color }}>{label}</p>
                <p className="text-[9px] text-gray-500 leading-tight">{min > 0 ? `≥ ${min}` : '< 30'}</p>
                <p className="text-[9px] text-gray-600 leading-tight hidden md:block">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── B (left) + C (right) ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">

        {/* B. 11-asset ranking (sorted by composite) */}
        <section className="lg:col-span-3 space-y-2">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            B · 11 資產 ESG 排行（composite 由高到低）
          </h2>

          {sorted.map((id, rank) => {
            const info  = esg[id]
            const meta  = ASSET_META[id]
            const isSel = id === selected

            return (
              <button
                key={id}
                onClick={() => setSelected(id)}
                className={`w-full rounded-card border p-4 text-left transition-all space-y-2.5 ${
                  isSel
                    ? 'border-brand-200/60 bg-brand-400/10 shadow-[0_0_12px_rgba(99,102,241,0.18)]'
                    : 'border-surface-border bg-surface hover:border-gray-600'
                }`}
              >
                {/* Top row: rank + icon + name + composite + badge */}
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-600 font-mono w-5 shrink-0 text-right">#{rank + 1}</span>
                  <span className="text-xl shrink-0">{meta?.icon ?? '?'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono font-bold text-white text-sm">{meta?.symbol ?? '?'}</span>
                      {meta && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium capitalize ${CAT_COLOR[meta.category] ?? ''}`}>
                          {meta.category}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-600 leading-tight truncate max-w-xs">
                      {meta?.name ?? ''}
                    </p>
                  </div>

                  {/* Composite big number */}
                  {isLoading ? (
                    <Skeleton className="h-8 w-10" />
                  ) : info ? (
                    <div className="text-right shrink-0">
                      <p className="text-2xl font-extrabold font-mono leading-none"
                        style={{ color: barColor(info.composite) }}>
                        {info.composite}
                      </p>
                      <p className="text-[10px] text-gray-600">/ 100</p>
                    </div>
                  ) : (
                    <span className="text-gray-600 text-sm">—</span>
                  )}

                  {info && (
                    <div className="shrink-0">
                      <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                    </div>
                  )}
                </div>

                {/* E/S/G bars */}
                {isLoading ? (
                  <div className="space-y-1.5">
                    {DIMS.map(d => <Skeleton key={d.key} className="h-1.5 w-full" />)}
                  </div>
                ) : info ? (
                  <div className="space-y-1">
                    {DIMS.map(({ key, short }) => {
                      const val = info[key]
                      const bc  = barColor(val)
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-[9px] font-bold w-3 shrink-0" style={{ color: bc }}>{short}</span>
                          <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${val}%`, background: bc }} />
                          </div>
                          <span className="text-[10px] font-mono text-gray-500 w-6 text-right tabular-nums">{val}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                {/* Rationale */}
                {ESG_RATIONALE[id] && (
                  <p className="text-[11px] text-gray-500 italic leading-relaxed border-t border-surface-border/60 pt-2">
                    {ESG_RATIONALE[id]}
                  </p>
                )}
              </button>
            )
          })}
        </section>

        {/* C. Radar chart (sticky) */}
        <div className="lg:col-span-2">
          <div className="sticky top-20 space-y-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              C · E/S/G 雷達圖
            </h2>

            <div className="rounded-card border border-surface-border bg-surface p-5 space-y-4">
              {/* Selected asset header */}
              <div className="flex items-center gap-3">
                <span className="text-2xl">{selMeta?.icon ?? '?'}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono font-bold text-white">{selMeta?.symbol ?? '?'}</p>
                  <p className="text-xs text-gray-500 truncate">{selMeta?.name ?? ''}</p>
                </div>
                {selInfo && (
                  <ESGBadge composite={selInfo.composite} rating={selInfo.rating} size="md" />
                )}
              </div>

              {/* RadarChart */}
              {isLoading ? (
                <div className="flex items-center justify-center h-52">
                  <Skeleton className="w-44 h-44 rounded-full" />
                </div>
              ) : radarData.length === 0 ? (
                <div className="flex items-center justify-center h-52 text-gray-600 text-sm">
                  No data — connect wallet on Sepolia
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <RadarChart data={radarData} margin={{ top: 8, right: 28, bottom: 8, left: 28 }}>
                    <PolarGrid stroke="#1f2937" />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 9 }} tickCount={4} />
                    <Radar
                      name={selMeta?.symbol ?? ''}
                      dataKey="value"
                      stroke={selColor}
                      fill={selColor}
                      fillOpacity={0.25}
                      strokeWidth={2}
                    />
                    <RadarTooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      formatter={(value: any) => [value as number, '']}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              )}

              {/* Dimension values */}
              {selInfo && (
                <div className="space-y-1.5 border-t border-surface-border pt-3">
                  {DIMS.map(({ key, short, label }) => {
                    const val = selInfo[key]
                    const bc  = barColor(val)
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <span className="text-xs font-bold w-4 shrink-0" style={{ color: bc }}>{short}</span>
                        <span className="text-xs text-gray-400 w-28 shrink-0">{label}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${val}%`, background: bc }} />
                        </div>
                        <span className="text-xs font-mono font-bold tabular-nums" style={{ color: bc }}>{val}</span>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-3 border-t border-surface-border pt-2 mt-1">
                    <span className="text-xs text-gray-500 w-4" />
                    <span className="text-xs text-gray-500 w-28">Composite</span>
                    <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                      <div className="h-full rounded-full"
                        style={{ width: `${selInfo.composite}%`, background: barColor(selInfo.composite) }} />
                    </div>
                    <span className="text-xs font-mono font-bold tabular-nums"
                      style={{ color: barColor(selInfo.composite) }}>
                      {selInfo.composite}
                    </span>
                  </div>
                </div>
              )}

              {/* Rationale */}
              {ESG_RATIONALE[selected] && (
                <p className="text-xs text-gray-400 italic leading-relaxed border-t border-surface-border pt-3">
                  {ESG_RATIONALE[selected]}
                </p>
              )}

              <p className="text-[10px] text-gray-700 text-center">
                Click any asset card to update the radar
              </p>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
