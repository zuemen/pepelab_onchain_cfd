import { useState } from 'react'
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip as RadarTooltip,
} from 'recharts'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useESG } from '../hooks/useESG'
import { ASSET_IDS } from '../contracts/addresses'
import { ASSET_META, ASSET_LABEL } from '../lib/assetMeta'
import ESGBadge from '../components/ESGBadge'
import Skeleton from '../components/Skeleton'

// ── ESG rationale texts ────────────────────────────────────────────────────────

const ESG_RATIONALE: Partial<Record<string, string>> = {
  [ASSET_IDS.sBTC]:
    'Bitcoin\'s proof-of-work mining is highly energy-intensive (E↓), but its open, permissionless design provides robust decentralised governance (G↑). Energy mix varies by region.',
  [ASSET_IDS.sETH]:
    'The 2022 Merge to proof-of-stake reduced Ethereum\'s energy use by ~99.95% (E↑↑). Transparent on-chain governance and an inclusive developer culture earn high S and G scores.',
  [ASSET_IDS.sAAPL]:
    'Apple targets carbon neutrality across its entire supply chain and maintains strong board governance (G↑). Partial labour-practice concerns in the supply chain keep the S score from being perfect.',
  [ASSET_IDS.sTSLA]:
    'Tesla accelerates EV adoption and renewable energy storage (E↑), but executive governance controversies and workforce-relations issues pull S and G scores below the E dimension.',
  [ASSET_IDS.sGOLD]:
    'Gold mining causes significant land disruption and CO₂ emissions (E↓). Responsible Mining standards are improving but inconsistently adopted across the industry.',
  [ASSET_IDS.sBOND]:
    'US Treasury bonds carry negligible direct environmental impact and are backed by top-tier sovereign governance and social-stability mandates — the highest-scoring ESG asset in this basket.',
}

// ── Asset ordering ─────────────────────────────────────────────────────────────

const ALL_ASSET_IDS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sBOND,
  ASSET_IDS.sAAPL,
  ASSET_IDS.sTSLA,
]

// ── Category badge colors ──────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  crypto:    'bg-indigo-900/50 text-indigo-300 border-indigo-700',
  equity:    'bg-purple-900/50 text-purple-300 border-purple-700',
  commodity: 'bg-amber-900/50  text-amber-300  border-amber-700',
  bond:      'bg-emerald-900/50 text-emerald-300 border-emerald-700',
}

// ── Radar colors per asset ─────────────────────────────────────────────────────

const RADAR_COLOR: Partial<Record<string, string>> = {
  [ASSET_IDS.sBTC]:  '#f7931a',
  [ASSET_IDS.sETH]:  '#627eea',
  [ASSET_IDS.sAAPL]: '#a2aaad',
  [ASSET_IDS.sTSLA]: '#cc0000',
  [ASSET_IDS.sGOLD]: '#ffd700',
  [ASSET_IDS.sBOND]: '#10b981',
}

// ── E/S/G dimension config ─────────────────────────────────────────────────────

