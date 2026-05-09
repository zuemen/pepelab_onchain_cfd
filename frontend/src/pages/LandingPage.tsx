import type { WalletAPI } from '../hooks/useWallet'
import WalletButton from '../components/WalletButton'

interface Props {
  wallet: WalletAPI
}

export default function LandingPage({ wallet }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center gap-8">
      {/* Hero */}
      <div className="space-y-3">
        <h1 className="text-4xl font-extrabold tracking-tight text-white">
          On-Chain CFD Copy Trading PoC
        </h1>
        <p className="text-lg text-emerald-400 font-medium">
          鏈上合成衍生品跟單系統
        </p>
      </div>

      {/* Intro */}
      <div className="max-w-2xl space-y-4 text-gray-300">
        <p>
          This project demonstrates <span className="text-white font-semibold">on-chain synthetic CFD perpetuals</span> combined with an automated <span className="text-white font-semibold">copy-trading</span> mechanism — all deployed on a local Ethereum node (Anvil).
        </p>
        <p className="text-sm text-gray-400">
          本系統結合「合成衍生品（Synthetic CFD）」與「一鍵跟單（Copy Trading）」兩大核心功能。交易者可公開策略組合（槓桿、資產、多空配置），跟單者只需授權 USDC 即可按比例自動開倉，全程透明上鏈。
        </p>
      </div>

      {/* How to try */}
      <div className="max-w-2xl rounded-xl border border-emerald-800 bg-emerald-950/30 px-5 py-4 text-left text-sm space-y-2">
        <p className="font-semibold text-emerald-300">How to try this demo:</p>
        <ol className="list-decimal list-inside space-y-1 text-gray-300 text-xs leading-relaxed">
          <li>Connect MetaMask and switch to <strong className="text-white">Sepolia testnet</strong></li>
          <li>Get free Sepolia ETH from{' '}
            <a href="https://sepolia-faucet.pk910.de/" target="_blank" rel="noopener" className="text-emerald-400 hover:underline">sepolia-faucet.pk910.de</a>
          </li>
          <li>Visit <code className="bg-gray-800 px-1.5 rounded">/exchange</code> and click "Get 1000 mUSDC" to fund your account</li>
          <li>Browse <code className="bg-gray-800 px-1.5 rounded">/marketplace</code> to copy <strong className="text-white">Demo Alpha</strong> trader, or open positions yourself</li>
          <li>Optional: register as a trader on <code className="bg-gray-800 px-1.5 rounded">/trader</code> and publish your own strategy</li>
        </ol>
        <p className="text-xs text-emerald-400/70 pt-1">
          ⚠ Oracle prices are controlled by the deployer (admin). During live demos the deployer will update prices to show PnL changes.
        </p>
      </div>

      {/* CTA */}
      {wallet.isConnected ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-emerald-400">
            Connected: <span className="font-mono">{wallet.address}</span>
          </p>
          <WalletButton wallet={wallet} />
        </div>
      ) : (
        <WalletButton wallet={wallet} />
      )}

      {wallet.error && (
        <p className="text-red-400 text-sm">{wallet.error}</p>
      )}

    </div>
  )
}
