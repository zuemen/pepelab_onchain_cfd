import type { WalletAPI } from '../hooks/useWallet'

interface Props {
  wallet: WalletAPI
}

export default function WalletButton({ wallet }: Props) {
  const { address, isConnected, isConnecting, connect, disconnect } = wallet

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
      <button
        onClick={disconnect}
        className="px-4 py-2 rounded-lg bg-emerald-900 text-emerald-300 text-sm font-medium hover:bg-red-900 hover:text-red-300 transition-colors"
      >
        {short} · Disconnect
      </button>
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
