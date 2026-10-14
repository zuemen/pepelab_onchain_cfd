import { useMode } from 'src/contexts/mode-context';
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
  // 跟單排行榜跟著 FEATURE_COPY_TRADING 走（商業版預設關）——關閉時兩個模式都是配置市集。
  return mode === 'expert' && FEATURE_COPY_TRADING ? <TraderLeaderboard /> : <AllocationMarketplace />;
}
