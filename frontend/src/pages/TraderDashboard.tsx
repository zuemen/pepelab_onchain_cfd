import { useState, useEffect, useCallback, useRef } from 'react'
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
  leverage: number    // 1 | 2 | 5
  weight:   string    // % as string, e.g. "50"
}

interface RawAlloc {
  asset:    string
  weight:   bigint   // bps
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

type Waitable = { wait(): Promise<unknown> }
const waitTx = (tx: unknown) => (tx as Waitable).wait()

// ── Component ──────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function TraderDashboard({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  // A — trader registration
  const [traderInfo, setTraderInfo] = useState<TraderInfo | null>(null)
  const [nameInput,  setNameInput]  = useState('')

  // B — strategy builder
  const uidRef = useRef(0)
  const [rows, setRows] = useState<AllocRow[]>([])

  // C — strategy history
  const [history, setHistory] = useState<HistVer[]>([])

  // UI
  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))

  const notify = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchTrader = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const raw = (await contracts.registry.traders(wallet.address)) as unknown as [boolean, string, bigint]
      setTraderInfo({ isRegistered: raw[0], displayName: raw[1] })
    } catch { /* ignore */ }
  }, [contracts, wallet.address])

  const fetchHistory = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const count = Number((await contracts.registry.getStrategyCount(wallet.address)) as bigint)
      const addr  = wallet.address           // captured for async closure
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
      setHistory([...vers].reverse())  // newest first
    } catch { /* ignore */ }
  }, [contracts, wallet.address])

  useEffect(() => {
    void fetchTrader()
    void fetchHistory()
  }, [fetchTrader, fetchHistory])

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

  const weightOk   = totalBps === 10_000
  const canPublish = weightOk && rows.length > 0 && traderInfo?.isRegistered === true

  // ── Transactions ──────────────────────────────────────────────────────────
  const doRegister = async () => {
    if (!contracts || !nameInput.trim()) return
    setLoad('register', true)
    try {
      await waitTx(await contracts.registry.registerTrader(nameInput.trim()))
      notify('Registered as trader ✓', true)
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
      await waitTx(await contracts.registry.publishStrategy(allocs))
      notify('Strategy published ✓', true)
      setRows([])
      await fetchHistory()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Publish failed', false)
    } finally { setLoad('publish', false) }
  }

  const toggleExpand = (versionId: number) =>
    setHistory(prev =>
      prev.map(v =>
        v.versionId === versionId ? { ...v, expanded: !v.expanded } : v,
      ),
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
        </div>
      )}

      {/* ─── A. Register Trader ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-4">
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
              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              {busy['register'] ? '…' : 'Register'}
            </button>
          </div>
        )}
      </div>

      {/* ─── B. Publish Strategy ────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Publish Strategy</h2>
          <button
            onClick={addRow}
            className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            + Add Asset
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-gray-600 py-1">
            Click "+ Add Asset" to define allocations.
          </p>
        ) : (
          <>
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_130px_110px_80px_36px] gap-2 text-xs text-gray-500 uppercase tracking-wide px-1">
              <span>Asset</span>
              <span>Direction</span>
              <span>Leverage</span>
              <span className="text-right">Weight %</span>
              <span />
            </div>

            <div className="space-y-2">
              {rows.map(row => (
                <div
                  key={row.uid}
                  className="grid grid-cols-[1fr_130px_110px_80px_36px] gap-2 items-center"
                >
                  {/* Asset */}
                  <select
                    value={row.asset}
                    onChange={e => updateRow(row.uid, { asset: e.target.value as AssetId })}
                    className="rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none"
                  >
                    {ASSETS.map(a => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>

                  {/* Direction */}
                  <div className="flex rounded-lg overflow-hidden border border-gray-600 h-[38px]">
                    <button
                      onClick={() => updateRow(row.uid, { isLong: true })}
                      className={`flex-1 text-xs font-bold transition-colors ${
                        row.isLong
                          ? 'bg-green-700 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      Long ↑
                    </button>
                    <button
                      onClick={() => updateRow(row.uid, { isLong: false })}
                      className={`flex-1 text-xs font-bold transition-colors ${
                        !row.isLong
                          ? 'bg-red-700 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      Short ↓
                    </button>
                  </div>

                  {/* Leverage */}
                  <select
                    value={row.leverage}
                    onChange={e => updateRow(row.uid, { leverage: Number(e.target.value) })}
                    className="rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none"
                  >
                    {[1, 2, 5].map(lv => (
                      <option key={lv} value={lv}>{lv}×</option>
                    ))}
                  </select>

                  {/* Weight % */}
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

                  {/* Remove */}
                  <button
                    onClick={() => removeRow(row.uid)}
                    aria-label="Remove row"
                    className="h-[38px] w-9 rounded-lg bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 text-xl transition-colors flex items-center justify-center leading-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Weight progress bar */}
            <div className="flex items-center gap-3 pt-1">
              <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    weightOk ? 'bg-emerald-500' : 'bg-yellow-500'
                  }`}
                  style={{ width: `${Math.min(totalBps / 100, 100)}%` }}
                />
              </div>
              <span
                className={`text-sm font-mono font-semibold tabular-nums w-16 text-right ${
                  weightOk ? 'text-emerald-400' : 'text-yellow-400'
                }`}
              >
                {(totalBps / 100).toFixed(2)}%
              </span>
              {!weightOk && (
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  {totalBps > 10_000 ? 'exceeds' : 'must reach'} 100%
                </span>
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
      </div>

      {/* ─── C. Strategy History ────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-4">
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
          <p className="text-sm text-gray-600 py-4 text-center">
            No strategies published yet.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map(ver => (
              <div
                key={ver.versionId}
                className="rounded-lg border border-gray-700 overflow-hidden"
              >
                {/* Version row (clickable header) */}
                <button
                  onClick={() => toggleExpand(ver.versionId)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs font-mono text-gray-500 shrink-0">
                      v{ver.versionId}
                    </span>
                    <span className="text-sm text-white truncate">
                      {ver.allocs
                        .map(a =>
                          `${ASSET_LABEL[a.asset] ?? a.asset.slice(0, 6)} ${a.isLong ? 'L' : 'S'} ${String(a.leverage)}×`,
                        )
                        .join('  ·  ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className="text-xs text-gray-500">{fmtDate(ver.createdAt)}</span>
                    <span className="text-gray-500 text-xs">{ver.expanded ? '▲' : '▼'}</span>
                  </div>
                </button>

                {/* Expanded allocations table */}
                {ver.expanded && (
                  <div className="border-t border-gray-700 bg-gray-950 px-4 py-3">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-500 uppercase border-b border-gray-700">
                          <th className="py-1.5 pr-4 text-left font-medium">Asset</th>
                          <th className="py-1.5 pr-4 text-left font-medium">Side</th>
                          <th className="py-1.5 pr-4 text-left font-medium">Leverage</th>
                          <th className="py-1.5 text-right font-medium">Weight</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {ver.allocs.map((a, idx) => (
                          <tr key={idx} className="text-gray-300">
                            <td className="py-2 pr-4 font-mono text-white font-medium">
                              {ASSET_LABEL[a.asset] ?? a.asset.slice(0, 8)}
                            </td>
                            <td
                              className={`py-2 pr-4 font-bold text-xs uppercase tracking-wide ${
                                a.isLong ? 'text-green-400' : 'text-red-400'
                              }`}
                            >
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
