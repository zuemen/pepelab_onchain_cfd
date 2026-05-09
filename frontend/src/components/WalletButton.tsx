import { useState, useRef, useEffect } from 'react'
import type { WalletAPI } from '../hooks/useWallet'

interface Props {
  wallet: WalletAPI
}

export default function WalletButton({ wallet }: Props) {
  const { address, isConnected, isConnecting, connect, disconnect, switchAccount } = wallet
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (isConnecting) {
    return (
      <button
        disabled
        className="px-4 py-2 rounded-lg bg-gray-700 text-gray-400 text-sm font-medium cursor-not-allowed"
      >
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
          className="px-4 py-2 rounded-lg bg-emerald-900 text-emerald-300 text-sm font-medium hover:bg-emerald-800 transition-colors"
        >
          {short} ▾
        </button>
        {open && (
          <div className="absolute right-0 mt-1 w-44 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden">
            <button
              onClick={() => { setOpen(false); void switchAccount() }}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
            >
              Switch Account
            </button>
            <button
              onClick={() => { setOpen(false); disconnect() }}
              className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-gray-700 transition-colors"
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
      className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 transition-colors"
    >
      Connect Wallet
    </button>
  )
}
