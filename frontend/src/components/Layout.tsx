import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import WalletButton from './WalletButton'
import { CHAIN_NAMES } from '../contracts/addresses'

const NAV = [
  { to: '/',            label: 'Home'        },
  { to: '/exchange',    label: 'Exchange'    },
  { to: '/trader',      label: 'Trader'      },
  { to: '/marketplace', label: 'Marketplace' },
  { to: '/portfolio',   label: 'Portfolio'   },
  { to: '/admin/oracle', label: 'Admin'      },
]


interface Props {
  wallet:   WalletAPI
  children: ReactNode
}

export default function Layout({ wallet, children }: Props) {
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('disclaimer-dismissed') === '1'
  )
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (dismissed) localStorage.setItem('disclaimer-dismissed', '1')
  }, [dismissed])

  const chainLabel    = wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId] ?? `Chain ${wallet.chainId}`) : null
  const chainBadgeColor = wallet.chainId === 31337
    ? 'bg-emerald-900 text-emerald-300 border-emerald-700'
    : wallet.chainId === 11155111
      ? 'bg-yellow-900 text-yellow-300 border-yellow-700'
      : 'bg-red-900 text-red-300 border-red-700'

  const switchToAnvil = async () => {
    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
    if (!eth) return
    setSwitching(true)
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] })
    } catch (err: any) {
      if (err.code === 4902) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x7a69',
              chainName: 'Anvil Local',
              rpcUrls: ['http://localhost:8545'],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            }],
          })
        } catch { /* user rejected — ignore */ }
      }
    } finally {
      setSwitching(false)
    }
  }

  const switchToSepolia = async () => {
    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
    if (!eth) return
    setSwitching(true)
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] })
    } catch (err: any) {
      if (err.code === 4902) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xaa36a7',
              chainName: 'Sepolia Testnet',
              rpcUrls: ['https://sepolia.infura.io/v3/'],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            }],
          })
        } catch { /* user rejected */ }
      }
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Disclaimer banner */}
      {!dismissed && (
        <div className="bg-yellow-900/60 border-b border-yellow-700 px-6 py-2 flex items-center justify-between text-xs text-yellow-300">
          <span>
            Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
          </span>
          <button
            onClick={() => setDismissed(true)}
            className="ml-4 text-yellow-500 hover:text-yellow-200 transition-colors shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-6">
        <span className="font-bold text-lg tracking-tight text-emerald-400 shrink-0">
          PepeLab CFD
        </span>
        <nav className="flex gap-5 flex-1 flex-wrap">
          {NAV.map(n => (
            <Link
              key={n.to}
              to={n.to}
              className={`text-sm font-medium transition-colors ${
                pathname === n.to || (n.to !== '/' && pathname.startsWith(n.to))
                  ? 'text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {/* Network badge */}
          {wallet.isConnected && chainLabel && (
            <span className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${chainBadgeColor}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
              {chainLabel}
            </span>
          )}

          {/* Network Switchers */}
          {wallet.isConnected && (
            <div className="hidden sm:flex gap-2">
              {wallet.chainId !== 11155111 && (
                <button
                  onClick={() => void switchToSepolia()}
                  disabled={switching}
                  className="px-3 py-1 rounded-lg bg-indigo-900 hover:bg-indigo-800 disabled:opacity-50 text-indigo-200 text-xs font-semibold transition-colors border border-indigo-700"
                >
                  {switching ? '…' : 'Switch to Sepolia'}
                </button>
              )}
              {wallet.chainId !== 31337 && (
                <button
                  onClick={() => void switchToAnvil()}
                  disabled={switching}
                  className="px-3 py-1 rounded-lg bg-emerald-900 hover:bg-emerald-800 disabled:opacity-50 text-emerald-200 text-xs font-semibold transition-colors border border-emerald-700"
                >
                  {switching ? '…' : 'Switch to Anvil'}
                </button>
              )}
            </div>
          )}

          <WalletButton wallet={wallet} />
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-800 px-6 py-3 text-center text-xs text-gray-600">
        Research prototype · Anvil local / Sepolia testnet · No real assets
      </footer>
    </div>
  )
}
