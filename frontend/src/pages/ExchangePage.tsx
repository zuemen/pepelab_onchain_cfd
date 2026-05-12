import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { parseEther } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useLivePrices } from '../hooks/useLivePrices'
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts'
import { ASSET_IDS } from '../contracts/addresses'

// ── Config ────────────────────────────────────────────────────────────────────
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

// ── Types ─────────────────────────────────────────────────────────────────────
interface PositionRow {
  id:            bigint
  asset:         string
  isLong:        boolean
  entryPrice:    bigint
  margin:        bigint
  leverage:      bigint
  unrealizedPnL: bigint
  currentPrice:  bigint
}

interface RawPos {
  asset: string; isLong: boolean; isOpen: boolean
  entryPrice: bigint; margin: bigint; leverage: bigint
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f18    = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd   = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
const fPnL   = (v: bigint) => {
  const n = Number(v) / 1e18
  return (n >= 0 ? '+' : '') + n.toFixed(4) + ' USDC'
}
const pnlColor = (v: bigint) => Number(v) >= 0 ? 'text-green-400' : 'text-red-400'
const tryParse = (s: string): bigint | null => {
  try { return s ? parseEther(s) : null } catch { return null }
}

// ── TX helper ─────────────────────────────────────────────────────────────────
type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function ExchangePage({ wallet }: Props) {
  const contracts  = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const livePrices = useLivePrices()

  const [usdcBal,   setUsdcBal]   = useState(0n)
  const [ethBal,    setEthBal]    = useState('0.0000')
  const [freeMgn,   setFreeMgn]   = useState(0n)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [curPrice,  setCurPrice]  = useState(0n)
  const [pageLoading, setPageLoading] = useState(true)

  const [payEth,      setPayEth]      = useState('')
  const [depositAmt,  setDepositAmt]  = useState('')
  const [withdrawAmt, setWithdrawAmt] = useState('')
  const [selAsset,    setSelAsset]    = useState<AssetId>(ASSET_IDS.sBTC)
  const [isLong,      setIsLong]      = useState(true)
  const [leverage,    setLeverage]    = useState(1)
  const [openMgn,     setOpenMgn]     = useState('')
  const [history,     setHistory]     = useState<{ time: string; price: number }[]>([])

  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      const [bal, mgn, eBal] = await Promise.all([
        contracts.usdc.balanceOf(wallet.address),
        contracts.exchange.freeMargin(wallet.address),
        wallet.provider.getBalance(wallet.address)
      ])
      setUsdcBal(bal as bigint)
      setFreeMgn(mgn as bigint)
      setEthBal(f18(eBal as bigint, 4))

      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[]
      const maybeRows = await Promise.all(
        ids.map(async (id): Promise<PositionRow | null> => {
          const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos
          if (!raw.isOpen) return null
          const pnl = (await contracts.exchange.getUnrealizedPnL(id)) as bigint
          const pr  = (await contracts.oracle.getPrice(raw.asset)) as unknown as [bigint, bigint]
          return {
            id, asset: raw.asset, isLong: raw.isLong,
            entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage,
            unrealizedPnL: pnl, currentPrice: pr[0] * 10n ** 10n,
          }
        }),
      )
      setPositions(maybeRows.filter((r): r is PositionRow => r !== null))
    } catch (e) {
      console.error('[exchange fetch]', e)
      notify(e instanceof Error ? e.message.slice(0, 120) : 'Network error — check your wallet network', false)
    } finally {
      setPageLoading(false)
    }
  }, [contracts, wallet.address, notify])

  useEffect(() => {
    if (!contracts) return
    void (async () => {
      try {
        const pr = (await contracts.oracle.getPrice(selAsset)) as unknown as [bigint, bigint]
        setCurPrice(pr[0] * 10n ** 10n)
      } catch (e) { console.error('[price fetch]', e) }
    })()
  }, [contracts, selAsset])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // Reset history on asset change
  useEffect(() => { setHistory([]) }, [selAsset])

  // Track history for chart
  useEffect(() => {
    const p = livePrices[selAsset]?.usd
    if (p !== undefined) {
      setHistory(prev => {
        const next = [...prev, { time: new Date().toLocaleTimeString(), price: p }]
        return next.slice(-30) // last 30 data points (~1 min)
      })
    }
  }, [livePrices[selAsset]?.usd, selAsset])

  // ── Transactions ────────────────────────────────────────────────────────────
  const doSwap = async () => {
    if (!contracts || !wallet.address) return
    const ethAmt = parseFloat(payEth)
    if (!ethAmt || ethAmt <= 0) { notify('Enter a valid ETH amount', false); return }
    
    // 1 ETH = 3000 mUSDC
    const usdcOut = BigInt(Math.floor(ethAmt * 3000 * 1e18))
    
    setLoad('swap', true)
    try {
      // Note: On testnet we use the MockUSDC mint function to simulate a Uniswap route
      const tx = asTx(await contracts.usdc.mint(wallet.address, usdcOut))
      await tx.wait()
      notify(`Swapped ${payEth} ETH for ${(ethAmt * 3000).toFixed(2)} mUSDC ✓`, true, tx.hash)
      setPayEth('')
      
      // Optimistic update
      setUsdcBal(prev => prev + usdcOut)
      
      // Wait for RPC sync
      await new Promise(r => setTimeout(r, 1500))
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Swap failed', false)
    } finally { setLoad('swap', false) }
  }

  const approveDeposit = async () => {
    if (!contracts) return
    const amt = tryParse(depositAmt)
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('deposit', true)
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.exchange.target), amt))
      await approveTx.wait()
      const depositTx = asTx(await contracts.exchange.depositMargin(amt))
      await depositTx.wait()
      notify(`Deposited ${depositAmt} mUSDC ✓`, true, depositTx.hash)
      setDepositAmt('')
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Deposit failed', false)
    } finally { setLoad('deposit', false) }
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

  const openPosition = async () => {
    if (!contracts) return
    const amt = tryParse(openMgn)
    if (!amt) { notify('Enter a valid margin', false); return }
    setLoad('open', true)
    try {
      const tx = asTx(await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(leverage)))
      await tx.wait()
      notify(`${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? selAsset} opened ✓`, true, tx.hash)
      setOpenMgn('')
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Open failed', false)
    } finally { setLoad('open', false) }
  }

  const closePos = async (id: bigint) => {
    if (!contracts) return
    const key = `close_${id}`
    setLoad(key, true)
    try {
      const tx = asTx(await contracts.exchange.closePosition(id))
      await tx.wait()
      notify('Position closed ✓', true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(e instanceof Error ? e.message.slice(0, 100) : 'Close failed', false)
    } finally { setLoad(key, false) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const openMgnBig = tryParse(openMgn)
  const notional   = openMgnBig !== null ? openMgnBig * BigInt(leverage) : 0n

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to access the exchange.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (pageLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6 animate-pulse">
        <div className="h-24 bg-surface-elev rounded-card border border-surface-border"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="h-40 bg-surface-elev rounded-card border border-surface-border"></div>
          <div className="h-40 bg-surface-elev rounded-card border border-surface-border"></div>
        </div>
        <div className="h-64 bg-surface-elev rounded-card border border-surface-border"></div>
        <div className="h-48 bg-surface-elev rounded-card border border-surface-border flex items-center justify-center text-gray-500">
          Loading blockchain data...
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6 fade-in">

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-xl transition-all ${
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

      {/* Onboarding guide */}
      <div className="rounded-card border border-info/30 bg-info/5 p-5 space-y-2">
        <h3 className="text-sm font-semibold text-info">How CFD trading works on PepeLab</h3>
        <ol className="text-xs text-gray-300 space-y-1 list-decimal list-inside leading-relaxed">
          <li><strong>Swap:</strong> Swap ETH for mUSDC to get your stablecoin collateral.</li>
          <li><strong>Margin Account:</strong> Approve &amp; deposit mUSDC into PerpetualExchange. This becomes your free margin.</li>
          <li><strong>Open Position:</strong> Use free margin to open long/short on synthetic assets (sBTC, sETH, sAAPL, sTSLA). You don't own the asset — you take a CFD position.</li>
          <li><strong>PnL:</strong> Price moves → position value changes → close to realize PnL.</li>
        </ol>
      </div>

      {/* A & B — Swap + Margin */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* A. Swap */}
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-base font-bold text-white">Swap</h2>
            <span className="text-xs text-gray-500">Rate: 1 ETH = 3,000 mUSDC</span>
          </div>
          
          <div className="space-y-2">
            <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Pay</span>
                <span>Bal: {ethBal} ETH</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="number" min="0" placeholder="0.0"
                  value={payEth}
                  onChange={e => setPayEth(e.target.value)}
                  className="w-full bg-transparent text-2xl text-white focus:outline-none"
                />
                <span className="font-bold text-white px-2">ETH</span>
              </div>
            </div>
            
            <div className="flex justify-center -my-3 relative z-10">
              <div className="bg-surface-elev rounded-full p-1 border border-surface-border text-gray-400">
                ↓
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Receive</span>
                <span>Bal: {f18(usdcBal)} mUSDC</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="text" disabled
                  value={payEth ? (parseFloat(payEth) * 3000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
                  className="w-full bg-transparent text-2xl text-gray-300 focus:outline-none"
                />
                <span className="font-bold text-blue-400 px-2">mUSDC</span>
              </div>
            </div>
          </div>

          <button
            onClick={() => void doSwap()}
            disabled={busy['swap'] || !payEth || parseFloat(payEth) <= 0}
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold transition-colors"
          >
            {busy['swap'] ? 'Swapping…' : 'Swap'}
          </button>
        </div>

        {/* B. Margin */}
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
          <h2 className="text-base font-bold text-white">Margin Account</h2>
          <p className="text-sm text-gray-400">
            Free margin:{' '}
            <span className="font-mono text-white">{f18(freeMgn)} mUSDC</span>
          </p>

          <div className="flex gap-2">
            <input
              type="number" min="0" placeholder="Amount to deposit"
              value={depositAmt}
              onChange={e => setDepositAmt(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={() => void approveDeposit()}
              disabled={busy['deposit']}
              className="px-3 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap transition-colors"
            >
              {busy['deposit'] ? '…' : 'Approve & Deposit'}
            </button>
          </div>

          <div className="flex gap-2">
            <input
              type="number" min="0" placeholder="Amount to withdraw"
              value={withdrawAmt}
              onChange={e => setWithdrawAmt(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              onClick={() => void doWithdraw()}
              disabled={busy['withdraw']}
              className="px-3 py-2 rounded-lg bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
            >
              {busy['withdraw'] ? '…' : 'Withdraw'}
            </button>
          </div>
        </div>
      </div>

      {/* C. Open Position */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-5">
        <h2 className="text-base font-bold text-white">Open Position</h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">Asset</label>
            <select
              value={selAsset}
              onChange={e => setSelAsset(e.target.value as AssetId)}
              className="w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none"
            >
              {ASSETS.map(a => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">Direction</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-600 h-[38px]">
              <button
                onClick={() => setIsLong(true)}
                className={`flex-1 text-sm font-bold transition-colors ${isLong ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >LONG ↑</button>
              <button
                onClick={() => setIsLong(false)}
                className={`flex-1 text-sm font-bold transition-colors ${!isLong ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >SHORT ↓</button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">Leverage</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-600 h-[38px]">
              {[1, 2, 5].map(lv => (
                <button
                  key={lv}
                  onClick={() => setLeverage(lv)}
                  className={`flex-1 text-sm font-bold transition-colors ${leverage === lv ? 'bg-yellow-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  {lv}×
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">Margin (mUSDC)</label>
            <input
              type="number" min="0" placeholder="e.g. 100"
              value={openMgn}
              onChange={e => setOpenMgn(e.target.value)}
              className="w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-400">
          <span>
            Entry (oracle):{' '}
            <span className="font-mono text-white">{fUsd(curPrice)}</span>
          </span>
          {livePrices[selAsset] && (
            <span>
              Live market:{' '}
              <span className={`font-mono ${livePrices[selAsset].isMock ? 'text-yellow-400' : 'text-emerald-400'}`}>
                ${livePrices[selAsset].usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {livePrices[selAsset].isMock && <span className="text-xs text-gray-600 ml-1">(simulated)</span>}
            </span>
          )}
          <span>Notional: <span className="font-mono text-white">{f18(notional)} mUSDC</span></span>
        </div>

        {/* Live Chart */}
        {history.length > 1 && (
          <div className="w-full mt-4 -ml-2" style={{ height: '100px', minHeight: '100px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history}>
                <YAxis domain={['dataMin', 'dataMax']} hide />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <p className="text-xs text-gray-500 mt-2">
          PnL is calculated using on-chain oracle price. Live market shown for reference.
          Admin can sync oracle to live market on the{' '}
          <Link to="/admin/oracle" className="text-emerald-400 hover:underline">Oracle Admin</Link> page.
        </p>

        <button
          onClick={() => void openPosition()}
          disabled={busy['open'] || !openMgn}
          className={`px-8 py-2.5 rounded-lg text-white text-sm font-bold disabled:opacity-50 transition-colors ${isLong ? 'bg-green-700 hover:bg-green-600' : 'bg-red-700 hover:bg-red-600'}`}
        >
          {busy['open'] ? 'Opening…' : `Open ${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? ''}`}
        </button>
      </div>

      {/* D. Open Positions */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Open Positions</h2>
          <button onClick={() => void fetchAll()} className="text-xs text-gray-500 hover:text-white transition-colors">
            ↺ Refresh
          </button>
        </div>

        {positions.length === 0 ? (
          <p className="text-sm text-gray-600 py-6 text-center">No open positions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-surface-border">
                  {['Asset','Side','Entry','Current','Size','Margin','Lev','PnL',''].map(h => (
                    <th key={h} className="py-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {positions.map(row => {
                  const size     = row.entryPrice > 0n
                    ? (row.margin * row.leverage * 10n ** 18n) / row.entryPrice
                    : 0n
                  const closeKey = `close_${row.id}`
                  return (
                    <tr key={String(row.id)} className="hover:bg-surface-elev/60 transition-colors">
                      <td className="py-2.5 pr-4 font-mono text-white">
                        {ASSET_LABEL[row.asset] ?? row.asset.slice(0, 8)}
                      </td>
                      <td className={`py-2.5 pr-4 font-bold ${row.isLong ? 'text-green-400' : 'text-red-400'}`}>
                        {row.isLong ? 'LONG' : 'SHORT'}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-gray-300">{fUsd(row.entryPrice)}</td>
                      <td className="py-2.5 pr-4 font-mono text-gray-300">{fUsd(row.currentPrice)}</td>
                      <td className="py-2.5 pr-4 font-mono text-gray-400">{f18(size, 6)}</td>
                      <td className="py-2.5 pr-4 font-mono text-gray-300">{f18(row.margin)}</td>
                      <td className="py-2.5 pr-4 text-gray-300">{String(row.leverage)}×</td>
                      <td className={`py-2.5 pr-4 font-mono font-semibold ${pnlColor(row.unrealizedPnL)}`}>
                        {fPnL(row.unrealizedPnL)}
                      </td>
                      <td className="py-2.5">
                        <button
                          onClick={() => void closePos(row.id)}
                          disabled={busy[closeKey]}
                          className="px-3 py-1 rounded bg-gray-700 text-gray-300 text-xs hover:bg-red-900 hover:text-red-200 disabled:opacity-50 transition-colors"
                        >
                          {busy[closeKey] ? '…' : 'Close'}
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
    </div>
  )
}
