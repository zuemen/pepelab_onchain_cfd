import { useState, useEffect, useCallback, useRef } from 'react'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useFundingData } from '../hooks/useFundingData'
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
  price8:    bigint
  updatedAt: bigint
  input:     string
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

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Funding helpers ───────────────────────────────────────────────────────────
const fOI = (v: bigint) => (Number(v) / 1e18).toFixed(2)
const fImbalance = (long: bigint, short: bigint): string => {
  const total = long + short
  if (total === 0n) return '0.00%'
  const pct = (Number(long - short) / Number(total)) * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
}
const fCountdown = (lastSettled: bigint, interval: bigint): string => {
  const nextAt = Number(lastSettled + interval)
  const now    = Math.floor(Date.now() / 1000)
  const secs   = nextAt - now
  if (secs <= 0) return 'Now'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function AdminOraclePage({ wallet }: Props) {
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const fundingData  = useFundingData(contracts?.exchange ?? null)

  const [assets,         setAssets]         = useState<AssetRow[]>(
    ASSETS.map(a => ({ ...a, price8: 0n, updatedAt: 0n, input: '' })),
  )
  const [oracleOwner,    setOracleOwner]    = useState<string | null>(null)
  const [ownerCheckError, setOwnerCheckError] = useState<string | null>(null)
  const [busy,           setBusy]           = useState<Record<string, boolean>>({})
  const [toast,          setToast]          = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const [syncBusy,       setSyncBusy]       = useState(false)
  const [syncMsg,        setSyncMsg]        = useState<string | null>(null)
  const [autoSettle,     setAutoSettle]     = useState(false)
  const [fundingSettleBusy, setFundingSettleBusy] = useState<Record<string, boolean>>({})
  const [, setTick]   = useState(0)  // force re-render for countdown
  const autoSettleRef = useRef(false)

  const isOwner =
    oracleOwner !== null &&
    wallet.address !== null &&
    oracleOwner.toLowerCase() === wallet.address.toLowerCase()

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // Countdown ticker
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Settle funding for one asset
  const settleFunding = useCallback(async (assetId: string) => {
    if (!contracts || !isOwner) return
    const key = `settle_${assetId}`
    setFundingSettleBusy(p => ({ ...p, [key]: true }))
    try {
      const tx = asTx(await contracts.exchange.settleFunding(assetId))
      await tx.wait()
      notify(`Funding settled ✓`, true, tx.hash)
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Settle failed', false)
    } finally {
      setFundingSettleBusy(p => ({ ...p, [key]: false }))
    }
  }, [contracts, isOwner])

  // Auto-settle toggle: check every 60s, settle all eligible assets
  useEffect(() => {
    autoSettleRef.current = autoSettle
  }, [autoSettle])

  useEffect(() => {
    if (!autoSettle) return
    const run = async () => {
      if (!contracts || !autoSettleRef.current) return
      for (const [id, info] of Object.entries(fundingData)) {
        if (info.canSettle) {
          try {
            const tx = asTx(await contracts.exchange.settleFunding(id))
            await tx.wait()
          } catch { /* ignore */ }
        }
      }
    }
    void run()
    const t = setInterval(() => { void run() }, 60_000)
    return () => clearInterval(t)
  }, [autoSettle, contracts, fundingData])

  // ── Fetch prices ──────────────────────────────────────────────────────────
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
    } catch (e) {
      console.error('[oracle fetch]', e)
      notify(e instanceof Error ? e.message.slice(0, 120) : 'Network error — check your wallet network', false)
    }
  }, [contracts])

  // ── Check oracle ownership (cancellation flag avoids unmount race) ────────
  useEffect(() => {
    if (!contracts) return
    let cancelled = false
    void (async () => {
      try {
        const owner = (await contracts.oracle.owner()) as string
        if (!cancelled) { setOracleOwner(owner); setOwnerCheckError(null) }
      } catch (e) {
        if (!cancelled) {
          setOracleOwner(null)
          setOwnerCheckError(e instanceof Error ? e.message.slice(0, 120) : 'Failed to read owner')
        }
      }
    })()
    return () => { cancelled = true }
  }, [contracts])

  useEffect(() => { void fetchPrices() }, [fetchPrices])

  // ── Update price ──────────────────────────────────────────────────────────
  const updatePrice = async (id: AssetId, inputStr: string) => {
    if (!contracts) return
    if (!isOwner) {
      notify('Connected wallet is not the oracle owner', false)
      return
    }
    const new8 = BigInt(Math.round(parseFloat(inputStr) * 1e8))
    setLoad(id, true)
    try {
      const tx = asTx(await contracts.oracle.updatePrice(id, new8))
      await tx.wait()
      notify('Price updated ✓', true, tx.hash)
      await fetchPrices()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Update failed', false)
    } finally { setLoad(id, false) }
  }

  const updateInput = (id: AssetId, value: string) =>
    setAssets(prev => prev.map(a => a.id === id ? { ...a, input: value } : a))

  const syncFromCoinGecko = async () => {
    if (!contracts || !isOwner) return
    setSyncBusy(true)
    setSyncMsg(null)
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      )
      if (!res.ok) throw new Error(`CoinGecko API error ${res.status}`)
      const data = await res.json() as { bitcoin: { usd: number }; ethereum: { usd: number } }

      const currentAAPL = Number(assets.find(a => a.id === ASSET_IDS.sAAPL)?.price8 ?? 0n) / 1e8
      const currentTSLA = Number(assets.find(a => a.id === ASSET_IDS.sTSLA)?.price8 ?? 0n) / 1e8
      const wiggle = () => 1 + (Math.random() - 0.5) * 0.06
      const newAAPL = currentAAPL > 0 ? currentAAPL * wiggle() : 200
      const newTSLA = currentTSLA > 0 ? currentTSLA * wiggle() : 250

      const targets: Array<[AssetId, number, string]> = [
        [ASSET_IDS.sBTC,  data.bitcoin.usd,  'BTC'],
        [ASSET_IDS.sETH,  data.ethereum.usd, 'ETH'],
        [ASSET_IDS.sAAPL, newAAPL,           'AAPL'],
        [ASSET_IDS.sTSLA, newTSLA,           'TSLA'],
      ]

      const updates: string[] = []
      for (const [id, usdPrice, label] of targets) {
        const row = assets.find(a => a.id === id)
        if (!row || row.price8 === 0n) continue
        const new8 = BigInt(Math.round(usdPrice * 1e8))
        const tx = asTx(await contracts.oracle.updatePrice(id, new8))
        await tx.wait()
        updates.push(`${label}: $${(Number(new8) / 1e8).toFixed(2)}`)
      }

      setSyncMsg('✓ ' + updates.join(' · '))
      await fetchPrices()
    } catch (e) {
      setSyncMsg('Sync failed: ' + (e instanceof Error ? e.message.slice(0, 80) : 'unknown'))
    } finally {
      setSyncBusy(false)
    }
  }

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

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Oracle Price Admin</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Only the oracle owner wallet can update prices.
        </p>
      </div>

      {/* Live Price Sync */}
      <div className="rounded-card border border-brand-200/30 bg-brand-200/5 p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-brand-100">Live Price Sync</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Pull real-time BTC/ETH from CoinGecko. AAPL/TSLA simulated.
            </p>
          </div>
          <button
            onClick={() => void syncFromCoinGecko()}
            disabled={!isOwner || syncBusy}
            className="px-4 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-semibold whitespace-nowrap"
          >
            {syncBusy ? 'Syncing…' : 'Sync from CoinGecko'}
          </button>
        </div>
        {syncMsg && <p className="text-xs text-gray-400">{syncMsg}</p>}
      </div>

      {/* Owner status banner */}
      {ownerCheckError ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-xs text-red-400">
          <strong>Failed to read oracle owner:</strong> {ownerCheckError}
        </div>
      ) : oracleOwner === null ? (
        <div className="rounded-lg border border-gray-700 bg-gray-800/60 px-4 py-3 text-xs text-gray-400">
          Checking owner permissions…
        </div>
      ) : !isOwner ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-xs text-red-400 space-y-1">
          <p><strong>Read-only mode:</strong> connected wallet is not the oracle owner. Updates will revert.</p>
          <p className="font-mono">Owner: {oracleOwner.slice(0, 10)}…{oracleOwner.slice(-6)}</p>
          <p className="font-mono">You:&nbsp;&nbsp;&nbsp;{wallet.address?.slice(0, 10)}…{wallet.address?.slice(-6)}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-xs text-emerald-400">
          Owner verified ✓
        </div>
      )}

      {/* General warning */}
      <div className="rounded-lg border border-yellow-800 bg-yellow-950/40 px-4 py-3 text-xs text-yellow-400">
        <strong>Note:</strong> MockOracle price changes immediately affect all open position PnL.
        In production, oracle prices would come from trusted off-chain data feeds (e.g. Chainlink).
      </div>

      {/* ─── Funding Settlement ──────────────────────────────────────────── */}
      {isOwner && (
        <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white">Funding Settlement</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Settle per-asset funding (every {Object.values(fundingData)[0]
                  ? `${Number(Object.values(fundingData)[0].interval) / 60}m`
                  : '5m'}). Anyone can call on-chain; UI restricts to owner.
              </p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs text-gray-400">Auto-Settle</span>
              <div
                onClick={() => setAutoSettle(v => !v)}
                className={`relative w-10 h-5 rounded-full transition-colors ${autoSettle ? 'bg-emerald-600' : 'bg-gray-700'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoSettle ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </label>
          </div>

          {Object.keys(fundingData).length === 0 ? (
            <p className="px-5 py-6 text-sm text-gray-600 text-center">Loading funding data…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                    {['Asset','Rate (bps)','Long OI','Short OI','Imbalance','Last Settled','Next In',''].map(h => (
                      <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {ASSETS.map(a => {
                    const info = fundingData[a.id]
                    if (!info) return null
                    const key     = `settle_${a.id}`
                    const rateNum = Number(info.rate)
                    return (
                      <tr key={a.id} className="hover:bg-surface-elev/60 transition-colors">
                        <td className="px-4 py-3 font-mono font-bold text-white">{a.label}</td>
                        <td className={`px-4 py-3 font-mono font-semibold ${rateNum > 0 ? 'text-red-400' : rateNum < 0 ? 'text-green-400' : 'text-gray-500'}`}>
                          {rateNum > 0 ? '+' : ''}{rateNum} {rateNum > 0 ? '(L pay)' : rateNum < 0 ? '(S pay)' : ''}
                        </td>
                        <td className="px-4 py-3 font-mono text-gray-300">{fOI(info.longOI)}</td>
                        <td className="px-4 py-3 font-mono text-gray-300">{fOI(info.shortOI)}</td>
                        <td className={`px-4 py-3 font-mono ${Number(info.longOI) > Number(info.shortOI) ? 'text-red-400' : 'text-green-400'}`}>
                          {fImbalance(info.longOI, info.shortOI)}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {info.lastSettled === 0n ? 'Never' : fDate(info.lastSettled)}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-gray-400">
                          {info.canSettle ? <span className="text-emerald-400 font-semibold">Ready</span> : fCountdown(info.lastSettled, info.interval)}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => void settleFunding(a.id)}
                            disabled={!info.canSettle || !!fundingSettleBusy[key]}
                            className="px-3 py-1 rounded bg-gray-700 text-gray-300 text-xs hover:bg-emerald-900 hover:text-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {fundingSettleBusy[key] ? '…' : 'Settle Now'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Price table */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Asset Prices (8-decimal)</h2>
          <button
            onClick={() => void fetchPrices()}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            ↺ Refresh
          </button>
        </div>

        <div className="divide-y divide-surface-border">
          {assets.map(row => {
            const hasVal = row.input !== '' && !isNaN(parseFloat(row.input))
            return (
              <div key={row.id} className="px-5 py-4 space-y-3">
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
                    </div>
                  </div>
                </div>

                <div className="flex gap-2 items-center">
                  <div className="relative flex-1 max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={!isOwner}
                      placeholder={row.price8 > 0n ? (Number(row.price8) / 1e8).toFixed(2) : '0.00'}
                      value={row.input}
                      onChange={e => updateInput(row.id, e.target.value)}
                      className={`w-full pl-7 pr-3 py-2 rounded-lg bg-gray-800 border text-sm text-white focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                        hasVal
                          ? 'border-emerald-600 focus:border-emerald-500'
                          : 'border-gray-600 focus:border-gray-500'
                      }`}
                    />
                  </div>
                  <button
                    onClick={() => void updatePrice(row.id, row.input)}
                    disabled={busy[row.id] || !hasVal || !isOwner}
                    className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors whitespace-nowrap"
                  >
                    {busy[row.id] ? 'Updating…' : 'Update Price'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Raw values */}
      <details className="text-xs text-gray-700">
        <summary className="cursor-pointer hover:text-gray-500 w-fit">
          Raw 8-decimal prices (for cast commands)
        </summary>
        <div className="mt-2 space-y-1 p-3 rounded-lg bg-surface border border-surface-border font-mono text-gray-500">
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
