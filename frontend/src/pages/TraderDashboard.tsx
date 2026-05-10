import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { ASSET_IDS } from '../contracts/addresses'

// ── Config ─────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`

const ASSETS: { label: string; id: AssetId }[] = [
  { label: 'sBTC',  id: ASSET_IDS.sBTC  },
  { label: 'sETH',  id: ASSET_IDS.sETH  },
  { label: 'sAAPL', id: ASSET_IDS.sAAPL },
  { label: 'sTSLA', id: ASSET_IDS.sTSLA },
]
const ASSET_LABEL: Record<string, string> = Object.fromEntries(
  ASSETS.map(a => [a.id, a.label])
)

// ── Types ──────────────────────────────────────────────────────────────────
interface AllocRow {
  uid:      number
  asset:    AssetId
  isLong:   boolean
  leverage: number
  weight:   string
}

interface RawAlloc {
  asset:    string
  weight:   bigint
  isLong:   boolean
  leverage: bigint
}

interface HistVer {
  versionId: number
  createdAt: bigint
  allocs:    RawAlloc[]
  expanded:  boolean
}

interface TraderInfo {
  isRegistered: boolean
  displayName:  string
}

// ── Helpers ────────────────────────────────────────────────────────────────
const parseAlloc = (a: unknown): RawAlloc => {
  const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
  return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
}

const fmtDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

