import { useState, useEffect, useCallback } from 'react'
import { parseEther } from 'ethers'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { ASSET_IDS } from '../contracts/addresses'
import StatCard from '../components/StatCard'

// ── Config ──────────────────────────────────────────────────────────────────
const ASSET_LABEL: Record<string, string> = {
  [ASSET_IDS.sBTC]:  'sBTC',
  [ASSET_IDS.sETH]:  'sETH',
  [ASSET_IDS.sAAPL]: 'sAAPL',
  [ASSET_IDS.sTSLA]: 'sTSLA',
}

const SHORT_ADDR = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// ── Types ────────────────────────────────────────────────────────────────────
interface RawCopyRecord {
  trader:        string
  versionId:     bigint
  initialAmount: bigint
  positionIds:   bigint[]
  copiedAt:      bigint
  active:        boolean
}

interface RawPos {
  asset:       string
  isLong:      boolean
  isOpen:      boolean
  entryPrice:  bigint
  margin:      bigint
  leverage:    bigint
  copiedFrom:  string
}

interface CopyRec {
  index:         number    // index in getCopyRecords — used for unfollowAndCloseAll
  trader:        string
  traderName:    string
  initialAmount: bigint    // 18-dec
  copiedAt:      bigint
  currentValue:  bigint    // sum of getPositionValue for all positionIds
}

interface PosRow {
  id:            bigint
  asset:         string
  isLong:        boolean
  entryPrice:    bigint    // 18-dec
  currentPrice:  bigint    // 18-dec
  margin:        bigint    // 18-dec
  leverage:      bigint
  unrealizedPnL: bigint    // signed 18-dec
  currentValue:  bigint    // 18-dec ≥ 0
  copiedFrom:    string    // address(0) for self-opened
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f18   = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd  = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
const fDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
const fPnL      = (v: bigint) => (Number(v) >= 0 ? '+' : '') + f18(v, 4) + ' USDC'
const pnlColor  = (v: bigint) => Number(v) >= 0 ? 'text-green-400' : 'text-red-400'
const returnPct = (initial: bigint, current: bigint): string => {
  if (initial === 0n) return '—'
  const pct = ((Number(current) - Number(initial)) / Number(initial)) * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
}
const returnColor = (initial: bigint, current: bigint) =>
  current >= initial ? 'text-green-400' : 'text-red-400'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

const tryParse = (s: string): bigint | null => {
  if (!s) return null
  try { return parseEther(s) } catch { return null }
}

// ── Component ────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function PortfolioPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [copyRecs,   setCopyRecs]   = useState<CopyRec[]>([])
  const [positions,  setPositions]  = useState<PosRow[]>([])
  const [freeMargin, setFreeMargin] = useState(0n)
  const [withdrawAmt, setWithdrawAmt] = useState('')

  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const addr = wallet.address

      // ── A: Copy records ───────────────────────────────────────────────────
      const rawRecs = (await contracts.copyTracker.getCopyRecords(addr)) as unknown as RawCopyRecord[]

      // Unique trader addresses → display names
      const uniqueTraders = [...new Set(rawRecs.map(r => r.trader))]
      const nameMap: Record<string, string> = {}
      await Promise.all(
        uniqueTraders.map(async ta => {
          try {
            const t = (await contracts.registry.traders(ta)) as unknown as [boolean, string, bigint]
            nameMap[ta] = t[1]
          } catch { nameMap[ta] = '' }
        }),
      )

      // Safe wrapper for getPositionValue (closed position may revert)
      const getVal = async (id: bigint): Promise<bigint> => {
        try { return (await contracts.exchange.getPositionValue(id)) as bigint }
        catch { return 0n }
      }

      const enriched = await Promise.all(
        rawRecs.map(async (rec, i): Promise<CopyRec | null> => {
          if (!rec.active) return null
          const vals = await Promise.all(rec.positionIds.map(id => getVal(id)))
          return {
            index:         i,
            trader:        rec.trader,
            traderName:    nameMap[rec.trader] ?? '',
            initialAmount: rec.initialAmount,
            copiedAt:      rec.copiedAt,
            currentValue:  vals.reduce((s, v) => s + v, 0n),
          }
        }),
      )
      setCopyRecs(enriched.filter((r): r is CopyRec => r !== null))

      // ── B: Open positions ─────────────────────────────────────────────────
      const posIds = (await contracts.exchange.getUserPositions(addr)) as bigint[]