const DIM_CONFIG = [
  { key: 'environmental' as const, label: 'E (Environmental)', color: '#4ade80' },
  { key: 'social'        as const, label: 'S (Social)',        color: '#60a5fa' },
  { key: 'governance'    as const, label: 'G (Governance)',    color: '#a78bfa' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const ESG_TIER_LABEL = (score: number) =>
  score >= 80 ? 'ESG Champion' :
  score >= 65 ? 'ESG Leader'   :
  score >= 50 ? 'ESG Aware'    : 'High Risk'

const ESG_TIER_COLOR = (score: number) =>
  score >= 80 ? 'text-emerald-300' :
  score >= 65 ? 'text-lime-300'    :
  score >= 50 ? 'text-yellow-300'  : 'text-red-400'

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { wallet: WalletAPI }

export default function ESGPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const esg       = useESG(contracts?.esgRegistry ?? null)

  const [selected, setSelected] = useState<string>(ASSET_IDS.sETH)

  const isLoading   = Object.keys(esg).length === 0
  const selInfo     = esg[selected]
  const selMeta     = ASSET_META[selected]
  const selColor    = RADAR_COLOR[selected] ?? '#6366f1'

  const radarData = selInfo ? [
    { subject: 'Environmental', value: selInfo.environmental, fullMark: 100 },
    { subject: 'Social',        value: selInfo.social,        fullMark: 100 },
    { subject: 'Governance',    value: selInfo.governance,    fullMark: 100 },
  ] : []

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          🌱 ESG Asset Explorer
        </h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Environmental · Social · Governance scores for all 6 synthetic assets
        </p>
      </div>

      {/* Network note */}
      {wallet.isConnected && wallet.chainId !== 11155111 && (
        <div className="rounded-lg border border-yellow-800 bg-yellow-950/30 px-4 py-2 text-xs text-yellow-400">
          ESGRegistry is only deployed on Sepolia. Connect to Sepolia to see live on-chain scores.
        </div>
      )}

      {!wallet.isConnected && (
        <div className="rounded-lg border border-surface-border bg-surface px-4 py-2 text-xs text-gray-500">
          Connect wallet to load live ESG scores from the on-chain ESGRegistry.
        </div>
      )}

      {/* ── Top: Selected asset detail + RadarChart ─────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Left: Selected asset detail */}
        <div className="rounded-card border border-surface-border bg-surface p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0"
              style={{ background: selColor + '30', border: `1px solid ${selColor}60` }}
            >
              {ASSET_LABEL[selected]?.slice(1, 3) ?? '??'}
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">{ASSET_LABEL[selected]}</h2>
              {selMeta && (
                <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${CAT_COLOR[selMeta.category]}`}>
                  {selMeta.category}
                </span>
              )}
            </div>
            {selInfo && (
              <div className="ml-auto">
                <ESGBadge composite={selInfo.composite} rating={selInfo.rating} size="md" />
              </div>
            )}
          </div>

          {/* E/S/G dimension bars */}
          {isLoading ? (
            <div className="space-y-3">
              {DIM_CONFIG.map(d => <Skeleton key={d.key} className="h-8 w-full" />)}
            </div>
          ) : selInfo ? (
            <div className="space-y-3">
              {DIM_CONFIG.map(({ key, label, color }) => {
                const val = selInfo[key]
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span style={{ color }} className="font-medium">{label}</span>
                      <span className="font-mono text-white font-semibold">{val}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${val}%`, background: color }}
                      />
                    </div>
                  </div>
                )
              })}

              <div className="pt-2 border-t border-surface-border flex items-center justify-between">
                <span className="text-xs text-gray-500">Composite</span>
                <div className="flex items-center gap-2">
                  <span className={`text-base font-extrabold font-mono ${ESG_TIER_COLOR(selInfo.composite)}`}>
                    {selInfo.composite}
                  </span>
                  <span className={`text-xs font-semibold ${ESG_TIER_COLOR(selInfo.composite)}`}>
                    {ESG_TIER_LABEL(selInfo.composite)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-600">No ESG data for this asset.</p>
          )}

          {/* Rationale */}
          {ESG_RATIONALE[selected] && (
            <p className="text-xs text-gray-400 leading-relaxed border-t border-surface-border pt-3">
              {ESG_RATIONALE[selected]}
            </p>
          )}
        </div>

        {/* Right: RadarChart */}
        <div className="rounded-card border border-surface-border bg-surface p-6 flex flex-col">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            E/S/G Radar — {ASSET_LABEL[selected]}
          </h3>
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Skeleton className="w-48 h-48 rounded-full" />
            </div>
          ) : radarData.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
              No data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <RadarChart data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
                <PolarGrid stroke="#1f2937" />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={{ fill: '#9ca3af', fontSize: 11 }}
                />
                <PolarRadiusAxis
                  angle={30}
                  domain={[0, 100]}
                  tick={{ fill: '#6b7280', fontSize: 9 }}
                  tickCount={4}
                />
                <Radar
                  name={ASSET_LABEL[selected]}
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

          <p className="text-[11px] text-gray-600 text-center mt-2">
            Click an asset card below to update the radar chart
          </p>
        </div>
      </div>

      {/* ── Asset summary cards (2×3 grid) ────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          All Assets · Click to compare
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {ALL_ASSET_IDS.map(id => {
            const info  = esg[id]
            const meta  = ASSET_META[id]
            const color = RADAR_COLOR[id] ?? '#6366f1'
            const isSel = id === selected

            return (
              <button
                key={id}
                onClick={() => setSelected(id)}
                className={`rounded-card border p-4 text-left transition-all space-y-3 hover:shadow-card-hover ${
                  isSel
                    ? 'border-brand-200/60 bg-brand-400/10 shadow-[0_0_12px_rgba(99,102,241,0.2)]'
                    : 'border-surface-border bg-surface hover:border-gray-600'
                }`}
              >
                {/* Asset header */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                      style={{ background: color + '30', border: `1px solid ${color}60` }}
                    >
                      {ASSET_LABEL[id]?.slice(1, 3)}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-white leading-tight">{ASSET_LABEL[id]}</p>
                      {meta && (
                        <p className="text-[10px] text-gray-500 capitalize">{meta.category}</p>
                      )}
                    </div>
                  </div>
                  {info && <ESGBadge composite={info.composite} rating={info.rating} size="sm" />}
                </div>

                {/* Mini E/S/G bars */}
                {isLoading ? (
                  <div className="space-y-1.5">
                    {DIM_CONFIG.map(d => <Skeleton key={d.key} className="h-1.5 w-full" />)}
                  </div>
                ) : info ? (
                  <div className="space-y-1.5">
                    {DIM_CONFIG.map(({ key, label, color: dimColor }) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-[9px] w-3 font-bold" style={{ color: dimColor }}>
                          {label[0]}
                        </span>
                        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${info[key]}%`, background: dimColor }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-gray-500 w-6 text-right">
                          {info[key]}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-600">—</p>
                )}

                {/* Composite tier label */}
                {info && (
                  <p className={`text-[11px] font-semibold ${ESG_TIER_COLOR(info.composite)}`}>
                    {ESG_TIER_LABEL(info.composite)}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Methodology note ──────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-surface-border bg-surface-sub px-4 py-3 text-xs text-gray-500 space-y-1">
        <p className="font-semibold text-gray-400">ESG Methodology</p>
        <p>Scores (0–100) are stored on-chain in the ESGRegistry contract. E = Environmental impact, S = Social responsibility, G = Governance quality. Composite = arithmetic average of E/S/G.</p>
        <p>Ratings: AAA (≥80) · AA (≥70) · A (≥60) · BBB (≥50) · CCC (&lt;50). All scores are for educational demo purposes only.</p>
      </div>
    </div>
  )
}
