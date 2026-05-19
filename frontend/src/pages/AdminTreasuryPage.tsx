import { useState, useEffect, useCallback } from 'react'
import { parseEther, formatEther, formatUnits } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { explorerTx } from '../lib/notify'
import { prettyError } from '../lib/errorMessages'
import EmptyState from '../components/EmptyState'

// ── Helpers ───────────────────────────────────────────────────────────────────
type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

const f18 = (v: bigint, d = 2) =>
  Number(formatUnits(v, 18)).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
const fEth = (v: bigint) => parseFloat(formatEther(v)).toFixed(6)

const DEMO_OWNER = '0xE80A81360608C1342e66743F70a00f75d792Eb93'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

interface RevenueStats {
  platformEarnings: bigint
  myMusdc:          bigint
  myEth:            bigint
  routerEth:        bigint
}

interface CashOutRecord {
  type:       'claim' | 'swap'
  amount:     bigint
  usdcIn?:    bigint
  txHash:     string
  blockNumber: number
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminTreasuryPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [stats,           setStats]           = useState<RevenueStats | null>(null)
  const [platformTreasury, setPlatformTreasury] = useState<string | null>(null)
  const [swapAmt,         setSwapAmt]         = useState('')
  const [fundAmt,         setFundAmt]         = useState('')
  const [history,         setHistory]         = useState<CashOutRecord[]>([])
  const [busy,            setBusy]            = useState<Record<string, boolean>>({})
  const [toast,           setToast]           = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const isOwner = wallet.address?.toLowerCase() === DEMO_OWNER.toLowerCase()

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // ── Fetch stats ───────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      const [pending, myMusdc, myEth, routerEth, treasury] = await Promise.all([
        contracts.feeRouter.platformEarnings(),
        contracts.usdc.balanceOf(wallet.address),
        wallet.provider.getBalance(wallet.address),
        contracts.swapRouter.ethReserve(),
        contracts.feeRouter.platformTreasury(),
      ])
      setStats({
        platformEarnings: pending as bigint,
        myMusdc:          myMusdc as bigint,
        myEth:            myEth as bigint,
        routerEth:        routerEth as bigint,
      })
      setPlatformTreasury(treasury as string)
    } catch (e) {
      console.error('[treasury fetch]', e)
    }
  }, [contracts, wallet.address, wallet.provider])

  // ── Fetch history ─────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!contracts || !wallet.address || !wallet.provider) return
    try {
      const current   = await wallet.provider.getBlockNumber()
      const fromBlock = Math.max(0, current - 10000)

      const [claimLogs, swapLogs] = await Promise.all([
        contracts.feeRouter.queryFilter(
          contracts.feeRouter.filters.PlatformFeesWithdrawn(wallet.address),
          fromBlock, 'latest',
        ),
        contracts.swapRouter.queryFilter(
          contracts.swapRouter.filters.SwapUsdcToEth(wallet.address),
          fromBlock, 'latest',
        ),
      ])

      const records: CashOutRecord[] = []
      for (const log of claimLogs) {
        const args = (log as any).args
        records.push({
          type:        'claim',
          amount:      (args.amount ?? args[1] ?? 0n) as bigint,
          txHash:      log.transactionHash,
          blockNumber: log.blockNumber,
        })
      }
      for (const log of swapLogs) {
        const args = (log as any).args
        records.push({
          type:        'swap',
          amount:      (args.ethOut ?? args[2] ?? 0n) as bigint,
          usdcIn:      (args.usdcIn ?? args[1] ?? 0n) as bigint,
          txHash:      log.transactionHash,
          blockNumber: log.blockNumber,
        })
      }
      records.sort((a, b) => b.blockNumber - a.blockNumber)
      setHistory(records)
    } catch (e) {
      console.error('[history fetch]', e)
    }
  }, [contracts, wallet.address, wallet.provider])

  useEffect(() => {
    void fetchStats()
    void fetchHistory()
    const t = setInterval(() => { void fetchStats() }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, fetchHistory])

  // ── Actions ───────────────────────────────────────────────────────────────
  const doClaim = async () => {
    if (!contracts) return
    setLoad('claim', true)
    try {
      const tx = asTx(await contracts.feeRouter.withdrawPlatformFees())
      await tx.wait()
      notify('Platform fees claimed ✓', true, tx.hash)
      await fetchStats()
      await fetchHistory()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('claim', false) }
  }

  const doApprove = async () => {
    if (!contracts || !swapAmt) return
    setLoad('approve', true)
    try {
      const amt = parseEther(swapAmt)
      const tx  = asTx(await contracts.usdc.approve(String(contracts.swapRouter.target), amt))
      await tx.wait()
      notify('mUSDC approved ✓', true, tx.hash)
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const doSwapToEth = async () => {
    if (!contracts || !swapAmt) return
    setLoad('swap', true)
    try {
      const amt    = parseEther(swapAmt)
      const tx     = asTx(await contracts.swapRouter.swapUSDCForETH(amt))
      await tx.wait()
      const ethOut = (parseFloat(swapAmt) / 3000).toFixed(6)
      notify(`Swapped ${swapAmt} mUSDC → ${ethOut} ETH ✓`, true, tx.hash)
      setSwapAmt('')
      await fetchStats()
      await fetchHistory()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('swap', false) }
  }

  const doFundRouter = async () => {
    if (!contracts || !fundAmt) return
    setLoad('fund', true)
    try {
      const tx = asTx(await contracts.swapRouter.fundRouter({ value: parseEther(fundAmt) }))
      await tx.wait()
      notify(`Funded router with ${fundAmt} ETH ✓`, true, tx.hash)
      setFundAmt('')
      await fetchStats()
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally { setLoad('fund', false) }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to access Treasury Admin.
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <div className="text-4xl">🔒</div>
        <div className="text-lg font-semibold text-white">Not authorized</div>
        <div className="text-sm text-gray-500">This page is restricted to the platform owner wallet.</div>
        <div className="text-xs text-gray-600 font-mono mt-1">
          Owner: {DEMO_OWNER.slice(0, 10)}…{DEMO_OWNER.slice(-6)}
        </div>
      </div>
    )
  }

  // ── Router insufficient check ─────────────────────────────────────────────
  const ethNeeded = (() => {
    try { return swapAmt ? parseEther((parseFloat(swapAmt) / 3000).toFixed(18)) : 0n }
    catch { return 0n }
  })()
  const routerInsufficient = ethNeeded > 0n && !!stats && stats.routerEth < ethNeeded

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-xl ${
          toast.ok ? 'bg-emerald-800 text-emerald-100' : 'bg-red-900 text-red-100'
        }`}>
          {toast.msg}
          {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
            <a href={explorerTx(toast.hash, wallet.chainId)!} target="_blank" rel="noopener noreferrer"
              className="block mt-1 text-xs underline opacity-80 hover:opacity-100">
              View on Etherscan ↗
            </a>
          )}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Treasury Admin</h1>
        <p className="text-sm text-gray-400 mt-0.5">Cash out accumulated platform fees → ETH</p>
      </div>

      {/* A. Revenue Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Pending Platform Fees', value: stats ? f18(stats.platformEarnings) + ' mUSDC' : '—', accent: true  },
          { label: 'Wallet mUSDC Balance',  value: stats ? f18(stats.myMusdc) + ' mUSDC'          : '—', accent: false },
          { label: 'Wallet ETH Balance',    value: stats ? fEth(stats.myEth) + ' ETH'             : '—', accent: false },
          { label: 'Router ETH Reserve',    value: stats ? fEth(stats.routerEth) + ' ETH'         : '—', accent: false },
        ].map(s => (
          <div key={s.label} className="bg-surface-sub rounded-xl p-4 border border-surface-border">
            <div className="text-xs text-gray-500 mb-1">{s.label}</div>
            <div className={`text-base font-mono font-semibold truncate ${s.accent ? 'text-brand-100' : 'text-white'}`}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* B. Step 1: Claim */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-brand-400/20 text-brand-100 text-xs font-bold shrink-0">1</span>
          <h2 className="text-base font-bold text-white">Claim Platform Fees from FeeRouter</h2>
        </div>

        {platformTreasury && (
          <div className="text-xs text-gray-500">
            Treasury: <span className="font-mono">{platformTreasury}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs text-gray-400 mb-1">Pending platform fees</div>
            <div className="text-2xl font-mono font-bold text-brand-100">
              {stats ? f18(stats.platformEarnings) : '—'} <span className="text-sm text-gray-400">mUSDC</span>
            </div>
          </div>
          <button
            onClick={() => void doClaim()}
            disabled={busy['claim'] || !stats || stats.platformEarnings === 0n}
            className="px-5 py-2.5 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-50 text-white font-semibold text-sm transition-colors"
          >
            {busy['claim'] ? 'Claiming…' : 'Claim Platform Fees'}
          </button>
        </div>

        <p className="text-xs text-gray-600">
          This transfers all accumulated platform-share fees (20% of each copy / performance fee) to your wallet.
        </p>
      </div>

      {/* C. Step 2: Convert mUSDC → ETH */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-brand-400/20 text-brand-100 text-xs font-bold shrink-0">2</span>
          <h2 className="text-base font-bold text-white">Convert mUSDC → ETH via SwapRouter</h2>
        </div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="number" min="0" placeholder="mUSDC amount"
              value={swapAmt}
              onChange={e => setSwapAmt(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-brand-300"
            />
            <button
              onClick={() => stats && setSwapAmt(formatUnits(stats.myMusdc, 18))}
              disabled={!stats || stats.myMusdc === 0n}
              className="px-3 py-2 rounded-lg bg-gray-700 text-gray-300 text-xs hover:bg-gray-600 disabled:opacity-40 transition-colors"
            >
              Max
            </button>
          </div>
          {swapAmt && parseFloat(swapAmt) > 0 && (
            <div className="text-xs text-gray-500">
              ≈ {(parseFloat(swapAmt) / 3000).toFixed(6)} ETH (rate: 1 ETH = 3000 mUSDC)
            </div>
          )}
        </div>

        {routerInsufficient && (
          <div className="rounded-xl bg-yellow-900/30 border border-yellow-700/40 px-3 py-2 text-xs text-yellow-300 flex items-start gap-2">
            <span>⚠</span>
            <span>
              Router only has {stats ? fEth(stats.routerEth) : '0'} ETH available.
              Fund it using the Treasury Tools below before swapping.
            </span>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => void doApprove()}
            disabled={busy['approve'] || !swapAmt || parseFloat(swapAmt) <= 0}
            className="flex-1 py-2.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {busy['approve'] ? 'Approving…' : '① Approve mUSDC'}
          </button>
          <button
            onClick={() => void doSwapToEth()}
            disabled={busy['swap'] || !swapAmt || parseFloat(swapAmt) <= 0}
            className="flex-1 py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {busy['swap'] ? 'Swapping…' : '② Swap to ETH'}
          </button>
        </div>
      </div>

      {/* E. Treasury Tools */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-4">
        <h2 className="text-base font-bold text-white">Treasury Tools</h2>

        <div>
          <div className="text-sm font-medium text-gray-300 mb-1">Fund SwapRouter with ETH</div>
          <p className="text-xs text-gray-600 mb-3">
            The router needs an ETH reserve to fulfill mUSDC→ETH swaps from users and admin.
            Current reserve: <span className="font-mono text-gray-400">{stats ? fEth(stats.routerEth) : '—'} ETH</span>
          </p>
          <div className="flex gap-2">
            <input
              type="number" min="0" step="0.01" placeholder="ETH amount (e.g. 1)"
              value={fundAmt}
              onChange={e => setFundAmt(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-brand-300"
            />
            <button
              onClick={() => void doFundRouter()}
              disabled={busy['fund'] || !fundAmt || parseFloat(fundAmt) <= 0}
              className="px-4 py-2 rounded-lg bg-info/10 hover:bg-info/20 disabled:opacity-50 text-info text-sm font-semibold border border-info/30 transition-colors"
            >
              {busy['fund'] ? 'Funding…' : 'Fund Router'}
            </button>
          </div>
        </div>
      </div>

      {/* D. Cash Out History */}
      <div className="rounded-card border border-surface-border bg-surface shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Recent Cash Out History</h2>
          <button onClick={() => void fetchHistory()} className="text-xs text-gray-500 hover:text-white transition-colors">
            ↺ Refresh
          </button>
        </div>

        {history.length === 0 ? (
          <EmptyState icon="📋" title="No cash out history yet" description="Fee claims and USDC→ETH swaps will appear here." />
        ) : (
          <div className="divide-y divide-surface-border">
            {history.slice(0, 20).map((r, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                    r.type === 'claim'
                      ? 'bg-brand-400/20 text-brand-100'
                      : 'bg-emerald-900/50 text-emerald-300'
                  }`}>
                    {r.type === 'claim' ? 'Claimed' : 'Swapped'}
                  </span>
                  <span className="font-mono text-white">
                    {r.type === 'claim'
                      ? `${f18(r.amount)} mUSDC`
                      : `${r.usdcIn ? f18(r.usdcIn) : '—'} mUSDC → ${fEth(r.amount)} ETH`}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs shrink-0">
                  <span className="text-gray-600">#{r.blockNumber}</span>
                  {explorerTx(r.txHash, wallet.chainId) && (
                    <a
                      href={explorerTx(r.txHash, wallet.chainId)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-500 hover:text-emerald-300 transition-colors"
                    >
                      Etherscan ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="rounded-xl border border-surface-border bg-surface-sub px-5 py-4 text-xs text-gray-500 space-y-1">
        <p><span className="text-gray-400 font-semibold">Revenue model:</span> Each copy-trade or performance fee is split 70% trader / 20% platform / 10% insurance vault. Platform fees accumulate in FeeRouter until this admin claims them.</p>
        <p>After claiming mUSDC, use the swap above to convert to ETH at the mock rate (1 ETH = 3000 mUSDC). In production, you'd use a real DEX.</p>
      </div>
    </div>
  )
}
