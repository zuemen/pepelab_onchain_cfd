import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useWallet } from './hooks/useWallet'
import { useContracts } from './hooks/useContracts'
import { useKYC } from './hooks/useKYC'
import { useWhaleAlerts } from './hooks/useWhaleAlerts'
import Layout            from './components/Layout'
import ErrorBoundary     from './components/ErrorBoundary'
import LandingPage       from './pages/LandingPage'
import ExchangePage      from './pages/ExchangePage'
import TraderDashboard   from './pages/TraderDashboard'
import TraderStakePage   from './pages/TraderStakePage'
import TraderProfilePage from './pages/TraderProfilePage'
import DashboardPage     from './pages/DashboardPage'
import ESGPage           from './pages/ESGPage'
import MarketplacePage   from './pages/MarketplacePage'
import CopyPage          from './pages/CopyPage'
import PortfolioPage     from './pages/PortfolioPage'
import AdminOraclePage   from './pages/AdminOraclePage'
import AdminTreasuryPage from './pages/AdminTreasuryPage'
import VaultPage         from './pages/VaultPage'
import HistoryPage       from './pages/HistoryPage'
import WhaleTrackerPage  from './pages/WhaleTrackerPage'

export default function App() {
  const wallet    = useWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const { isVerified: isKYCVerified } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null,
  )
  const { alerts: whaleAlerts } = useWhaleAlerts(
    contracts?.exchange ?? null,
    wallet.provider,
  )

  return (
    <BrowserRouter>
      <Layout
        wallet={wallet}
        isKYCVerified={wallet.isConnected ? isKYCVerified : undefined}
        whaleAlerts={wallet.isConnected ? whaleAlerts : undefined}
      >
        <ErrorBoundary>
        <Routes>
          <Route path="/"                       element={<LandingPage       wallet={wallet} />} />
          <Route path="/dashboard"              element={<DashboardPage     wallet={wallet} whaleAlerts={whaleAlerts} />} />
          <Route path="/exchange"               element={<ExchangePage      wallet={wallet} />} />
          <Route path="/trader"                 element={<TraderDashboard   wallet={wallet} />} />
          <Route path="/stake"                  element={<TraderStakePage   wallet={wallet} />} />
          <Route path="/trader/:address"        element={<TraderProfilePage wallet={wallet} />} />
          <Route path="/marketplace"            element={<MarketplacePage   wallet={wallet} />} />
          <Route path="/esg"                    element={<ESGPage           wallet={wallet} />} />
          <Route path="/copy/:traderAddress"    element={<CopyPage          wallet={wallet} />} />
          <Route path="/portfolio"              element={<PortfolioPage     wallet={wallet} />} />
          <Route path="/vault"                  element={<VaultPage         wallet={wallet} />} />
          <Route path="/history"                element={<HistoryPage       wallet={wallet} />} />
          <Route path="/whale"                  element={<WhaleTrackerPage  wallet={wallet} />} />
          <Route path="/admin/oracle"           element={<AdminOraclePage   wallet={wallet} />} />
          <Route path="/admin/treasury"         element={<AdminTreasuryPage wallet={wallet} />} />
        </Routes>
        </ErrorBoundary>
      </Layout>
    </BrowserRouter>
  )
}
