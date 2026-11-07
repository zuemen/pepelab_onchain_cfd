import { useState } from 'react';

import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';

import { t } from 'src/locales';
import { useMode } from 'src/contexts/mode-context';
import { CopyFlow } from 'src/components/pepefi/GuideFlow';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import AllocationMarketplace from 'src/components/pepefi/AllocationMarketplace';
import TraderLeaderboard from 'src/components/pepefi/TraderLeaderboard';

/**
 * #149 / ADR-007：Simple Mode 看到的是配置市集（無槓桿的現貨採用），Expert Mode
 * 才是交易者排行榜（CopyTracker 的槓桿跟單）。兩個是不同的商品，不是同一個畫面
 * 換兩套詞——拆成兩個元件，Simple Mode 也就不會去掃排行榜那幾百段 getLogs。
 */
export default function MarketplacePage() {
  const { mode } = useMode();
  const [tab, setTab] = useState<'traders' | 'allocations'>('traders');
  // 跟單排行榜跟著 FEATURE_COPY_TRADING 走（商業版預設關）——關閉時兩個模式都是配置市集。
  if (!FEATURE_COPY_TRADING) return <AllocationMarketplace />;

  // 11/07：老師要的主線是跟單，簡單模式也要看得到交易者。兩個分頁只渲染選中的那個，
  // 沒點「跟單交易者」就不會掃排行榜的 getLogs。
  const showTabs = mode === 'simple';
  const active = showTabs ? tab : 'traders';
  return (
    <>
      <Container maxWidth="lg" sx={{ pt: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <CopyFlow />
        <Alert severity="info">{t.guide.marketplace.simNote}</Alert>
        {showTabs && (
          <Tabs value={tab} onChange={(_, v) => setTab(v)}>
            <Tab value="traders" label={t.guide.marketplace.traders} />
            <Tab value="allocations" label={t.guide.marketplace.allocations} />
          </Tabs>
        )}
      </Container>
      {active === 'traders' ? <TraderLeaderboard /> : <AllocationMarketplace />}
    </>
  );
}
