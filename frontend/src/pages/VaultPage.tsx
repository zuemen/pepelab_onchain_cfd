import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import { parseUnits, formatUnits } from 'ethers'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { explorerTx } from '../lib/notify'
import { prettyError } from '../lib/errorMessages'
import Skeleton from '../components/Skeleton'
import EmptyState from '../components/EmptyState'

interface Props {
  wallet: WalletAPI
}

interface VaultStats {
  totalAssets:  bigint
  totalSupply:  bigint
  sharePrice:   bigint
  myShares:     bigint
  myUsdcValue:  bigint
}

interface ActivityEntry {
  type:   'Deposited' | 'Withdrawn' | 'ProtocolDeposit' | 'Bailout'
  label:  string
  amount: string
  from:   string
  block:  number
}

const ZERO = 0n

function f18(v: bigint, dec = 2): string {
  return Number(formatUnits(v, 18)).toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  })
}

async function fetchActivity(vault: Contract): Promise<ActivityEntry[]> {
  const events: ActivityEntry[] = []
  try {
    const filter1 = vault.filters.Deposited()
    const filter2 = vault.filters.Withdrawn()
    const filter3 = vault.filters.ProtocolDeposit()
    const filter4 = vault.filters.Bailout()

    const [dep, wit, pro, bai] = await Promise.all([
      vault.queryFilter(filter1, -200),
      vault.queryFilter(filter2, -200),
      vault.queryFilter(filter3, -200),
      vault.queryFilter(filter4, -200),
    ])

    for (const e of dep) {
      const args = (e as any).args
      events.push({ type: 'Deposited', label: 'LP Deposit', amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber ?? 0 })
    }
    for (const e of wit) {
      const args = (e as any).args
      events.push({ type: 'Withdrawn', label: 'LP Withdraw', amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber ?? 0 })
    }
    for (const e of pro) {
      const args = (e as any).args
      events.push({ type: 'ProtocolDeposit', label: 'Protocol Fee', amount: f18(args.amount) + ' USDC', from: args.from, block: e.blockNumber ?? 0 })
    }
    for (const e of bai) {
      const args = (e as any).args
      events.push({ type: 'Bailout', label: 'Bailout Paid', amount: f18(args.amount) + ' USDC', from: args.trader, block: e.blockNumber ?? 0 })
    }

    events.sort((a, b) => b.block - a.block)
  } catch { /* ignore */ }
  return events
}

