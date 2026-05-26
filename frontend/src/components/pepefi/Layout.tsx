import type { ReactNode } from 'react'
import type { WalletAPI } from 'src/hooks/useWallet'
import type { WhaleAlert } from 'src/hooks/useWhaleAlerts'

import { useState } from 'react'
import { Link, useLocation } from 'react-router'

import { CHAIN_NAMES, getAddresses } from 'src/contracts/addresses'

import WalletButton from './WalletButton'
import WhaleAlertBanner from './WhaleAlertBanner'

const DEMO_OWNER = '0xE80A81360608C1342e66743F70a00f75d792Eb93'

const NAV = [
  { to: '/',            label: 'Home',          icon: '⌂' },
  { to: '/dashboard',   label: 'Dashboard',     icon: '◉' },
  { to: '/exchange',    label: 'Exchange',       icon: '⇄' },
  { to: '/trader',      label: 'Trader',         icon: '◈' },
  { to: '/stake',       label: 'Stake',          icon: '◆' },
  { to: '/marketplace', label: 'Marketplace',    icon: '⊞' },
  { to: '/esg',         label: 'ESG Explorer',   icon: '🌱' },
  { to: '/portfolio',   label: 'Portfolio',      icon: '◑' },
  { to: '/vault',       label: 'LP Vault',       icon: '◎' },
  { to: '/history',     label: 'History',        icon: '☰' },
  { to: '/whale',       label: 'Whale Tracker',  icon: '🐋' },
]

const ADMIN_NAV = [
  { to: '/admin/oracle',   label: 'Oracle & Keeper', icon: '⚙' },
  { to: '/admin/treasury', label: 'Cash Out',        icon: '◈' },
]

const PAGE_TITLES: Record<string, string> = {
  '/':               'Home',
  '/dashboard':      'Dashboard',
  '/exchange':       'Exchange',
  '/trader':         'Trader Dashboard',
  '/stake':          'Trader Stake',
  '/marketplace':    'Marketplace',
  '/esg':            'ESG Explorer',
  '/portfolio':      'Portfolio',
  '/vault':          'LP Vault',
  '/history':        'Transaction History',
  '/whale':          'Whale Tracker',
  '/admin/oracle':   'Oracle Admin',
  '/admin/treasury': 'Treasury Admin',
}

interface Props {
  wallet:         WalletAPI
  children:       ReactNode
  isKYCVerified?: boolean
  whaleAlerts?:   WhaleAlert[]
}

