import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useWallet } from './hooks/useWallet'
import Layout            from './components/Layout'
import LandingPage       from './pages/LandingPage'
import ExchangePage      from './pages/ExchangePage'
import TraderDashboard   from './pages/TraderDashboard'
import TraderStakePage   from './pages/TraderStakePage'
import TraderProfilePage from './pages/TraderProfilePage'
import MarketplacePage   from './pages/MarketplacePage'
import CopyPage          from './pages/CopyPage'
import PortfolioPage     from './pages/PortfolioPage'
import AdminOraclePage   from './pages/AdminOraclePage'
import VaultPage         from './pages/VaultPage'

export default function App() {
  const wallet = useWallet()

  return (
    <BrowserRouter>
      <Layout wallet={wallet}>
        <Routes>
          <Route path="/"                       element={<LandingPage       wallet={wallet} />} />
          <Route path="/exchange"               element={<ExchangePage      wallet={wallet} />} />
          <Route path="/trader"                 element={<TraderDashboard   wallet={wallet} />} />
          <Route path="/stake"                  element={<TraderStakePage   wallet={wallet} />} />
          <Route path="/trader/:address"        element={<TraderProfilePage wallet={wallet} />} />
          <Route path="/marketplace"            element={<MarketplacePage   wallet={wallet} />} />
          <Route path="/copy/:traderAddress"    element={<CopyPage          wallet={wallet} />} />
          <Route path="/portfolio"              element={<PortfolioPage     wallet={wallet} />} />
          <Route path="/vault"                  element={<VaultPage         wallet={wallet} />} />
          <Route path="/admin/oracle"           element={<AdminOraclePage   wallet={wallet} />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