export default function VaultPage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const vault     = contracts?.insuranceVault ?? null
  const usdc      = contracts?.usdc ?? null

  const [stats, setStats]         = useState<VaultStats | null>(null)
  const [activity, setActivity]   = useState<ActivityEntry[]>([])
  const [depositAmt, setDepositAmt] = useState('')
  const [withdrawAmt, setWithdrawAmt] = useState('')
  const [busy, setBusy]           = useState(false)
  const [toast, setToast]         = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const notify = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  const fetchStats = useCallback(async () => {
    if (!vault || !wallet.address) return
    try {
      const [totalAssets, totalSupply, sharePrice, myShares] = await Promise.all([
        vault.totalAssets()    as Promise<bigint>,
        vault.totalSupply()    as Promise<bigint>,
        vault.getSharePrice()  as Promise<bigint>,
        vault.balanceOf(wallet.address) as Promise<bigint>,
      ])
      const myUsdcValue = totalSupply > ZERO
        ? myShares * totalAssets / totalSupply
        : ZERO
      setStats({ totalAssets, totalSupply, sharePrice, myShares, myUsdcValue })
    } catch { /* not deployed */ }
  }, [vault, wallet.address])

  useEffect(() => {
    void fetchStats()
    if (vault) void fetchActivity(vault).then(setActivity)
    const t = setInterval(() => { void fetchStats() }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, vault])

  const doDeposit = async () => {
    if (!vault || !usdc || !wallet.signer) return
    setBusy(true)
    try {
      const amount = parseUnits(depositAmt.trim(), 18)
      const approveTx = await usdc.approve(await vault.getAddress(), amount)
      await approveTx.wait()
      const tx = await vault.deposit(amount)
      await tx.wait()
      notify(`Deposited ${depositAmt} USDC ✓`, true, tx.hash)
      setDepositAmt('')
      await fetchStats()
      if (vault) setActivity(await fetchActivity(vault))
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  const doWithdraw = async () => {
    if (!vault || !wallet.signer) return
    setBusy(true)
    try {
      const shares = parseUnits(withdrawAmt.trim(), 18)
      const tx = await vault.withdraw(shares)
      await tx.wait()
      notify(`Withdrew ${withdrawAmt} pIV shares ✓`, true, tx.hash)
      setWithdrawAmt('')
      await fetchStats()
      if (vault) setActivity(await fetchActivity(vault))
    } catch (e: any) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        Connect wallet to use the LP Vault.
      </div>
    )
  }

  const activityColor: Record<ActivityEntry['type'], string> = {
    Deposited:      'text-green-400',
    Withdrawn:      'text-yellow-400',
    ProtocolDeposit:'text-blue-400',
    Bailout:        'text-red-400',
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Assets', value: stats ? f18(stats.totalAssets) + ' USDC' : null },
          { label: 'Share Price',  value: stats ? f18(stats.sharePrice) + ' USDC/pIV' : null },
          { label: 'Total Supply', value: stats ? f18(stats.totalSupply) + ' pIV' : null },
          { label: 'My pIV Value', value: stats ? f18(stats.myUsdcValue) + ' USDC' : null },
        ].map(s => (
          <div key={s.label} className="bg-surface-sub rounded-xl p-4 border border-surface-border">
            <div className="text-xs text-gray-500 mb-1">{s.label}</div>
            {s.value === null
              ? <Skeleton className="h-7 w-28 mt-1" />
              : <div className="text-lg font-mono font-semibold text-white">{s.value}</div>
            }
          </div>
        ))}
      </div>

      {/* Your position */}
      {stats && stats.myShares > ZERO && (
        <div className="bg-surface-sub rounded-xl p-5 border border-surface-border">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Your Position</h2>
          <div className="flex gap-8 text-sm">
            <div>
              <span className="text-gray-500">pIV held: </span>
              <span className="font-mono text-white">{f18(stats.myShares, 4)}</span>
            </div>
            <div>
              <span className="text-gray-500">USDC value: </span>
              <span className="font-mono text-green-400">{f18(stats.myUsdcValue)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Deposit + Withdraw */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Deposit */}
        <div className="bg-surface-sub rounded-xl p-5 border border-surface-border space-y-3">
          <h2 className="text-sm font-semibold text-gray-300">Deposit USDC</h2>
          <p className="text-xs text-gray-500">
            Receive pIV shares proportional to current pool size. Earn yield from protocol fees.
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              placeholder="USDC amount"
              value={depositAmt}
              onChange={e => setDepositAmt(e.target.value)}
              className="flex-1 bg-surface rounded-lg px-3 py-2 text-sm font-mono text-white border border-surface-border focus:outline-none focus:border-brand-300"
            />
            <button
              onClick={() => void doDeposit()}
              disabled={busy || !depositAmt}
              className="px-4 py-2 rounded-lg bg-brand-400/20 hover:bg-brand-400/30 disabled:opacity-50 text-brand-100 text-sm font-semibold border border-brand-300/30 transition-colors"
            >
              {busy ? '…' : 'Deposit'}
            </button>
          </div>
          {stats && depositAmt && (
            <div className="text-xs text-gray-500">
              ≈ {f18((stats.totalSupply > ZERO && stats.totalAssets > ZERO)
                ? BigInt(Math.floor(Number(depositAmt) * 1e18)) * stats.totalSupply / stats.totalAssets
                : BigInt(Math.floor(Number(depositAmt) * 1e18)), 4)} pIV
            </div>
          )}
        </div>

        {/* Withdraw */}
        <div className="bg-surface-sub rounded-xl p-5 border border-surface-border space-y-3">
          <h2 className="text-sm font-semibold text-gray-300">Withdraw Shares</h2>
          <p className="text-xs text-gray-500">
            Burn pIV shares to receive proportional USDC from the pool.
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              placeholder="pIV shares"
              value={withdrawAmt}
              onChange={e => setWithdrawAmt(e.target.value)}
              className="flex-1 bg-surface rounded-lg px-3 py-2 text-sm font-mono text-white border border-surface-border focus:outline-none focus:border-brand-300"
            />
            <button
              onClick={() => void doWithdraw()}
              disabled={busy || !withdrawAmt}
              className="px-4 py-2 rounded-lg bg-warn/10 hover:bg-warn/20 disabled:opacity-50 text-warn text-sm font-semibold border border-warn/30 transition-colors"
            >
              {busy ? '…' : 'Withdraw'}
            </button>
          </div>
          {stats && withdrawAmt && (
            <div className="text-xs text-gray-500">
              ≈ {f18(stats.totalSupply > ZERO
                ? BigInt(Math.floor(Number(withdrawAmt) * 1e18)) * stats.totalAssets / stats.totalSupply
                : 0n, 4)} USDC
            </div>
          )}
          {stats && stats.myShares > ZERO && (
            <button
              onClick={() => setWithdrawAmt(formatUnits(stats.myShares, 18))}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              Max ({f18(stats.myShares, 4)} pIV)
            </button>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg px-5 py-3 text-sm font-medium shadow-xl ${toast.ok ? 'bg-emerald-800 text-emerald-100' : 'bg-red-900 text-red-100'}`}>
          {toast.msg}
          {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
            <a
              href={explorerTx(toast.hash, wallet.chainId)!}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-xs underline opacity-80"
            >
              View on Etherscan ↗
            </a>
          )}
        </div>
      )}

      {/* Activity Feed */}
      <div className="bg-surface-sub rounded-xl border border-surface-border overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-border">
          <h2 className="text-sm font-semibold text-gray-300">Recent Activity</h2>
        </div>
        {activity.length === 0 ? (
          <EmptyState icon="🏦" title="No activity yet" description="Deposit USDC to start earning yield from protocol fees." />
        ) : (
          <div className="divide-y divide-surface-border">
            {activity.slice(0, 20).map((a, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`font-semibold ${activityColor[a.type]}`}>{a.label}</span>
                  <span className="text-gray-600 font-mono text-xs truncate max-w-[120px]">{a.from.slice(0, 10)}…</span>
                </div>
                <div className="text-right">
                  <span className="font-mono text-white">{a.amount}</span>
                  <span className="text-gray-600 text-xs ml-2">#{a.block}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="rounded-xl border border-surface-border bg-surface-sub px-5 py-4 text-xs text-gray-500 space-y-1">
        <p><span className="text-gray-400 font-semibold">How it works:</span> LPs deposit USDC and receive pIV shares. The vault earns 10% of all copy-trading and performance fees via the FeeRouter. It also absorbs remaining collateral from liquidated positions.</p>
        <p>When a trader's loss exceeds their margin (extreme event), the vault pays a 10% bailout floor directly to the trader. LPs bear this risk in exchange for the yield.</p>
      </div>
    </div>
  )
}