      const maybeRows = await Promise.all(
        posIds.map(async (id): Promise<PosRow | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos
            if (!raw.isOpen) return null
            const [pnl, val, priceRes] = await Promise.all([
              contracts.exchange.getUnrealizedPnL(id),
              contracts.exchange.getPositionValue(id),
              contracts.oracle.getPrice(raw.asset),
            ])
            const pr = priceRes as unknown as [bigint, bigint]
            return {
              id,
              asset:         raw.asset,
              isLong:        raw.isLong,
              entryPrice:    raw.entryPrice,
              currentPrice:  pr[0] * 10n ** 10n,
              margin:        raw.margin,
              leverage:      raw.leverage,
              unrealizedPnL: pnl as bigint,
              currentValue:  val as bigint,
              copiedFrom:    raw.copiedFrom,
            }
          } catch { return null }
        }),
      )
      setPositions(maybeRows.filter((r): r is PosRow => r !== null))

      // ── C: Free margin ────────────────────────────────────────────────────
      setFreeMargin((await contracts.exchange.freeMargin(addr)) as bigint)

    } catch (e) {
      console.error('[portfolio fetch]', e)
      notify(e instanceof Error ? e.message.slice(0, 120) : 'Network error — check your wallet network', false)
    }
  }, [contracts, wallet.address, notify])

  // Initial fetch + auto-refresh every 30 s
  useEffect(() => {
    void fetchAll()
    const timer = setInterval(() => { void fetchAll() }, 30_000)
    return () => clearInterval(timer)
  }, [fetchAll])

  // ── Transactions ────────────────────────────────────────────────────────────
  const doUnfollow = async (index: number) => {
    if (!contracts) return
    const key = `unfollow_${index}`
    setLoad(key, true)
    try {
      const tx = asTx(await contracts.copyTracker.unfollowAndCloseAll(BigInt(index)))
      await tx.wait()
      notify('Unfollowed and all positions closed ✓', true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Unfollow failed', false)
    } finally { setLoad(key, false) }
  }

  const doWithdraw = async () => {
    if (!contracts) return
    const amt = tryParse(withdrawAmt)
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('withdraw', true)
    try {
      const tx = asTx(await contracts.exchange.withdrawMargin(amt))
      await tx.wait()
      notify(`Withdrew ${withdrawAmt} mUSDC ✓`, true, tx.hash)
      setWithdrawAmt('')
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Withdraw failed', false)
    } finally { setLoad('withdraw', false) }
  }

  // ── Derived (chart data) ───────────────────────────────────────────────────
  const totalInitial = copyRecs.reduce((s, r) => s + r.initialAmount, 0n)
  const totalCopyCur = copyRecs.reduce((s, r) => s + r.currentValue, 0n)
  const initVal      = Number(totalInitial) / 1e18
  const curVal       = Number(totalCopyCur) / 1e18

  const chartData =
    totalInitial > 0n
      ? [
          { name: 'Deposited', value: initVal },
          { name: 'Now',       value: curVal  },
        ]
      : [{ name: 'Now', value: Number(freeMargin) / 1e18 }]

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to view your portfolio.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-xl ${
            toast.ok ? 'bg-emerald-800 text-emerald-100' : 'bg-red-900 text-red-100'
          }`}
        >
          {toast.msg}
          {toast.hash && wallet.chainId === 11155111 && (
            <a
              href={`https://sepolia.etherscan.io/tx/${toast.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-xs underline opacity-80 hover:opacity-100"
            >
              View on Etherscan ↗
            </a>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">My Portfolio</h1>
        <button
          onClick={() => void fetchAll()}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Free Margin"
          value={f18(freeMargin)}
          sub="mUSDC available"
          valueClass="text-brand-100"
        />
        <StatCard
          title="Active Copies"
          value={String(copyRecs.length)}
          sub={copyRecs.length === 1 ? 'trader followed' : 'traders followed'}
        />
        <StatCard
          title="Open Positions"
          value={String(positions.length)}
          sub="manual + copied"
        />
        <StatCard
          title="Total Copy PnL"
          value={totalInitial > 0n ? returnPct(totalInitial, totalCopyCur) : '—'}
          sub={totalInitial > 0n ? `${f18(totalCopyCur)} / ${f18(totalInitial)} mUSDC` : 'no copy positions'}
          valueClass={totalInitial > 0n ? returnColor(totalInitial, totalCopyCur) : 'text-gray-500'}
        />
      </div>

      {/* ─── A. Copy Records ────────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-border">
          <h2 className="text-base font-bold text-white">Copy Positions</h2>
        </div>

        {copyRecs.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-600 text-center">
            No active copy positions.
          </p>
        ) : (
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-surface-border">
                <th className="px-5 py-3 font-medium">Trader</th>
                <th className="px-5 py-3 font-medium">Copied At</th>
                <th className="px-5 py-3 font-medium text-right">Initial</th>
                <th className="px-5 py-3 font-medium text-right">Current</th>
                <th className="px-5 py-3 font-medium text-right">Return</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {copyRecs.map(rec => {
                const unfKey = `unfollow_${rec.index}`
                return (
                  <tr key={rec.index} className="hover:bg-surface-elev/60 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-white text-sm">
                        {rec.traderName || SHORT_ADDR(rec.trader)}
                      </div>
                      <div className="font-mono text-xs text-gray-500 mt-0.5">
                        {SHORT_ADDR(rec.trader)}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-gray-400 text-xs">
                      {fDate(rec.copiedAt)}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-right text-gray-300">
                      {f18(rec.initialAmount)}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-right text-white font-semibold">
                      {f18(rec.currentValue)}
                    </td>
                    <td className={`px-5 py-3.5 font-mono text-right font-semibold ${
                      returnColor(rec.initialAmount, rec.currentValue)
                    }`}>
                      {returnPct(rec.initialAmount, rec.currentValue)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => void doUnfollow(rec.index)}
                        disabled={busy[unfKey]}
                        className="px-3 py-1 rounded bg-gray-700 text-gray-300 text-xs hover:bg-red-900 hover:text-red-200 disabled:opacity-50 transition-colors"
                      >
                        {busy[unfKey] ? '…' : 'Unfollow'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── B. Open Positions ──────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-border">
          <h2 className="text-base font-bold text-white">Open Positions</h2>
        </div>

        {positions.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-600 text-center">
            No open positions.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-surface-border">
                  {['Asset','Side','Entry','Current','Margin','Lev','Copied From','Unr. PnL','Value'].map(h => (
                    <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {positions.map(row => (
                  <tr key={String(row.id)} className="hover:bg-surface-elev/60 transition-colors">
                    <td className="px-4 py-3 font-mono text-white font-medium">
                      {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
                    </td>
                    <td className={`px-4 py-3 font-bold text-xs ${
                      row.isLong ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {row.isLong ? 'LONG ↑' : 'SHORT ↓'}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-300 whitespace-nowrap">
                      {fUsd(row.entryPrice)}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-300 whitespace-nowrap">
                      {fUsd(row.currentPrice)}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-300">
                      {f18(row.margin)}
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {String(row.leverage)}×
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">
                      {row.copiedFrom === '0x0000000000000000000000000000000000000000'
                        ? <span className="text-gray-700">—</span>
                        : SHORT_ADDR(row.copiedFrom)
                      }
                    </td>
                    <td className={`px-4 py-3 font-mono font-semibold whitespace-nowrap ${pnlColor(row.unrealizedPnL)}`}>
                      {fPnL(row.unrealizedPnL)}
                    </td>
                    <td className={`px-4 py-3 font-mono font-semibold ${pnlColor(row.currentValue - row.margin)}`}>
                      {f18(row.currentValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-surface-border text-xs text-gray-500">
                  <td colSpan={7} className="px-4 py-2">Total</td>
                  <td className={`px-4 py-2 font-mono font-semibold ${
                    pnlColor(positions.reduce((s, p) => s + p.unrealizedPnL, 0n))
                  }`}>
                    {fPnL(positions.reduce((s, p) => s + p.unrealizedPnL, 0n))}
                  </td>
                  <td className="px-4 py-2 font-mono font-semibold text-white">
                    {f18(positions.reduce((s, p) => s + p.currentValue, 0n))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ─── C + D side-by-side ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* C. Free Margin */}
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
          <h2 className="text-base font-bold text-white">Free Margin</h2>
          <p className="text-2xl font-bold font-mono text-emerald-400">
            {f18(freeMargin)} <span className="text-base text-gray-500 font-normal">mUSDC</span>
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              placeholder="Amount"
              value={withdrawAmt}
              onChange={e => setWithdrawAmt(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              onClick={() => void doWithdraw()}
              disabled={busy['withdraw']}
              className="px-4 py-2 rounded-lg bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              {busy['withdraw'] ? '…' : 'Withdraw'}
            </button>
          </div>
        </div>

        {/* D. Performance Chart */}
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white">Performance</h2>
            {totalInitial > 0n && (
              <span className={`text-sm font-semibold ${returnColor(totalInitial, totalCopyCur)}`}>
                {returnPct(totalInitial, totalCopyCur)}
              </span>
            )}
          </div>

          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="name"
                stroke="#374151"
                tick={{ fill: '#6b7280', fontSize: 11 }}
              />
              <YAxis
                stroke="#374151"
                tick={{ fill: '#6b7280', fontSize: 11 }}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#111827',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: '#e5e7eb' }}
                formatter={(value) => [
                  `$${Number(value ?? 0).toFixed(2)}`,
                  'Portfolio Value',
                ]}
              />
              {totalInitial > 0n && (
                <ReferenceLine
                  y={initVal}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: 'Initial', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }}
                />
              )}
              <Line
                type="monotone"
                dataKey="value"
                stroke="#10b981"
                strokeWidth={2.5}
                dot={{ fill: '#10b981', r: 5, strokeWidth: 0 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>

          <p className="text-xs text-gray-600 text-center">
            Auto-refreshes every 30 s · Two-point view (initial vs current)
          </p>
        </div>
      </div>
    </div>
  )
}