export default function Layout({ wallet, children, isKYCVerified, whaleAlerts }: Props) {
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('disclaimer-dismissed') === '1'
  )
  const [demoDismissed, setDemoDismissed] = useState(
    () => localStorage.getItem('demo-banner-dismissed') === '1'
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [switching, setSwitching] = useState(false)

  const addresses   = getAddresses(wallet.chainId)
  const isOwner     = wallet.address?.toLowerCase() === DEMO_OWNER.toLowerCase()
  const showDemoBanner = isOwner && !demoDismissed

  const chainLabel = wallet.chainId !== null
    ? (CHAIN_NAMES[wallet.chainId] ?? `Chain ${wallet.chainId}`)
    : null

  const chainBadgeColor = wallet.chainId === 31337
    ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700'
    : wallet.chainId === 11155111
      ? 'bg-yellow-900/60 text-yellow-300 border-yellow-700'
      : 'bg-red-900/60 text-red-300 border-red-700'

  const pageTitle = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/trader/') ? 'Trader Profile'
      : pathname.startsWith('/copy/')   ? 'Copy Trader'
      : 'PepeFi CFD')

  const switchToAnvil = async () => {
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
    if (!eth) return
    setSwitching(true)
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] })
    } catch (err: any) {
      if (err.code === -32002) {
        /* pending — ignore */
      } else if (err.code === 4902) {
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
        } catch { /* user rejected */ }
      }
    } finally {
      setSwitching(false)
    }
  }

  const switchToSepolia = async () => {
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
    if (!eth) return
    setSwitching(true)
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] })
    } catch (err: any) {
      if (err.code === -32002) {
        /* pending — ignore */
      } else if (err.code === 4902) {
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

  const renderSidebarContent = () => (
    <>
      <div className="px-5 py-5 border-b border-surface-border shrink-0">
        <div className="font-extrabold text-xl tracking-tight text-brand-200">PepeFi</div>
        <div className="text-xs text-gray-500 mt-0.5">On-Chain CFD · PoC</div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV.map(({ to, label, icon }) => {
          const active = pathname === to || (to !== '/' && pathname.startsWith(to))
          return (
            <Link
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-brand-400/20 text-brand-100'
                  : 'text-gray-400 hover:text-gray-100 hover:bg-surface-elev'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-brand-200 rounded-r-full" />
              )}
              <span className="w-5 text-center">{icon}</span>
              {label}
            </Link>
          )
        })}

        {/* Admin section — sub-menu for owner, single link for others */}
        {isOwner ? (
          <>
            <div className="px-3 pt-3 pb-0.5 text-[10px] text-gray-600 uppercase tracking-widest font-semibold select-none">
              Admin
            </div>
            {ADMIN_NAV.map(({ to, label, icon }) => {
              const active = pathname === to
              return (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setSidebarOpen(false)}
                  className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-brand-400/20 text-brand-100'
                      : 'text-gray-400 hover:text-gray-100 hover:bg-surface-elev'
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-brand-200 rounded-r-full" />
                  )}
                  <span className="w-5 text-center">{icon}</span>
                  {label}
                </Link>
              )
            })}
          </>
        ) : (
          <Link
            to="/pepefi/admin/oracle"
            onClick={() => setSidebarOpen(false)}
            className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              pathname.startsWith('/admin')
                ? 'bg-brand-400/20 text-brand-100'
                : 'text-gray-400 hover:text-gray-100 hover:bg-surface-elev'
            }`}
          >
            {pathname.startsWith('/admin') && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-brand-200 rounded-r-full" />
            )}
            <span className="w-5 text-center">⚙</span>
            Admin
          </Link>
        )}
      </nav>

      <div className="px-3 pb-4 pt-3 border-t border-surface-border shrink-0">
        {chainLabel && (
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border mb-2 ${chainBadgeColor}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
            {chainLabel}
          </div>
        )}
        {wallet.isConnected && isKYCVerified !== undefined && (
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border mb-2 ${
            isKYCVerified
              ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700'
              : 'bg-gray-800 text-gray-500 border-gray-700'
          }`}>
            <span>{isKYCVerified ? '✓' : '?'}</span>
            KYC {isKYCVerified ? '已驗證' : '未驗證'}
          </div>
        )}
        <WalletButton wallet={wallet} />
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-surface text-gray-100 flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 bg-surface-sub flex-col fixed inset-y-0 left-0 z-40 border-r border-surface-border">
        {renderSidebarContent()}
      </aside>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside className={`fixed inset-y-0 left-0 w-64 bg-surface-sub flex flex-col z-50 border-r border-surface-border transition-transform duration-300 md:hidden ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        {renderSidebarContent()}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:ml-60">
        {/* Disclaimer */}
        {!dismissed && (
          <div className="bg-warn/10 border-b border-warn/30 px-6 py-2 flex items-center justify-between text-xs text-warn">
            <span>Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議</span>
            <button
              onClick={() => { setDismissed(true); localStorage.setItem('disclaimer-dismissed', '1') }}
              className="ml-4 hover:text-white transition-colors shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* Whale alert banner */}
        {whaleAlerts && whaleAlerts.length > 0 && (
          <WhaleAlertBanner alerts={whaleAlerts} />
        )}

        {/* Demo mode banner — visible only to deployer/admin */}
        {showDemoBanner && (
          <div className="bg-brand-400/10 border-b border-brand-300/30 px-6 py-1.5 flex items-center justify-between text-xs text-brand-100">
            <span>🎬 Live demo mode — admin auto-keeper running, prices update every 60s</span>
            <button
              onClick={() => { setDemoDismissed(true); localStorage.setItem('demo-banner-dismissed', '1') }}
              className="ml-4 hover:text-white transition-colors shrink-0"
              aria-label="Dismiss demo banner"
            >
              ✕
            </button>
          </div>
        )}

        {/* Top header */}
        <header className="sticky top-0 z-30 bg-surface-sub/80 backdrop-blur-md border-b border-surface-border px-4 md:px-6 py-3 flex items-center gap-4">
          <button
            className="md:hidden text-gray-400 hover:text-white transition-colors"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <span className="font-semibold text-sm flex-1 text-gray-100">{pageTitle}</span>

          {wallet.isConnected && (
            <div className="hidden sm:flex items-center gap-2">
              {wallet.chainId !== 11155111 && (
                <button
                  onClick={() => void switchToSepolia()}
                  disabled={switching}
                  className="px-3 py-1 rounded-lg bg-info/10 hover:bg-info/20 disabled:opacity-50 text-info text-xs font-semibold transition-colors border border-info/30"
                >
                  {switching ? '…' : 'Sepolia'}
                </button>
              )}
              {import.meta.env.DEV && wallet.chainId !== 31337 && (
                <button
                  onClick={() => void switchToAnvil()}
                  disabled={switching}
                  className="px-3 py-1 rounded-lg bg-brand-400/30 hover:bg-brand-400/50 disabled:opacity-50 text-brand-100 text-xs font-semibold transition-colors border border-brand-300/30"
                  title="Local development only"
                >
                  {switching ? '…' : 'Anvil'}
                </button>
              )}
            </div>
          )}
        </header>

        <main className="flex-1 p-4 md:p-6">{children}</main>

        <footer className="border-t border-surface-border px-6 py-3 text-center text-xs text-gray-600 space-x-2">
          <span>PepeFi · Research prototype · Sepolia ·</span>
          {addresses?.PerpetualExchange && wallet.chainId === 11155111 && (
            <a
              href={`https://sepolia.etherscan.io/address/${addresses.PerpetualExchange}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-500 hover:text-emerald-300 transition-colors"
            >
              Exchange ↗
            </a>
          )}
          {addresses?.PerpetualExchange && wallet.chainId === 11155111 && <span>·</span>}
          <a
            href="https://github.com/zuemen/pepelab_onchain_cfd"
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-500 hover:text-emerald-300 transition-colors"
          >
            GitHub ↗
          </a>
        </footer>
      </div>
    </div>
  )
}
