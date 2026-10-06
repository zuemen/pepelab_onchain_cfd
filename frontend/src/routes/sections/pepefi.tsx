import type { RouteObject } from 'react-router';
import type { WalletAPI } from 'src/hooks/useWallet';

import { lazy, Suspense } from 'react';
import { Outlet, Navigate, useOutletContext } from 'react-router';

import { PepefiLayout } from 'src/layouts/pepefi';
import { FEATURES } from 'src/lib/pepefi/featureFlags';
import { DashboardLayout } from 'src/layouts/dashboard';

import { LoadingScreen } from 'src/components/loading-screen';
import { FeatureGate } from 'src/components/pepefi/FeatureGate';

import { usePathname } from '../hooks';

// ----------------------------------------------------------------------

const LandingPage       = lazy(() => import('src/pages/pepefi/LandingPage'));
const ExchangePage      = lazy(() => import('src/pages/pepefi/ExchangePage'));
const TokenizedAssetsPage = lazy(() => import('src/pages/pepefi/TokenizedAssetsPage'));
const TradeTerminalPage = lazy(() => import('src/pages/pepefi/TradeTerminalPage'));
const X402DocsPage      = lazy(() => import('src/pages/pepefi/X402DocsPage'));
const TraderDashboard   = lazy(() => import('src/pages/pepefi/TraderDashboard'));
const TraderStakePage   = lazy(() => import('src/pages/pepefi/TraderStakePage'));
const TraderProfilePage = lazy(() => import('src/pages/pepefi/TraderProfilePage'));
const MarketplacePage   = lazy(() => import('src/pages/pepefi/MarketplacePage'));
const ESGPage           = lazy(() => import('src/pages/pepefi/ESGPage'));
const CopyPage          = lazy(() => import('src/pages/pepefi/CopyPage'));
const PortfolioPage     = lazy(() => import('src/pages/pepefi/PortfolioPage'));
const VaultPage         = lazy(() => import('src/pages/pepefi/VaultPage'));
const HistoryPage       = lazy(() => import('src/pages/pepefi/HistoryPage'));
const LegacyPage        = lazy(() => import('src/pages/pepefi/LegacyPage'));
const WhaleTrackerPage  = lazy(() => import('src/pages/pepefi/WhaleTrackerPage'));
const AdminOraclePage   = lazy(() => import('src/pages/pepefi/AdminOraclePage'));
const AdminTreasuryPage = lazy(() => import('src/pages/pepefi/AdminTreasuryPage'));
const AdminKYCPage      = lazy(() => import('src/pages/pepefi/AdminKYCPage'));
const RewardsPage       = lazy(() => import('src/pages/pepefi/RewardsPage'));
const SessionsPage      = lazy(() => import('src/pages/pepefi/SessionsPage'));
const AgentMonitorPage  = lazy(() => import('src/pages/pepefi/AgentMonitorPage'));
const PepeLabPage       = lazy(() => import('src/pages/pepefi/PepeLabPage'));
// RWA 透明度三頁（docs/RWA_TRANSPARENCY.md）
const RwaPage           = lazy(() => import('src/pages/pepefi/RwaPage'));
const OraclePage        = lazy(() => import('src/pages/pepefi/OraclePage'));
const SolvencyPage      = lazy(() => import('src/pages/pepefi/SolvencyPage'));
const InvestorCredentialPage = lazy(() => import('src/pages/pepefi/InvestorCredentialPage'));

// ----------------------------------------------------------------------

// SuspenseOutlet 必須把 wallet context 繼續往下傳，
// 否則子頁面的 useOutletContext() 會拿到 undefined
function SuspenseOutlet() {
  const pathname = usePathname();
  const wallet = useOutletContext<WalletAPI>();
  return (
    <Suspense key={pathname} fallback={<LoadingScreen />}>
      <Outlet context={wallet} />
    </Suspense>
  );
}

// 內頁專用外框：Minimal UI 的 sidebar/navbar。Landing 不走這層，
// 所以未連錢包時（停留在 landing）完全看不到側邊欄。
function DashboardShell() {
  return (
    <DashboardLayout>
      <SuspenseOutlet />
    </DashboardLayout>
  );
}

export const pepefiRoutes: RouteObject[] = [
  {
    path: '/',
    // PepefiLayout 負責呼叫 useWallet()、wallet gate 導向，
    // 並透過 outlet context 傳給子頁面
    element: <PepefiLayout />,
    children: [
      // Landing：全螢幕、無側邊欄
      {
        element: <SuspenseOutlet />,
        children: [{ index: true, element: <LandingPage /> }],
      },
      // App 內頁：DashboardLayout（sidebar/navbar）包住
      {
        element: <DashboardShell />,
        children: [
          // /dashboard 併進 /portfolio。兩頁本來都在回答「我現在怎麼樣」，
          // 但只有 Portfolio 有動作（部位頁籤逐筆平倉、提領、停止跟單），Dashboard 是它的
          // 唯讀分身。轉址而不是移除，舊連結與書籤才不會壞掉。
          { path: 'dashboard', element: <Navigate to="/portfolio" replace /> },
          { path: 'exchange', element: <ExchangePage /> },
          { path: 'tokens', element: <TokenizedAssetsPage /> },
          { path: 'terminal', element: <TradeTerminalPage /> },
          { path: 'trader', element: <TraderDashboard /> },
          { path: 'stake', element: <TraderStakePage /> },
          { path: 'trader/:address', element: <TraderProfilePage /> },
          { path: 'marketplace', element: <MarketplacePage /> },
          { path: 'esg', element: <ESGPage /> },
          // 商業版旗標（featureFlags.ts）：關閉時連路由一起收，直接打網址看到「此功能未啟用」。
          {
            path: 'copy/:traderAddress',
            element: <FeatureGate enabled={FEATURES.copyTrading}><CopyPage /></FeatureGate>,
          },
          { path: 'portfolio', element: <PortfolioPage /> },
          { path: 'vault', element: <VaultPage /> },
          { path: 'history', element: <HistoryPage /> },
          // 舊版 exchange 的資產取回。不進側邊欄：入口是 Portfolio 上只在「真的有舊資產」
          // 時才出現的提示（LegacyAssetsBanner），見 docs/LEGACY_EXCHANGES.md。
          { path: 'legacy', element: <LegacyPage /> },
          { path: 'whale', element: <WhaleTrackerPage /> },
          { path: 'admin/oracle', element: <AdminOraclePage /> },
          { path: 'admin/treasury', element: <AdminTreasuryPage /> },
          { path: 'admin/kyc', element: <AdminKYCPage /> },
          // 合格投資人 VC → RWA 市場資格（docs/SSI_RWA_ACCESS.md）。registry 未設定時頁面自己降級。
          { path: 'credentials', element: <InvestorCredentialPage /> },
          {
            path: 'rewards',
            element: <FeatureGate enabled={FEATURES.pepeRewards}><RewardsPage /></FeatureGate>,
          },
          { path: 'sessions', element: <SessionsPage /> },
          { path: 'agent-monitor', element: <AgentMonitorPage /> },
          { path: 'x402', element: <X402DocsPage /> },
          { path: 'rwa', element: <RwaPage /> },
          { path: 'oracle', element: <OraclePage /> },
          { path: 'solvency', element: <SolvencyPage /> },
          {
            path: 'pepe',
            element: <FeatureGate enabled={FEATURES.gamefi}><PepeLabPage /></FeatureGate>,
          },
        ],
      },
    ],
  },
];