const fmtPct = (bps: bigint) => (Number(bps) / 100).toFixed(0) + '%'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Component ──────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function TraderDashboard({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [traderInfo, setTraderInfo] = useState<TraderInfo | null>(null)
  const [nameInput,  setNameInput]  = useState('')
  const [eligible,   setEligible]   = useState<boolean | null>(null)

  const uidRef = useRef(0)
  const [rows, setRows] = useState<AllocRow[]>([])

  const [history,  setHistory]  = useState<HistVer[]>([])
  const [earnings, setEarnings] = useState<bigint | null>(null)

  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchTrader = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const raw = (await contracts.registry.traders(wallet.address)) as unknown as [boolean, string, bigint]
      setTraderInfo({ isRegistered: raw[0], displayName: raw[1] })
    } catch (e) {
      console.error('[trader fetch]', e)
      notify(e instanceof Error ? e.message.slice(0, 120) : 'Network error — check your wallet network', false)
    }
    try {
      const elig = await contracts.traderStake.isEligible(wallet.address)
      setEligible(elig as boolean)
    } catch { setEligible(null) }
  }, [contracts, wallet.address, notify])

  const fetchHistory = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const count = Number((await contracts.registry.getStrategyCount(wallet.address)) as bigint)
      const addr  = wallet.address
      const vers  = await Promise.all(
        Array.from({ length: count }, (_, i) => i).map(async (i): Promise<HistVer> => {
          const res = (await contracts.registry.getStrategyVersion(
            addr, BigInt(i),
          )) as unknown as [unknown[], bigint]
          return {
            versionId: i,
            createdAt: res[1],
            allocs:    (res[0] as unknown[]).map(parseAlloc),
            expanded:  false,
          }
        }),
      )
      setHistory([...vers].reverse())
    } catch (e) {
      console.error('[history fetch]', e)
      notify(e instanceof Error ? e.message.slice(0, 120) : 'Network error — check your wallet network', false)
    }
  }, [contracts, wallet.address, notify])

  const fetchEarnings = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const raw = (await contracts.feeRouter.traderEarnings(wallet.address)) as bigint
      setEarnings(raw)
    } catch (e) {
      console.error('[earnings fetch]', e)
    }
  }, [contracts, wallet.address])

  useEffect(() => {
    void fetchTrader()
    void fetchHistory()
    void fetchEarnings()
  }, [fetchTrader, fetchHistory, fetchEarnings])

  // ── Row management ────────────────────────────────────────────────────────
  const addRow = () => {
    const uid = uidRef.current++
    setRows(prev => [
      ...prev,
      { uid, asset: ASSET_IDS.sBTC, isLong: true, leverage: 1, weight: '' },
    ])
  }

  const removeRow = (uid: number) =>
    setRows(prev => prev.filter(r => r.uid !== uid))

  const updateRow = (uid: number, patch: Partial<Omit<AllocRow, 'uid'>>) =>
    setRows(prev => prev.map(r => r.uid === uid ? { ...r, ...patch } : r))

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalBps = rows.reduce((sum, r) => {
    const pct = parseFloat(r.weight || '0')
    return sum + (isNaN(pct) ? 0 : Math.round(pct * 100))
  }, 0)

  const hasDup    = new Set(rows.map(r => r.asset)).size !== rows.length
  const weightOk  = totalBps === 10_000
  const stakeOk   = eligible !== false   // null = not loaded / not deployed → allow
  const canPublish = weightOk && !hasDup && rows.length > 0 && traderInfo?.isRegistered === true && stakeOk

  // Auto-fix: distribute remainder to last row
  const autoFix = () => {
    if (rows.length === 0) return
    const others = rows.slice(0, -1).reduce((s, r) => {
      const pct = parseFloat(r.weight || '0')
      return s + (isNaN(pct) ? 0 : Math.round(pct * 100))
    }, 0)
    const target = (10_000 - others) / 100
    if (target > 0 && target <= 100) {
      const last = rows[rows.length - 1]
      updateRow(last.uid, { weight: target.toFixed(2) })
    }
  }

  // ── Transactions ──────────────────────────────────────────────────────────
  const doRegister = async () => {
    if (!contracts || !nameInput.trim()) return
    setLoad('register', true)
    try {
      const tx = asTx(await contracts.registry.registerTrader(nameInput.trim()))
      await tx.wait()
      notify('Registered as trader ✓', true, tx.hash)
      setNameInput('')
      await fetchTrader()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Register failed', false)
    } finally { setLoad('register', false) }
  }

  const doPublish = async () => {
    if (!contracts || !canPublish) return
    const allocs = rows.map(r => ({
      asset:    r.asset,
      weight:   BigInt(Math.round(parseFloat(r.weight) * 100)),
      isLong:   r.isLong,
      leverage: BigInt(r.leverage),
    }))
    setLoad('publish', true)
    try {
      const tx = asTx(await contracts.registry.publishStrategy(allocs))
      await tx.wait()
      notify('Strategy published ✓', true, tx.hash)
      setRows([])
      await fetchHistory()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Publish failed', false)
    } finally { setLoad('publish', false) }
  }

  const doClaim = async () => {
    if (!contracts) return
    setLoad('claim', true)
    try {
      const tx = asTx(await contracts.feeRouter.withdrawTraderEarnings())
      await tx.wait()
      notify('Earnings claimed ✓', true, tx.hash)
      await fetchEarnings()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Claim failed', false)
    } finally { setLoad('claim', false) }
  }

  const toggleExpand = (versionId: number) =>
    setHistory(prev =>
      prev.map(v => v.versionId === versionId ? { ...v, expanded: !v.expanded } : v),
    )

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to access Trader Dashboard.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">

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

      {/* ─── A. Register ────────────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Register Trader</h2>

        {traderInfo?.isRegistered ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-900 border border-emerald-700 px-4 py-1.5 text-sm font-semibold text-emerald-300">
              ✓ {traderInfo.displayName}
            </span>
            <span className="text-xs text-gray-500">Registered as public trader</span>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Display name (e.g. AlphaTrader)"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void doRegister() }}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={() => void doRegister()}
              disabled={busy['register'] || !nameInput.trim()}
              className="px-4 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              {busy['register'] ? '…' : 'Register'}
            </button>
          </div>
        )}
      </div>

      {/* ─── B. Publish Strategy ──────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Publish Strategy</h2>
          <button onClick={addRow} className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors">
            + Add Asset
          </button>
        </div>

        {eligible === false && (
          <div className="rounded-lg border border-yellow-800/60 bg-yellow-950/20 px-4 py-3 flex items-start gap-3 text-sm">
            <span className="text-yellow-400 text-base shrink-0">⚠</span>
            <div className="space-y-1">
              <p className="text-yellow-300 font-semibold">Stake required to publish</p>
              <p className="text-xs text-gray-400">
                You need to stake at least 100 mUSDC before publishing a strategy. This gives followers confidence that you have skin-in-the-game.
              </p>
              <Link
                to="/stake"
                className="inline-block mt-1 text-xs font-semibold text-brand-100 hover:underline"
              >
                Go to Trader Stake →
              </Link>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-gray-600 py-1">Click "+ Add Asset" to define allocations.</p>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_130px_110px_80px_36px] gap-2 text-xs text-gray-500 uppercase tracking-wide px-1">
              <span>Asset</span>
              <span>Direction</span>
              <span>Leverage</span>
              <span className="text-right">Weight %</span>
              <span />
            </div>

            <div className="space-y-2">
              {rows.map(row => {
                const isDup = rows.filter(r => r.asset === row.asset).length > 1
                return (
                  <div
                    key={row.uid}
                    className={`grid grid-cols-[1fr_130px_110px_80px_36px] gap-2 items-center ${isDup ? 'opacity-80' : ''}`}
                  >
                    <select
                      value={row.asset}
                      onChange={e => updateRow(row.uid, { asset: e.target.value as AssetId })}
                      className={`rounded-lg bg-gray-800 border px-3 py-2 text-sm text-white focus:outline-none ${
                        isDup ? 'border-red-600' : 'border-gray-600'
                      }`}
                    >
                      {ASSETS.map(a => (
                        <option key={a.id} value={a.id}>{a.label}</option>
                      ))}
                    </select>

                    <div className="flex rounded-lg overflow-hidden border border-gray-600 h-[38px]">
                      <button
                        onClick={() => updateRow(row.uid, { isLong: true })}
                        className={`flex-1 text-xs font-bold transition-colors ${
                          row.isLong ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >Long ↑</button>
                      <button
                        onClick={() => updateRow(row.uid, { isLong: false })}
                        className={`flex-1 text-xs font-bold transition-colors ${
                          !row.isLong ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >Short ↓</button>
                    </div>

                    <select
                      value={row.leverage}
                      onChange={e => updateRow(row.uid, { leverage: Number(e.target.value) })}
                      className="rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none"
                    >
                      {[1, 2, 5].map(lv => (
                        <option key={lv} value={lv}>{lv}×</option>
                      ))}
                    </select>

                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      placeholder="0"
                      value={row.weight}
                      onChange={e => updateRow(row.uid, { weight: e.target.value })}
                      className="rounded-lg bg-gray-800 border border-gray-600 px-2 py-2 text-sm text-white text-right focus:outline-none focus:border-yellow-500"
                    />

                    <button
                      onClick={() => removeRow(row.uid)}
                      aria-label="Remove row"
                      className="h-[38px] w-9 rounded-lg bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 text-xl transition-colors flex items-center justify-center leading-none"
                    >×</button>
                  </div>
                )
              })}
            </div>

            {/* Duplicate asset warning */}
            {hasDup && (
              <p className="text-xs text-red-400">
                Each asset can only appear once per strategy. Remove the duplicate.
              </p>
            )}

            {/* Weight progress bar */}
            <div className="flex items-center gap-3 pt-1">
              <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${weightOk ? 'bg-emerald-500' : 'bg-yellow-500'}`}
                  style={{ width: `${Math.min(totalBps / 100, 100)}%` }}
                />
              </div>
              <span className={`text-sm font-mono font-semibold tabular-nums w-16 text-right ${weightOk ? 'text-emerald-400' : 'text-yellow-400'}`}>
                {(totalBps / 100).toFixed(2)}%
              </span>
              {!weightOk && (
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  {totalBps > 10_000 ? 'exceeds' : 'must reach'} 100%
                </span>
              )}
              {/* Auto-fix button — shown when close but not exact */}
              {!weightOk && rows.length > 0 && totalBps > 9_000 && totalBps < 11_000 && (
                <button
                  onClick={autoFix}
                  className="text-xs text-emerald-400 hover:text-emerald-300 underline whitespace-nowrap"
                >
                  Auto-fix to 100%
                </button>
              )}
            </div>
          </>
        )}

        <button
          onClick={() => void doPublish()}
          disabled={busy['publish'] || !canPublish}
          className="w-full py-2.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm font-bold transition-colors"
        >
          {busy['publish'] ? 'Publishing…' : 'Publish Strategy'}
        </button>

        {!traderInfo?.isRegistered && (
          <p className="text-xs text-gray-500 text-center -mt-1">
            Register as a trader first to publish.
          </p>
        )}
        {traderInfo?.isRegistered && eligible === false && (
          <p className="text-xs text-gray-500 text-center -mt-1">
            Stake ≥ 100 mUSDC on the <Link to="/stake" className="text-brand-100 hover:underline">Stake page</Link> to unlock publishing.
          </p>
        )}
      </div>

      {/* ─── C. Fee Earnings ─────────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Fee Earnings</h2>
          <button onClick={() => void fetchEarnings()} className="text-xs text-gray-500 hover:text-white transition-colors">
            ↺ Refresh
          </button>
        </div>

        <div className="flex items-center justify-between bg-surface-elev rounded-lg px-4 py-3">
          <div>
            <p className="text-xs text-gray-500">Claimable (copy + perf fees)</p>
            <p className="text-2xl font-mono font-bold text-emerald-400">
              {earnings === null ? '…' : (Number(earnings) / 1e18).toFixed(4)}
              <span className="text-sm font-normal text-gray-500 ml-1">mUSDC</span>
            </p>
          </div>
          <button
            onClick={() => void doClaim()}
            disabled={busy['claim'] || !earnings || earnings === 0n}
            className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
          >
            {busy['claim'] ? 'Claiming…' : 'Claim All'}
          </button>
        </div>

        <p className="text-xs text-gray-600">
          Earnings accrue when followers pay the 0.3% copy fee or close copied positions in profit (10% performance fee). Your share is 70% of each fee.
        </p>
      </div>

      {/* ─── D. Strategy History ──────────────────────────────────────── */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Strategy History</h2>
          <button
            onClick={() => void fetchHistory()}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            ↺ Refresh
          </button>
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-gray-600 py-4 text-center">No strategies published yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map(ver => (
              <div key={ver.versionId} className="rounded-lg border border-surface-border overflow-hidden">
                <button
                  onClick={() => toggleExpand(ver.versionId)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-elev transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs font-mono text-gray-500 shrink-0">v{ver.versionId}</span>
                    <span className="text-sm text-white truncate">
                      {ver.allocs.map(a =>
                        `${ASSET_LABEL[a.asset] ?? a.asset.slice(0, 6)} ${a.isLong ? 'L' : 'S'} ${String(a.leverage)}×`,
                      ).join('  ·  ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className="text-xs text-gray-500">{fmtDate(ver.createdAt)}</span>
                    <span className="text-gray-500 text-xs">{ver.expanded ? '▲' : '▼'}</span>
                  </div>
                </button>

                {ver.expanded && (
                  <div className="border-t border-surface-border bg-surface-sub px-4 py-3">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                          <th className="py-1.5 pr-4 text-left font-medium">Asset</th>
                          <th className="py-1.5 pr-4 text-left font-medium">Side</th>
                          <th className="py-1.5 pr-4 text-left font-medium">Leverage</th>
                          <th className="py-1.5 text-right font-medium">Weight</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {ver.allocs.map((a, idx) => (
                          <tr key={idx} className="text-gray-300">
                            <td className="py-2 pr-4 font-mono text-white font-medium">
                              {ASSET_LABEL[a.asset] ?? a.asset.slice(0, 8)}
                            </td>
                            <td className={`py-2 pr-4 font-bold text-xs uppercase tracking-wide ${a.isLong ? 'text-green-400' : 'text-red-400'}`}>
                              {a.isLong ? 'Long ↑' : 'Short ↓'}
                            </td>
                            <td className="py-2 pr-4 font-mono">{String(a.leverage)}×</td>
                            <td className="py-2 text-right font-mono font-semibold text-white">
                              {fmtPct(a.weight)}
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
        )}
      </div>
    </div>
  )
}
