import { Link, Navigate } from 'react-router';

import { usePepefiWallet } from 'src/layouts/pepefi';

import WalletButton from 'src/components/pepefi/WalletButton';

const FEATURES = [
  { icon: '📈', title: 'Synthetic CFD Perpetuals', desc: '合成衍生品永續合約，全程透明上鏈，無需中心化交易所。' },
  { icon: '🔗', title: 'One-Click Copy Trading', desc: '一鍵跟單頂尖交易者，授權 USDC 後自動按比例開倉。' },
  { icon: '🌿', title: 'ESG Scoring', desc: '每位交易者皆有 ESG 評分，讓投資更有責任感與透明度。' },
  { icon: '🏦', title: 'Insurance Vault', desc: '提供流動性賺取協議費用，同時作為極端損失的保險池。' },
];

const STEPS = [
  { n: '01', text: '安裝 MetaMask，切換到 Sepolia testnet' },
  { n: '02', text: '前往 Exchange，點擊「Get 1000 mUSDC」取得測試資金' },
  { n: '03', text: '到 Marketplace 複製 Demo Alpha 交易者策略' },
  { n: '04', text: '（可選）在 Trader 頁面登記成為交易者並公開策略' },
];

export default function LandingPage() {
  const wallet = usePepefiWallet();
  if (wallet.isConnected) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(160deg, #0a1628 0%, #0d1f12 55%, #0a1628 100%)' }}>

      {/* ── Logo / Brand ── */}
      <div className="flex flex-col items-center pt-16 pb-10 px-6 text-center">

        {/* PepeFi Logo Block */}
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* Icon */}
          <div
            className="flex h-20 w-20 items-center justify-center rounded-2xl text-4xl shadow-lg"
            style={{ background: 'linear-gradient(135deg, #065f46, #059669)', boxShadow: '0 0 32px rgba(5,150,105,0.4)' }}
          >
            🐸
          </div>

          {/* Name */}
          <div>
            <h1
              className="text-5xl font-black tracking-tight"
              style={{ background: 'linear-gradient(90deg, #34d399 0%, #059669 60%, #a3e635 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
            >
              PepeFi
            </h1>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
              On-Chain CFD Protocol
            </p>
          </div>
        </div>

        {/* Tagline */}
        <p className="mb-2 max-w-lg text-2xl font-bold text-white leading-snug">
          鏈上合成衍生品跟單系統
        </p>
        <p className="mb-8 max-w-md text-sm text-slate-400 leading-relaxed">
          結合 Synthetic CFD 永續合約與一鍵 Copy Trading，<br />
          交易者公開策略，跟單者授權 USDC 自動跟進，全程上鏈透明。
        </p>

        {/* Testnet badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-emerald-800/60 bg-emerald-950/40 px-4 py-1.5 text-xs font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Deployed on Sepolia Testnet
        </div>

        {/* CTA */}
        <WalletButton wallet={wallet} />
        {wallet.error && <p className="mt-3 text-xs text-red-400">{wallet.error}</p>}
        <p className="mt-3 text-xs text-slate-600">連線後可直接瀏覽所有功能，無需註冊帳號</p>
      </div>

      {/* ── Divider ── */}
      <div className="mx-auto max-w-4xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent" />
      </div>

      {/* ── Features ── */}
      <div className="mx-auto max-w-4xl px-6 py-12">
        <p className="mb-6 text-center text-xs font-semibold uppercase tracking-widest text-slate-500">核心功能</p>
        <div className="grid grid-cols-2 gap-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-700/40 bg-slate-800/30 p-5 transition-all duration-200 hover:border-emerald-700/50 hover:bg-slate-800/50"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-700/60 text-xl">
                {f.icon}
              </div>
              <h3 className="mb-1.5 text-sm font-semibold text-white">{f.title}</h3>
              <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── How to Start ── */}
      <div className="mx-auto max-w-2xl px-6 pb-16">
        <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 p-6">
          <p className="mb-5 text-xs font-semibold uppercase tracking-widest text-emerald-500">如何開始</p>
          <div className="space-y-4">
            {STEPS.map((s) => (
              <div key={s.n} className="flex items-start gap-4">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-900/60 text-xs font-bold text-emerald-400 ring-1 ring-emerald-800">
                  {s.n}
                </span>
                <p className="text-sm text-slate-300 leading-relaxed">{s.text}</p>
              </div>
            ))}
          </div>

          {/* Quick links */}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700/40 pt-4">
            {[
              { label: '💱 Exchange', to: '/pepefi/exchange' },
              { label: '🏪 Marketplace', to: '/pepefi/marketplace' },
              { label: '🏦 Vault', to: '/pepefi/vault' },
            ].map((link) => (
              <Link
                key={link.label}
                to={link.to}
                className="rounded-lg bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700 hover:text-white hover:ring-slate-600 transition-all"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-slate-600">
          ⚠ Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化
        </p>
      </div>

    </div>
  );
}
