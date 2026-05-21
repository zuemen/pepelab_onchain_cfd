import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { parseEther } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { prettyError } from '../lib/errorMessages'
import { ASSET_LABEL } from '../lib/assetMeta'

interface TraderStakeData {
  stake:        bigint
  totalSlashed: bigint
  reputation:   bigint
}

// ── Config ──────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────
interface CopyPreview {
  copyFee:            bigint
  totalTradingFee:    bigint
  marginForPositions: bigint
  portions:           bigint[]
}

interface AllocWithPrice {
  asset:      string
  weight:     bigint
  isLong:     boolean
  leverage:   bigint
  entryPrice: bigint   // 18-dec, current oracle price
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const tryParse = (s: string): bigint | null => {
  if (!s) return null
  try { return parseEther(s) } catch { return null }
}

const f18  = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Component ────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function CopyPage({ wallet }: Props) {
  const { traderAddress } = useParams<{ traderAddress: string }>()
  const navigate = useNavigate()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [traderName,       setTraderName]       = useState('')
  const [traderRegistered, setTraderRegistered] = useState(false)
  const [hasStrategy,      setHasStrategy]      = useState(false)
  const [loadError,        setLoadError]        = useState<string | null>(null)
  const [stratAllocs,      setStratAllocs]      = useState<AllocWithPrice[]>([])
  const [stakeData,        setStakeData]        = useState<TraderStakeData | null>(null)
  const [totalMargin,      setTotalMargin]      = useState('1000')
  const [approved,         setApproved]         = useState(false)
  const [busy,             setBusy]             = useState<Record<string, boolean>>({})
  const [toast,            setToast]            = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const [preview,          setPreview]          = useState<CopyPreview | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // Fetch trader name and strategy independently — strategy may revert if none published
  useEffect(() => {
    if (!contracts || !traderAddress) return
    setLoadError(null)
    const go = async () => {
      // trader info — failure means RPC error, abort the whole load
      try {
        const traderRaw = (await contracts.registry.traders(traderAddress)) as unknown as [boolean, string, bigint]
        setTraderName(traderRaw[1])
        setTraderRegistered(traderRaw[0] as boolean)
      } catch (e) {
        console.error('[CopyPage] trader fetch error', e)
        setLoadError(e instanceof Error ? e.message.slice(0, 120) : 'Could not load trader info — check network')
        return
      }

      // strategy — revert is expected when trader has not published yet
      try {
        const stratRaw = (await contracts.registry.getLatestStrategy(traderAddress)) as unknown as [unknown[], bigint]
        const allocs = stratRaw[0] as unknown as Array<{
          asset: string; weight: bigint; isLong: boolean; leverage: bigint
        }>

        const withPrices = await Promise.all(
          allocs.map(async a => {
            const pr = (await contracts.oracle.getPrice(a.asset)) as unknown as [bigint, bigint]
            return {
              asset:      a.asset,
              weight:     a.weight,
              isLong:     a.isLong,
              leverage:   a.leverage,
              entryPrice: pr[0] * 10n ** 10n,
            } satisfies AllocWithPrice
          }),
        )
        setStratAllocs(withPrices)
        setHasStrategy(true)
      } catch {
        setStratAllocs([])
        setHasStrategy(false)
      }

      // stake info — optional, silently skip if TraderStake not deployed
      try {
        const [si, score] = await Promise.all([
          contracts.traderStake.getStake(traderAddress),
          contracts.traderStake.reputationScore(traderAddress),
        ])
        const s = si as unknown as { amount: bigint; totalSlashed: bigint }
        setStakeData({ stake: s.amount, totalSlashed: s.totalSlashed, reputation: score as bigint })
      } catch { /* not deployed */ }
    }
    void go()
  }, [contracts, traderAddress])

  // Reset approval when amount changes
  useEffect(() => { setApproved(false) }, [totalMargin])

  // ── Computed preview ───────────────────────────────────────────────────────
  const COPY_FEE_BPS = 30n
  const totalBig  = tryParse(totalMargin) ?? 0n
  const feeBig    = totalBig * COPY_FEE_BPS / 10_000n
  const netBig    = totalBig - feeBig
  const previewRows = stratAllocs.map(a => ({
    ...a,
    margin:   netBig * a.weight / 10_000n,
    notional: netBig * a.weight / 10_000n * a.leverage,
  }))

  // Fetch fee breakdown from contract whenever amount or contracts change
  // (placed after totalBig declaration so the dependency array can reference it)
  useEffect(() => {
    if (!contracts || !traderAddress || !totalBig || totalBig === 0n) {
      setPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await contracts.copyTracker.previewCopyAllocation(traderAddress, totalBig)
        if (!cancelled) {
          setPreview({
            copyFee:            r[0] as bigint,
            totalTradingFee:    r[1] as bigint,
            marginForPositions: r[2] as bigint,
            portions:           Array.from(r[3] as bigint[]),
          })
        }
      } catch {
        if (!cancelled) setPreview(null)
      }
    })()
    return () => { cancelled = true }
  }, [contracts, traderAddress, totalBig])

  // ── Transactions ────────────────────────────────────────────────────────────
  const doApprove = async () => {
    if (!contracts) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('approve', true)
    try {
      const tx = asTx(await contracts.usdc.approve(String(contracts.copyTracker.target), amt))
      await tx.wait()
      notify('mUSDC approved ✓', true, tx.hash)
      setApproved(true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const doFollow = async () => {
    if (!contracts || !traderAddress) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('follow', true)
    try {
      const execFeePerPosition = await contracts.exchange.executionFee() as bigint
      const totalExecFee = execFeePerPosition * BigInt(stratAllocs.length)
      const tx = asTx(await contracts.copyTracker.followTrader(traderAddress, amt, {
        value: totalExecFee
      }))
      await tx.wait()
      notify('Following trader ✓', true, tx.hash)
      navigate('/portfolio')
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('follow', false) }
  }

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!traderAddress) {
    return <div className="p-8 text-gray-400">Invalid trader address.</div>
  }

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to copy a trader.
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

      {/* Load error banner */}
      {loadError && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          <strong>Failed to load trader:</strong> {loadError}
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link to="/marketplace" className="hover:text-white transition-colors">Marketplace</Link>
        <span>/</span>
        <span className="text-gray-300">
          {traderName || `${traderAddress.slice(0, 6)}…${traderAddress.slice(-4)}`}
        </span>
      </div>

      {/* Header */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">{traderName || 'Unknown Trader'}</h1>
            <p className="text-xs font-mono text-gray-500 mt-0.5">{traderAddress}</p>
          </div>
          {stakeData && (
            <div className="flex flex-col items-end gap-1 shrink-0">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold border ${
                stakeData.reputation >= 80n ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
                : stakeData.reputation >= 60n ? 'bg-yellow-900/60 border-yellow-700 text-yellow-300'
                : 'bg-red-900/60 border-red-800 text-red-300'
              }`}>
                ◆ {String(stakeData.reputation)} rep
              </span>
              <span className="text-xs text-gray-500 font-mono">
                {(Number(stakeData.stake) / 1e18).toFixed(0)} mUSDC staked
              </span>
            </div>
          )}
        </div>
        {!loadError && traderName !== '' && !traderRegistered && (
          <p className="text-xs text-yellow-400 font-medium">
            ⚠ This address is not registered as a trader.
          </p>
        )}
      </div>

      {/* Strategy allocations */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Latest Strategy</h2>

        {stratAllocs.length === 0 ? (
          <p className="text-sm text-gray-600">No strategy published yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stratAllocs.map((a, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border ${
                  a.isLong
                    ? 'bg-green-950 border-green-800 text-green-300'
                    : 'bg-red-950  border-red-800  text-red-300'
                }`}
              >
                {a.isLong ? '↑' : '↓'}
                {ASSET_LABEL[a.asset] ?? '?'}
                <span className="text-xs opacity-70">
                  {(Number(a.weight) / 100).toFixed(0)}% · {String(a.leverage)}×
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Total margin input */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
        <h2 className="text-base font-bold text-white">Copy Amount</h2>
        <div className="flex gap-3 items-center">
          <input
            type="number"
            min="0"
            placeholder="1000"
            value={totalMargin}
            disabled={!hasStrategy}
            onChange={e => setTotalMargin(e.target.value)}
            className="w-48 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <span className="text-sm text-gray-400">mUSDC total margin</span>
          {!hasStrategy && (
            <span className="text-xs text-gray-600 italic">disabled — no strategy</span>
          )}
        </div>

        {preview && totalBig > 0n && (
          <div className="rounded-md bg-gray-900 border border-surface-border p-3 mt-2 space-y-1 text-xs">
            <div className="flex justify-between text-gray-400">
              <span>Total deposit:</span>
              <span className="font-mono text-white">{f18(totalBig)} mUSDC</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>− Copy fee (0.3%):</span>
              <span className="font-mono text-red-400">-{f18(preview.copyFee)} mUSDC</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>− Trading fee buffer:</span>
              <span className="font-mono text-red-400">-{f18(preview.totalTradingFee)} mUSDC</span>
            </div>
            <div className="flex justify-between text-gray-300 font-semibold border-t border-gray-800 pt-1.5 mt-1">
              <span>Effective margin:</span>
              <span className="font-mono text-emerald-400">{f18(preview.marginForPositions)} mUSDC</span>
            </div>
          </div>
        )}

        {previewRows.length > 0 && totalBig > 0n && (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                  <th className="py-2 pr-4 font-medium">Asset</th>
                  <th className="py-2 pr-4 font-medium">Side</th>
                  <th className="py-2 pr-4 font-medium">Lev</th>
                  <th className="py-2 pr-4 font-medium">Weight</th>
                  <th className="py-2 pr-4 font-medium text-right">Margin</th>
                  <th className="py-2 pr-4 font-medium text-right">Notional</th>
                  <th className="py-2 font-medium text-right">Est. Entry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {previewRows.map((row, i) => (
                  <tr key={i} className="text-gray-300">
                    <td className="py-2.5 pr-4 font-mono text-white font-medium">
                      {ASSET_LABEL[row.asset] ?? '?'}
                    </td>
                    <td className={`py-2.5 pr-4 font-bold text-xs ${row.isLong ? 'text-green-400' : 'text-red-400'}`}>
                      {row.isLong ? 'LONG ↑' : 'SHORT ↓'}
                    </td>
                    <td className="py-2.5 pr-4 font-mono">{String(row.leverage)}×</td>
                    <td className="py-2.5 pr-4 font-mono">{(Number(row.weight) / 100).toFixed(0)}%</td>
                    <td className="py-2.5 pr-4 font-mono text-right">
                      {preview && preview.portions[i] !== undefined
                        ? f18(preview.portions[i])
                        : f18(row.margin)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-right">{f18(row.notional)}</td>
                    <td className="py-2.5 font-mono text-right">{fUsd(row.entryPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fee preview */}
      {totalBig > 0n && (
        <div className="rounded-xl border border-yellow-900/50 bg-yellow-950/20 p-4 space-y-1 text-sm">
          <p className="text-yellow-400 font-semibold text-xs uppercase tracking-wide">Fee Preview</p>
          <div className="flex justify-between text-gray-300">
            <span>Copy fee (0.3%)</span>
            <span className="font-mono">−{f18(feeBig, 4)} mUSDC</span>
          </div>
          <div className="flex justify-between text-gray-300">
            <span>Net margin deposited</span>
            <span className="font-mono font-semibold text-white">{f18(netBig)} mUSDC</span>
          </div>
          <div className="flex justify-between text-gray-300 mt-2 pt-2 border-t border-yellow-900/30">
            <span>Execution Fee (ETH)</span>
            <span className="font-mono font-semibold text-brand-300">{(stratAllocs.length * 0.001).toFixed(3)} ETH</span>
          </div>
          <p className="text-xs text-gray-600 pt-1">
            Copy fee is split 70% → trader · 20% → platform · 10% → slash pool. Execution fee pays Keeper bots.
          </p>
        </div>
      )}

      {/* Trader stake / risk summary */}
      {stakeData && (
        <div className={`rounded-xl border p-4 space-y-3 text-sm ${
          stakeData.totalSlashed > 0n
            ? 'border-red-800/60 bg-red-950/20'
            : 'border-surface-border bg-surface-elev/40'
        }`}>
          <p className="font-semibold text-white text-xs uppercase tracking-wide">
            Trader Skin-in-the-Game
          </p>
          <div className="flex flex-wrap gap-4 text-gray-300">
            <div>
              <span className="text-xs text-gray-500 block">Staked</span>
              <span className="font-mono font-semibold text-white">
                {(Number(stakeData.stake) / 1e18).toFixed(0)}
              </span>
              <span className="text-xs text-gray-500 ml-1">mUSDC</span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">Reputation</span>
              <span className={`font-mono font-semibold ${
                stakeData.reputation >= 80n ? 'text-emerald-400'
                : stakeData.reputation >= 60n ? 'text-yellow-400'
                : 'text-red-400'
              }`}>{String(stakeData.reputation)}</span>
              <span className="text-xs text-gray-500 ml-1">pts</span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">Total Slashed</span>
              <span className={`font-mono font-semibold ${stakeData.totalSlashed > 0n ? 'text-danger' : 'text-white'}`}>
                {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)}
              </span>
              <span className="text-xs text-gray-500 ml-1">mUSDC</span>
            </div>
          </div>
          {stakeData.totalSlashed > 0n && (
            <p className="text-xs text-red-400 font-medium">
              ⚠ This trader has had {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)} mUSDC slashed for causing excessive losses to followers. Proceed with caution.
            </p>
          )}
          {stakeData.stake === 0n && (
            <p className="text-xs text-yellow-400 font-medium">
              ⚠ This trader has no stake — they have no skin-in-the-game. You cannot trigger slashing if they cause losses.
            </p>
          )}
          <p className="text-xs text-gray-600">
            ⚠ If your loss exceeds 30%, this trader's stake will be slashed (50% of loss, capped at 50% of stake) and transferred to you as compensation.
          </p>
        </div>
      )}

      {/* Two-stage action */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Confirm Copy</h2>

        <div className="flex items-center gap-1 text-xs text-gray-500 mb-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-white font-bold text-xs ${
            approved ? 'bg-emerald-700' : 'bg-gray-700'
          }`}>
            {approved ? '✓' : '1'}
          </span>
          <span className={approved ? 'text-emerald-400' : 'text-gray-400'}>
            Approve mUSDC to CopyTracker
          </span>
          <span className="mx-2 text-gray-700">→</span>
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-white font-bold text-xs ${
            approved ? 'bg-gray-600' : 'bg-gray-800'
          }`}>
            2
          </span>
          <span className="text-gray-400">Follow Trader</span>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => void doApprove()}
            disabled={approved || busy['approve'] || !totalMargin || !hasStrategy}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              approved
                ? 'bg-emerald-900 text-emerald-400 opacity-60 cursor-default'
                : 'bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white'
            }`}
          >
            {busy['approve'] ? 'Approving…' : approved ? '✓ Approved' : 'Step 1 · Approve'}
          </button>

          <button
            onClick={() => void doFollow()}
            disabled={
              !hasStrategy || !approved || busy['follow'] || stratAllocs.length === 0 ||
              (preview !== null && preview.marginForPositions === 0n)
            }
            className="flex-1 py-2.5 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-bold transition-colors"
          >
            {busy['follow'] ? 'Following…' : 'Step 2 · Follow Trader'}
          </button>
        </div>

        {!hasStrategy && (
          <p className="text-xs text-yellow-500 text-center font-medium">
            ⚠ Trader has no published strategy. Copy is disabled.
          </p>
        )}

        <p className="text-xs text-gray-600 text-center">
          Your margin will be automatically split and deposited into positions according to the strategy above.
        </p>
      </div>
    </div>
  )
}
