import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { fPnL } from 'src/lib/pepefi/leaderboardMetrics';

/** 一次最多畫幾格——7 日視窗的平倉通常個位數,但不設上限的話高頻交易者會撐爆卡片。 */
const MAX_BLOCKS = 14;

interface Props {
  /** 每一筆平倉的已實現損益,依時序(舊→新)。空陣列時顯示「尚無平倉」。 */
  pnls: bigint[];
}

/**
 * 勝負方塊列:一筆平倉一格,綠賺、紅賠、剛好打平中性灰。取代原本那條 5 個點就
 * 擠成一條平線的累積權益曲線——方塊列直接對應旁邊的「勝率 (樣本數)」,樣本再
 * 少也看得懂,而且永遠不會是「一條沒變動的線」。超過 14 筆只留最近的。
 */
export default function TradeResultStrip({ pnls }: Props) {
  if (pnls.length === 0) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t.marketplace.podium.noClosedTrades}
      </Typography>
    );
  }

  const shown = pnls.slice(-MAX_BLOCKS);
  const hidden = pnls.length - shown.length;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
      {hidden > 0 && (
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', mr: 0.25 }}>
          +{hidden}
        </Typography>
      )}
      {shown.map((pnl, i) => {
        const color = pnl > 0n ? 'success.main' : pnl < 0n ? 'error.main' : 'text.disabled';
        return (
          <Tooltip key={i} title={fPnL(pnl)}>
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: 0.75,
                bgcolor: color,
                opacity: 0.85,
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}
