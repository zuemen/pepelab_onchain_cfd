import { useState, useEffect, useCallback } from 'react'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { ASSET_IDS } from '../contracts/addresses'

// ── Config ────────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`

const ASSETS: { label: string; id: AssetId }[] = [
  { label: 'sBTC',  id: ASSET_IDS.sBTC  },
  { label: 'sETH',  id: ASSET_IDS.sETH  },
  { label: 'sAAPL', id: ASSET_IDS.sAAPL },
  { label: 'sTSLA', id: ASSET_IDS.sTSLA },
]

// ── Types ─────────────────────────────────────────────────────────────────────
interface AssetRow {
  id:        AssetId
  label:     string
  price8:    bigint    // 8-decimal oracle price
  updatedAt: bigint    // unix timestamp
  input:     string    // USD value input
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fPrice8 = (p: bigint) =>
  '$' + (Number(p) / 1e8).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const fDate = (ts: bigint) =>
  ts === 0n
    ? '—'
    : new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
        dateStyle: 'short',
        timeStyle: 'short',
      })

// ±50% guard: |diff| / current ≤ 50%
const inRange = (current8: bigint, newUsd: string): boolean => {
  const n = parseFloat(newUsd)
  if (!isFinite(n) || n <= 0 || current8 === 0n) return false
  const new8 = BigInt(Math.round(n * 1e8))
  const diff = new8 > current8 ? new8 - current8 : current8 - new8
  return diff * 10_000n <= current8 * 5_000n
}

const allowedRange = (price8: bigint): string => {
  const p = Number(price8) / 1e8
  return `$${(p * 0.5).toLocaleString('en-US', { maximumFractionDigits: 2 })} – `
       + `$${(p * 1.5).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

type Waitable = { wait(): Promise<unknown> }
const waitTx = (tx: unknown) => (tx as Waitable).wait()

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function AdminOraclePage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [assets, setAssets] = useState<AssetRow[]>(
    ASSETS.map(a => ({ ...a, price8: 0n, updatedAt: 0n, input: '' })),
  )
  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    if (!contracts) return
    try {
      const rows = await Promise.all(
        ASSETS.map(async a => {
          const res = (await contracts.oracle.getPrice(a.id)) as unknown as [bigint, bigint]
          return {
            id:        a.id,
            label:     a.label,
            price8:    res[0],
            updatedAt: res[1],
            input:     (Number(res[0]) / 1e8).toFixed(2),
          }
        }),
      )
      setAssets(rows)
    } catch { /* ignore */ }
  }, [contracts])

  useEffect(() => { void fetchPrices() }, [fetchPrices])

  // ── Update price ──────────────────────────────────────────────────────────
  const updatePrice = async (id: AssetId, inputStr: string, current8: bigint) => {
    if (!contracts) return
    if (!inRange(current8, inputStr)) {
      notify('Price change exceeds ±50% limit', false)
      return
    }
    const new8 = BigInt(Math.round(parseFloat(inputStr) * 1e8))
    setLoad(id, true)
    try {
      await waitTx(await contracts.oracle.updatePrice(id, new8))
      notify(`Price updated ✓`, true)
      await fetchPrices()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Update failed', false)
    } finally { setLoad(id, false) }
  }

  const updateInput = (id: AssetId, value: string) =>
    setAssets(prev => prev.map(a => a.id === id ? { ...a, input: value } : a))

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to access Oracle Admin.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

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

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Oracle Price Admin</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Only the oracle owner wallet can update prices. Max ±50% per update.
        </p>
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-yellow-800 bg-yellow-950/40 px-4 py-3 text-xs text-yellow-400">
        <strong>Note:</strong> MockOracle price changes immediately affect all open position PnL.
        In production, oracle prices would come from trusted off-chain data feeds (e.g. Chainlink).
      </div>

      {/* Price table */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Asset Prices (8-decimal)</h2>
          <button
            onClick={() => void fetchPrices()}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            ↺ Refresh
          </button>
        </div>

        <div className="divide-y divide-gray-800">
          {assets.map(row => {
            const ok     = inRange(row.price8, row.input)
            const hasVal = row.input !== '' && !isNaN(parseFloat(row.input))
            return (
              <div key={row.id} className="px-5 py-4 space-y-3">
                {/* Asset info row */}
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-white text-lg">{row.label}</span>
                      <span className="text-xs font-mono text-gray-500 break-all">
                        {row.id.slice(0, 10)}…
                      </span>
                    </div>
                    <div className="text-2xl font-bold font-mono text-emerald-400">
                      {row.price8 > 0n ? fPrice8(row.price8) : '—'}
                    </div>
                    <div className="text-xs text-gray-500">
                      Last updated: {fDate(row.updatedAt)}
                      {row.price8 > 0n && (
                        <span className="ml-3 text-gray-600">
                          Allowed range: {allowedRange(row.price8)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Update row */}
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1 max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={row.price8 > 0n ? (Number(row.price8) / 1e8).toFixed(2) : '0.00'}
                      value={row.input}
                      onChange={e => updateInput(row.id, e.target.value)}
                      className={`w-full pl-7 pr-3 py-2 rounded-lg bg-gray-800 border text-sm text-white focus:outline-none ${
                        hasVal
                          ? ok
                            ? 'border-emerald-600 focus:border-emerald-500'
                            : 'border-red-700 focus:border-red-600'
                          : 'border-gray-600 focus:border-gray-500'
                      }`}
                    />
                  </div>
                  <button
                    onClick={() => void updatePrice(row.id, row.input, row.price8)}
                    disabled={busy[row.id] || !hasVal || !ok}
                    className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap"
                  >
                    {busy[row.id] ? 'Updating…' : 'Update Price'}
                  </button>
                  {hasVal && !ok && (
                    <span className="text-xs text-red-400 whitespace-nowrap">
                      exceeds ±50%
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Oracle raw values */}
      <details className="text-xs text-gray-700">
        <summary className="cursor-pointer hover:text-gray-500 w-fit">
          Raw 8-decimal prices (for cast commands)
        </summary>
        <div className="mt-2 space-y-1 p-3 rounded-lg bg-gray-900 border border-gray-800 font-mono text-gray-500">
          {assets.map(a => (
            <div key={a.id}>
              {a.label}: {String(a.price8)} (= ${(Number(a.price8)/1e8).toFixed(2)})
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
