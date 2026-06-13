import type { RouteObject } from 'react-router';
import type { WalletAPI } from 'src/hooks/useWallet';

import { lazy, Suspense } from 'react';
import { Outlet, useOutletContext } from 'react-router';

import { PepefiLayout } from 'src/layouts/pepefi';
import { DashboardLayout } from 'src/layouts/dashboard';

import { LoadingScreen } from 'src/components/loading-screen';

import { usePathname } from '../hooks';

// ----------------------------------------------------------------------

const LandingPage       = lazy(() => import('src/pages/pepefi/LandingPage'));
const DashboardPage     = lazy(() => import('src/pages/pepefi/DashboardPage'));
const ExchangePage      = lazy(() => import('src/pages/pepefi/ExchangePage'));
const TraderDashboard   = lazy(() => import('src/pages/pepefi/TraderDashboard'));
const TraderStakePage   = lazy(() => import('src/pages/pepefi/TraderStakePage'));
const TraderProfilePage = lazy(() => import('src/pages/pepefi/TraderProfilePage'));
const MarketplacePage   = lazy(() => import('src/pages/pepefi/MarketplacePage'));
const ESGPage           = lazy(() => import('src/pages/pepefi/ESGPage'));
const CopyPage          = lazy(() => import('src/pages/pepefi/CopyPage'));
const PortfolioPage     = lazy(() => import('src/pages/pepefi/PortfolioPage'));
const VaultPage         = lazy(() => import('src/pages/pepefi/VaultPage'));
const HistoryPage       = lazy(() => import('src/pages/pepefi/HistoryPage'));
const WhaleTrackerPage  = lazy(() => import('src/pages/pepefi/WhaleTrackerPage'));
const AdminOraclePage   = lazy(() => import('src/pages/pepefi/AdminOraclePage'));
const AdminTreasuryPage = lazy(() => import('src/pages/pepefi/AdminTreasuryPage'));
const RewardsPage       = lazy(() => import('src/pages/pepefi/RewardsPage'));
const SessionsPage      = lazy(() => import('src/pages/pepefi/SessionsPage'));
const AgentMonitorPage  = lazy(() => import('src/pages/pepefi/AgentMonitorPage'));
const HomePage          = lazy(() => import('src/pages/pepefi/HomePage'));

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

export const pepefiRoutes: RouteObject[] = [
  {
    path: '/',
    // DashboardLayout 提供 Minimal UI 的 sidebar/navbar 外框
    // PepefiLayout 負責呼叫 useWallet() 並透過 outlet context 傳給子頁面
    element: (
      <DashboardLayout>
        <PepefiLayout />
      </DashboardLayout>
    ),
    children: [
      {
        element: <SuspenseOutlet />,
        children: [
          { index: true, element: <LandingPage /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'exchange', element: <ExchangePage /> },
          { path: 'trader', element: <TraderDashboard /> },
          { path: 'stake', element: <TraderStakePage /> },
          { path: 'trader/:address', element: <TraderProfilePage /> },
          { path: 'marketplace', element: <MarketplacePage /> },
          { path: 'esg', element: <ESGPage /> },
          { path: 'copy/:traderAddress', element: <CopyPage /> },
          { path: 'portfolio', element: <PortfolioPage /> },
          { path: 'vault', element: <VaultPage /> },
          { path: 'history', element: <HistoryPage /> },
          { path: 'whale', element: <WhaleTrackerPage /> },
          { path: 'admin/oracle', element: <AdminOraclePage /> },
          { path: 'admin/treasury', element: <AdminTreasuryPage /> },
          { path: 'rewards', element: <RewardsPage /> },
          { path: 'sessions', element: <SessionsPage /> },
          { path: 'agent-monitor', element: <AgentMonitorPage /> },
          { path: 'home',    element: <HomePage /> },
        ],
      },
    ],
  },
];
