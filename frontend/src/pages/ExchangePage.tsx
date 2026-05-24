import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { parseEther } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { useLivePrices } from '../hooks/useLivePrices'
import { useFundingData } from '../hooks/useFundingData'
import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts'
import { ASSET_IDS } from '../contracts/addresses'
import { prettyError } from '../lib/errorMessages'
import { useESG } from '../hooks/useESG'
import ESGBadge from '../components/ESGBadge'
import { ASSETS_LIST, ASSET_LABEL, ASSET_META } from '../lib/assetMeta'
import { useKYC } from '../hooks/useKYC'
import KYCModal from '../components/KYCModal'

// ── Config ────────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`

const ASSETS = ASSETS_LIST

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
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const livePrices   = useLivePrices()
  const fundingData  = useFundingData(contracts?.exchange ?? null)
  const esg          = useESG(contracts?.esgRegistry ?? null)

  const [usdcBal,   setUsdcBal]   = useState(0n)
  const [ethBal,    setEthBal]    = useState('0.0000')
  const [freeMgn,   setFreeMgn]   = useState(0n)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [curPrice,  setCurPrice]  = useState(0n)
  const [pageLoading, setPageLoading] = useState(true)

  const [swapMode,  setSwapMode]  = useState<'eth-to-usdc' | 'usdc-to-eth'>('eth-to-usdc')
  const [payAmount, setPayAmount] = useState('')
  const [ammPrice,  setAmmPrice]  = useState(0n)
  const [ammEth,    setAmmEth]    = useState(0n)
  const [ammUsdc,   setAmmUsdc]   = useState(0n)
  const [receiveAmount,  setReceiveAmount]  = useState('')
  const [depositAmt,       setDepositAmt]        = useState('')
  const [withdrawAmt, setWithdrawAmt] = useState('')
  const [selAsset,    setSelAsset]    = useState<AssetId>(ASSET_IDS.sBTC)
  const [isLong,      setIsLong]      = useState(true)
  const [leverage,    setLeverage]    = useState(1)
  const [openMgn,     setOpenMgn]     = useState('')
  const [history,     setHistory]     = useState<{ time: string; price: number }[]>([])

  const [busy,         setBusy]        = useState<Record<string, boolean>>({})
  const [toast,        setToast]       = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const [showKYCModal, setShowKYCModal] = useState(false)
  const [esgConfirmed, setEsgConfirmed] = useState(false)

  const { isVerified: isKYCVerified, refetch: refetchKYC } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null,
  )

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      // 第一組:使用者餘額（必須成功,跟 AMM 無關）
      const [bal, mgn, eBal] = await Promise.all([
        contracts.usdc.balanceOf(wallet.address),
        contracts.exchange.freeMargin(wallet.address),
        wallet.provider!.getBalance(wallet.address),
      ])
      setUsdcBal(bal as bigint)
      setFreeMgn(mgn as bigint)
      setEthBal(f18(eBal as bigint, 4))

      // 第二組:AMM 資料（失敗不影響餘額顯示）
      let price = 0n
      let reserves: [bigint, bigint] = [0n, 0n]
      try {
        price    = await contracts.pepeAMM.getPrice() as bigint
        reserves = await contracts.pepeAMM.getReserves() as [bigint, bigint]
      } catch (e) {
        console.warn('[AMM] unavailable:', e)
      }
      setAmmPrice(price)
      const [ethR, usdcR] = reserves
      setAmmEth(ethR)
      setAmmUsdc(usdcR)

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
      notify(prettyError(e), false)
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

  // Reset history and ESG confirmation on asset change
  useEffect(() => { setHistory([]); setEsgConfirmed(false) }, [selAsset])

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

  // ── Live AMM quote ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!contracts?.pepeAMM || !payAmount || parseFloat(payAmount) <= 0) {
      setReceiveAmount('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const parsed = parseEther(payAmount)
        const out = swapMode === 'eth-to-usdc'
          ? await contracts.pepeAMM.quoteETHForUSDC(parsed) as bigint
          : await contracts.pepeAMM.quoteUSDCForETH(parsed) as bigint
        if (!cancelled) {
          setReceiveAmount((Number(out) / 1e18).toFixed(swapMode === 'eth-to-usdc' ? 2 : 6))
        }
      } catch {
        if (!cancelled) { setReceiveAmount('') }
      }
    })()
    return () => { cancelled = true }
  }, [contracts?.pepeAMM, payAmount, swapMode])

  // ── Transactions ────────────────────────────────────────────────────────────
  const doSwap = async () => {
    if (!contracts || !wallet.address) return
    const amt = parseFloat(payAmount)
    if (!amt || amt <= 0) { notify('Enter a valid amount', false); return }

    setLoad('swap', true)
    try {
      if (swapMode === 'eth-to-usdc') {
        const ethIn  = parseEther(payAmount)
        const quoted = await contracts.pepeAMM.quoteETHForUSDC(ethIn) as bigint
        const minOut = quoted * 99n / 100n
        const tx = asTx(await contracts.pepeAMM.swapETHForUSDC(minOut, { value: ethIn }))
        await tx.wait()
        notify(`Swapped ${payAmount} ETH for ~${(Number(quoted) / 1e18).toFixed(2)} mUSDC ✓`, true, tx.hash)
      } else {
        const usdcIn = parseEther(payAmount)

        const currentAllowance = await contracts.usdc.allowance(
          wallet.address!,
          String(contracts.pepeAMM.target)
        ) as bigint

        if (currentAllowance < usdcIn) {
          notify('Approving mUSDC...', true)
          const approveTx = asTx(await contracts.usdc.approve(String(contracts.pepeAMM.target), usdcIn))
          await approveTx.wait()
        }

        const quoted    = await contracts.pepeAMM.quoteUSDCForETH(usdcIn) as bigint
        const minEthOut = quoted * 99n / 100n
        const tx = asTx(await contracts.pepeAMM.swapUSDCForETH(usdcIn, minEthOut))
        await tx.wait()
        notify(`Swapped ${payAmount} mUSDC for ~${(Number(quoted) / 1e18).toFixed(6)} ETH ✓`, true, tx.hash)
      }
      setPayAmount('')
      await new Promise(r => setTimeout(r, 1500))
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('swap', false) }
  }

  const addToWallet = async () => {
    if (!contracts || !(window as any).ethereum) return
    try {
      await (window as any).ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: contracts.usdc.target,
            symbol: 'mUSDC',
            decimals: 18,
          },
        },
      })
    } catch (e) {
      console.error('Add to wallet failed', e)
    }
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
      notify(prettyError(e), false)
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
      notify(prettyError(e), false)
    } finally { setLoad('withdraw', false) }
  }

  const openPosition = async () => {
    if (!contracts) return
    const amt = tryParse(openMgn)
    if (!amt) { notify('Enter a valid margin', false); return }
    if (amt > freeMgn) {
      notify('保證金不足，請先在 Margin Account 區塊 Approve & Deposit', false)
      return
    }
    setLoad('open', true)
    try {
      const tx = asTx(await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(leverage), { value: parseEther('0.001') }))
      await tx.wait()
      notify(`${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? selAsset} opened ✓`, true, tx.hash)
      setOpenMgn('')
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
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
      notify(prettyError(e), false)
    } finally { setLoad(key, false) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedAssetMeta = ASSET_META[selAsset]
  const kycRequired       = selectedAssetMeta?.regulated ?? false
  const kycBlocked        = kycRequired && !isKYCVerified

  const selEsg   = esg[selAsset] ?? null
  const isLowEsg = selEsg !== null && selEsg.composite < 50

  const openMgnBig = tryParse(openMgn)
  const notional   = openMgnBig !== null ? openMgnBig * BigInt(leverage) : 0n
  
  // Liquidation Price = Entry * (1 ± 1/Leverage)
  const liqPrice   = isLong 
    ? curPrice - (curPrice / BigInt(leverage))
    : curPrice + (curPrice / BigInt(leverage))

  // Map positions to dynamic live PnL
  const livePositions = positions.map(p => {
    // Convert float USD from Coingecko to 18-decimal fixed point
    const liveUsd = livePrices[p.asset]?.usd
    const currentLivePrice = liveUsd ? BigInt(Math.floor(liveUsd * 1e10)) : p.currentPrice
    
    const notional = p.margin * p.leverage
    const size = (notional * 10n**18n) / p.entryPrice
    const priceChange = currentLivePrice - p.entryPrice
    let livePnL = (priceChange * size) / 10n**18n
    if (!p.isLong) livePnL = -livePnL
    
    return { ...p, currentLivePrice, livePnL }
  })

  // Account Equity using LIVE PnL
  const totalUnrealizedPnL = livePositions.reduce((acc, p) => acc + p.livePnL, 0n)
  const accountEquity = freeMgn + totalUnrealizedPnL

  const activeTask = Object.entries(busy).find(([_, v]) => v)?.[0]
  const isBusy = !!activeTask
  let loadingMsg = 'Processing transaction...'
  if (activeTask) {
    if (activeTask === 'swap') loadingMsg = swapMode === 'eth-to-usdc' ? 'Swapping ETH to mUSDC...' : 'Swapping mUSDC to ETH...'
    else if (activeTask === 'deposit') loadingMsg = 'Depositing Margin...'
    else if (activeTask === 'withdraw') loadingMsg = 'Withdrawing Margin...'
    else if (activeTask === 'open') loadingMsg = 'Opening Position...'
    else if (activeTask.startsWith('close')) loadingMsg = 'Closing Position...'
  }

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
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6 fade-in relative">

      {/* Global Transaction Overlay */}
      {isBusy && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm fade-in">
          <div className="bg-surface-elev border border-brand-300/30 rounded-2xl p-8 flex flex-col items-center justify-center shadow-2xl max-w-sm mx-4 w-full">
            <div className="relative w-16 h-16 mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-surface-border"></div>
              <div className="absolute inset-0 rounded-full border-4 border-brand-400 border-t-transparent animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl">🐸</span>
              </div>
            </div>
            <h3 className="text-lg font-bold text-white mb-2">{loadingMsg}</h3>
            <p className="text-sm text-gray-400 text-center">
              Please confirm the transaction in your wallet and wait for block confirmation.
            </p>
          </div>
        </div>
      )}

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
        <h3 className="text-sm font-semibold text-info">How CFD trading works on PepeFi</h3>
        <ol className="text-xs text-gray-300 space-y-1 list-decimal list-inside leading-relaxed">
          <li><strong>Swap:</strong> Swap ETH for mUSDC to get your stablecoin collateral.</li>
          <li><strong>Margin Account:</strong> Approve &amp; deposit mUSDC into PerpetualExchange. This becomes your free margin.</li>
          <li><strong>Open Position:</strong> Use free margin to open long/short on 11 synthetic assets — crypto (sBTC, sETH), equity (sAAPL, sTSLA, sNVDA, sMSFT, sGOOGL), commodity (sGOLD), bond (sBOND), and ESG ETFs (sICLN, sESGU). 🔒 = KYC required.</li>
          <li><strong>PnL:</strong> Price moves → position value changes → close to realize PnL.</li>
        </ol>
      </div>

      {/* A & B — Swap + Margin */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* A. Swap (Uniswap Style) */}
        <div className="rounded-3xl border border-surface-border bg-[#0D111C] shadow-2xl p-2 space-y-1 relative max-w-md mx-auto w-full md:mx-0">
          
          <div className="flex justify-between items-center px-4 pt-3 pb-2">
            <h2 className="text-base font-semibold text-white">Swap</h2>
            <div className="flex gap-3 text-gray-400">
              <button className="hover:text-white transition-colors" title="Settings">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              </button>
            </div>
          </div>
          
          {/* Pay Block */}
          <div className="bg-[#131A2A] hover:border-gray-700 border border-transparent rounded-2xl p-4 transition-colors group">
            <div className="flex justify-between text-sm text-gray-400 mb-2">
              <span>You pay</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number" min="0" placeholder="0"
                value={payAmount}
                onChange={e => setPayAmount(e.target.value)}
                className="w-full bg-transparent text-4xl text-white focus:outline-none placeholder-gray-600 font-medium"
              />
              {swapMode === 'eth-to-usdc' ? (
                <button className="shrink-0 flex items-center gap-2 bg-[#293249] hover:bg-[#323D59] text-white font-semibold rounded-full py-1.5 px-3 transition-colors shadow-sm">
                  <img src="https://assets.coingecko.com/coins/images/279/standard/ethereum.png" alt="ETH" className="w-5 h-5 rounded-full" />
                  ETH
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              ) : (
                <button className="shrink-0 flex items-center gap-2 bg-[#293249] hover:bg-[#323D59] text-white font-semibold rounded-full py-1.5 px-3 transition-colors shadow-sm">
                  <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-[10px] font-bold">m</div>
                  mUSDC
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              )}
            </div>
            <div className="flex justify-between text-sm text-gray-500 mt-2">
              <span>$ {swapMode === 'eth-to-usdc'
                ? (parseFloat(payAmount || '0') * Number(ammPrice) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : parseFloat(payAmount || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <span className="cursor-pointer hover:text-white transition-colors">
                Balance: {swapMode === 'eth-to-usdc' ? ethBal : f18(usdcBal)}
              </span>
            </div>
          </div>

          {/* Switch direction button */}
          <div className="flex justify-center -my-5 relative z-10">
            <button
              onClick={() => { setSwapMode(m => m === 'eth-to-usdc' ? 'usdc-to-eth' : 'eth-to-usdc'); setPayAmount(''); setReceiveAmount('') }}
              className="bg-[#131A2A] rounded-xl p-1.5 border-4 border-[#0D111C] text-white hover:bg-[#1e2a45] transition-colors"
              title="Switch direction"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/>
              </svg>
            </button>
          </div>

          {/* Receive Block */}
          <div className="bg-[#131A2A] hover:border-gray-700 border border-transparent rounded-2xl p-4 transition-colors group">
            <div className="flex justify-between text-sm text-gray-400 mb-2">
              <span>You receive</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number" min="0" placeholder="0"
                value={receiveAmount}
                onChange={e => {
                  const v = e.target.value
                  setReceiveAmount(v)
                  const r = parseFloat(v || '0')
                  const price = Number(ammPrice) / 1e18
                  if (r > 0 && price > 0) {
                    if (swapMode === 'eth-to-usdc') setPayAmount((r / price).toFixed(6))
                    else setPayAmount((r * price).toFixed(2))
                  } else {
                    setPayAmount('')
                  }
                }}
                className="w-full bg-transparent text-4xl text-white focus:outline-none placeholder-gray-600 font-medium"
              />
              {swapMode === 'eth-to-usdc' ? (
                <button className="shrink-0 flex items-center gap-2 bg-[#293249] hover:bg-[#323D59] text-white font-semibold rounded-full py-1.5 px-3 transition-colors shadow-sm">
                  <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-[10px] font-bold">m</div>
                  mUSDC
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              ) : (
                <button className="shrink-0 flex items-center gap-2 bg-[#293249] hover:bg-[#323D59] text-white font-semibold rounded-full py-1.5 px-3 transition-colors shadow-sm">
                  <img src="https://assets.coingecko.com/coins/images/279/standard/ethereum.png" alt="ETH" className="w-5 h-5 rounded-full" />
                  ETH
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              )}
            </div>
            <div className="flex justify-between text-sm text-gray-500 mt-2">
              <span>$ {swapMode === 'eth-to-usdc'
                ? parseFloat(receiveAmount || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : (parseFloat(receiveAmount || '0') * Number(ammPrice) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <span className="cursor-pointer hover:text-white transition-colors">
                Balance: {swapMode === 'eth-to-usdc' ? f18(usdcBal) : ethBal}
              </span>
            </div>
          </div>

          {/* AMM pool info */}
          <div className="px-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>Rate: <span className="text-gray-300 font-mono">1 ETH = {ammPrice > 0n ? (Number(ammPrice) / 1e18).toFixed(2) : '–'} mUSDC</span></span>
            <span>Pool: <span className="text-gray-300 font-mono">{ammEth > 0n ? (Number(ammEth) / 1e18).toFixed(4) : '–'} ETH</span> / <span className="text-gray-300 font-mono">{ammUsdc > 0n ? (Number(ammUsdc) / 1e18).toFixed(2) : '–'} mUSDC</span></span>
          </div>

          <div className="pt-2 pb-1">
            <button
              onClick={() => void doSwap()}
              disabled={busy['swap'] || !payAmount || parseFloat(payAmount) <= 0}
              className={`w-full py-4 rounded-2xl text-xl font-bold transition-colors ${
                !payAmount || parseFloat(payAmount) <= 0
                  ? 'bg-[#131A2A] text-gray-500 cursor-not-allowed'
                  : 'bg-brand-500 hover:bg-brand-400 text-white shadow-lg shadow-brand-500/20'
              }`}
            >
              {busy['swap']
                ? 'Swapping…'
                : !payAmount || parseFloat(payAmount) <= 0
                  ? 'Enter an amount'
                  : swapMode === 'eth-to-usdc' ? 'Swap ETH → mUSDC' : 'Swap mUSDC → ETH'}
            </button>
          </div>
          
          <div className="text-center mt-2">
            <button 
              onClick={() => void addToWallet()} 
              className="text-xs text-blue-400 hover:text-blue-300 hover:underline flex items-center justify-center gap-1 w-full"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
              </svg>
              Don't see mUSDC? Add to MetaMask
            </button>
          </div>
        </div>

        {/* B. Margin & Account Equity */}
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-base font-bold text-white">Account Equity</h2>
              <p className="text-2xl font-mono text-white mt-1">
                {fUsd(accountEquity)} <span className="text-sm text-gray-400 font-sans">mUSDC</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400">Free Margin</p>
              <p className="font-mono text-white">{f18(freeMgn)}</p>
              <p className="text-xs text-gray-400 mt-1">Unrealized PnL</p>
              <p className={`font-mono ${pnlColor(totalUnrealizedPnL)}`}>{fPnL(totalUnrealizedPnL)}</p>
            </div>
          </div>
          
          <div className="h-px bg-surface-border w-full my-2"></div>

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

        {freeMgn === 0n && (
          <div className="rounded-lg border border-yellow-700/40 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-300">
            You have no free margin. Deposit mUSDC in the <strong>Margin Account</strong> section above first.
          </div>
        )}

        {kycBlocked && (
          <div className="rounded-lg border border-orange-700/40 bg-orange-900/20 px-4 py-3 text-sm text-orange-300 flex items-center justify-between gap-4">
            <span>
              🔒 <strong>{selectedAssetMeta?.symbol}</strong> 是股票 / 債券 / ETF 類資產，需要完成 KYC 驗證才能交易。
            </span>
            <button
              onClick={() => setShowKYCModal(true)}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-orange-700 hover:bg-orange-600 text-white text-xs font-bold transition-colors"
            >
              完成 KYC
            </button>
          </div>
        )}

        {isLowEsg && (
          <div className="rounded-lg border border-red-700/50 bg-red-950/40 px-4 py-3 space-y-2">
            <p className="text-sm text-red-300 font-semibold">
              ⚠ ESG 警告：此資產評分偏低（{selEsg!.composite}/100 · {selEsg!.rating}）
            </p>
            <p className="text-xs text-red-400/80">
              此資產 ESG 評分偏低，可能涉及較高環境、社會或治理風險，請謹慎評估永續投資風險後再決定是否開倉。
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={esgConfirmed}
                onChange={e => setEsgConfirmed(e.target.checked)}
                className="w-4 h-4 rounded accent-red-500"
              />
              <span className="text-xs text-red-200">我已了解此資產的 ESG 風險，仍要繼續交易</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">Asset</label>
            <select
              value={selAsset}
              onChange={e => setSelAsset(e.target.value as AssetId)}
              className="w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none"
            >
              {ASSETS.map(a => (
                <option key={a.id} value={a.id}>
                  {a.regulated ? '🔒 ' : ''}{a.symbol}
                  {a.category === 'etf' ? ' [ETF]' : ''}
                </option>
              ))}
            </select>
            {selEsg ? (
              <div className="pt-1 space-y-1">
                <div className="flex items-center gap-2">
                  <ESGBadge composite={selEsg.composite} rating={selEsg.rating} size="sm" />
                  <span className={`text-[11px] font-medium ${
                    selEsg.composite >= 65 ? 'text-emerald-400' :
                    selEsg.composite >= 40 ? 'text-amber-400'   : 'text-red-400'
                  }`}>
                    {selEsg.composite >= 65 ? '高永續評級' :
                     selEsg.composite >= 40 ? '中永續評級' : '低永續評級'}
                  </span>
                </div>
                <div className="flex gap-2 text-[10px] text-gray-500">
                  <span>E&nbsp;<span className="text-gray-300 font-mono">{selEsg.environmental}</span></span>
                  <span>S&nbsp;<span className="text-gray-300 font-mono">{selEsg.social}</span></span>
                  <span>G&nbsp;<span className="text-gray-300 font-mono">{selEsg.governance}</span></span>
                </div>
              </div>
            ) : contracts ? (
              <p className="text-[11px] text-gray-500 pt-1">ESG 資料載入中…</p>
            ) : null}
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
            <div className="text-[10px] text-gray-500 mt-1 text-right">Order Type: Market</div>
            <div className="text-[10px] text-brand-300 mt-0.5 text-right flex items-center justify-end gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              Execution Fee: 0.001 ETH
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
          {(() => {
            const fi = fundingData[selAsset]
            if (!fi) return null
            const rateNum = Number(fi.rate)
            const ratePct = (rateNum / 100).toFixed(4)
            return (
              <span className={`${rateNum > 0 ? 'text-red-400' : rateNum < 0 ? 'text-green-400' : 'text-gray-500'}`}>
                Funding rate (8h):{' '}
                <span className="font-mono">{rateNum >= 0 ? '+' : ''}{ratePct}%</span>
                {' '}{rateNum > 0 ? '(longs pay)' : rateNum < 0 ? '(shorts pay)' : '(balanced)'}
              </span>
            )
          })()}
          {openMgn && (
            <span className="text-red-400 border border-red-900/50 bg-red-900/20 px-2 rounded">
              Est. Liquidation: <span className="font-mono">{fUsd(liqPrice)}</span>
            </span>
          )}
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

        <div className="text-xs text-gray-400">
          Free margin: <span className="font-mono text-white">{f18(freeMgn)} mUSDC</span>
          {openMgnBig !== null && openMgnBig > freeMgn && (
            <span className="text-red-400 ml-2">
              ⚠ Insufficient — deposit at least {f18(openMgnBig - freeMgn)} more mUSDC first
            </span>
          )}
        </div>

        <button
          onClick={() => kycBlocked ? setShowKYCModal(true) : void openPosition()}
          disabled={
            busy['open'] ||
            !openMgn ||
            (openMgnBig !== null && openMgnBig > freeMgn) ||
            (kycBlocked && !openMgn) ||
            (isLowEsg && !esgConfirmed)
          }
          className={`px-8 py-2.5 rounded-lg text-white text-sm font-bold disabled:opacity-50 transition-colors ${
            kycBlocked
              ? 'bg-orange-700 hover:bg-orange-600'
              : isLowEsg && !esgConfirmed
                ? 'bg-red-900 cursor-not-allowed'
                : isLong ? 'bg-green-700 hover:bg-green-600' : 'bg-red-700 hover:bg-red-600'
          }`}
        >
          {busy['open']
            ? 'Opening…'
            : kycBlocked
              ? `🔒 完成 KYC 才能交易 ${ASSET_LABEL[selAsset] ?? ''}`
              : isLowEsg && !esgConfirmed
                ? '請先確認 ESG 風險'
                : `Open ${isLong ? 'Long' : 'Short'} ${ASSET_LABEL[selAsset] ?? ''}`}
        </button>
      </div>

      {/* KYC Modal */}
      <KYCModal
        isOpen={showKYCModal}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { refetchKYC(); setShowKYCModal(false) }}
        kycRegistry={contracts?.kycRegistry ?? null}
      />

      {/* ESG Leaderboard */}
      {Object.keys(esg).length > 0 && (
        <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-3">
          <h2 className="text-base font-bold text-white">ESG Leaderboard</h2>
          <div className="space-y-2">
            {Object.entries(esg)
              .sort(([, a], [, b]) => b.composite - a.composite)
              .map(([id, info]) => {
                const label = ASSET_LABEL[id as AssetId] ?? id.slice(0, 8)
                const barColor =
                  info.composite >= 80 ? 'bg-emerald-500' :
                  info.composite >= 60 ? 'bg-lime-500'    :
                  info.composite >= 40 ? 'bg-amber-500'   :
                                         'bg-red-500'
                return (
                  <div key={id} className="grid grid-cols-[60px_1fr_auto] gap-3 items-center">
                    <span className="text-xs font-mono text-gray-300">{label}</span>
                    <div className="flex gap-1 items-center">
                      {[
                        { label: 'E', val: info.environmental },
                        { label: 'S', val: info.social        },
                        { label: 'G', val: info.governance    },
                      ].map(({ label: l, val }) => (
                        <div key={l} className="flex-1">
                          <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
                            <span>{l}</span><span>{val}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-surface-elev overflow-hidden">
                            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${val}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <ESGBadge composite={info.composite} rating={info.rating} size="sm" />
                  </div>
                )
              })}
          </div>
        </div>
      )}

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
                {livePositions.map(row => {
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
                      <td className="py-2.5 pr-4 font-mono text-gray-300">{fUsd(row.currentLivePrice)}</td>
                      <td className="py-2.5 pr-4 font-mono text-gray-400">{f18(size, 6)}</td>
                      <td className="py-2.5 pr-4 font-mono text-gray-300">{f18(row.margin)}</td>
                      <td className="py-2.5 pr-4 text-gray-300">{String(row.leverage)}×</td>
                      <td className={`py-2.5 pr-4 font-mono font-semibold ${pnlColor(row.livePnL)}`}>
                        {fPnL(row.livePnL)}
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
