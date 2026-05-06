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

      {/* Disclaimer */}
      <div className="max-w-xl rounded-lg border border-yellow-800 bg-yellow-950/40 px-5 py-4 text-left text-xs text-yellow-300 space-y-1">
        <p className="font-semibold uppercase tracking-wide">Disclaimer</p>
        <p>
          This is a <strong>research prototype</strong> deployed on a local testnet. No real assets are involved. Smart contracts have not been audited. Do not use with real funds on any public network.
        </p>
        <p>
          本系統為學術研究雛型，僅部署於本地測試節點，不涉及任何真實資產或法定貨幣。
        </p>
      </div>
    </div>
  )
}
