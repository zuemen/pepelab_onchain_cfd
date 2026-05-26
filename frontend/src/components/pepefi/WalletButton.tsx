import type { WalletAPI } from 'src/hooks/useWallet'

import { useRef, useState, useEffect } from 'react'

interface Props {
  wallet: WalletAPI
}

export default function WalletButton({ wallet }: Props) {
  const { address, isConnected, isConnecting, connect, disconnect, switchAccount } = wallet
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (isConnecting) {
    return (
      <button disabled className="btn-secondary btn-pill opacity-60 cursor-not-allowed">
        <span className="h-3.5 w-3.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
        Connecting…
      </button>
    )
  }

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`
    return (
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="btn-secondary btn-pill btn-sm flex items-center gap-2"
        >
          {/* 綠點：已連線指示 */}
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/60" />
          <span className="font-mono">{short}</span>
          <svg className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-48 rounded-xl border border-slate-700 bg-slate-800 shadow-xl shadow-black/40 z-50 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-700">
              <p className="text-xs text-slate-500">Connected</p>
              <p className="text-xs font-mono text-slate-300 truncate">{address}</p>
            </div>
            <button
              onClick={() => { setOpen(false); void switchAccount() }}
              className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
            >
              Switch Account
            </button>
            <button
              onClick={() => { setOpen(false); disconnect() }}
              className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => void connect()}
      className="btn-primary btn-pill"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M16 12h6m-3-3l3 3-3 3" />
      </svg>
      Connect Wallet
    </button>
  )
}
