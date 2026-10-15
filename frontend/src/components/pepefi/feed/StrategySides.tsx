import type { Contract } from 'ethers';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

import { t, interpolate } from 'src/locales';
import { sidesOfMarket } from 'src/lib/pepefi/feed';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import { useMarketSentiment } from 'src/hooks/useMarketSentiment';

// ----------------------------------------------------------------------
// 策略中每一檔目前的市場多空比例（issue #335）。數字直接沿用巨鯨追蹤的市場情緒讀取
// （useMarketSentiment 讀合約的 globalLongNotional / globalShortNotional），這裡只是多放在
// 交易者個人頁與跟單頁，讓使用者在做決定的地方看到自己跟的方向和市場是同邊還是反邊。

const L = t.feed.sides;

interface Props {
  legs: { asset: string; isLong: boolean }[];
  exchange: Contract | null;
}

export default function StrategySides({ legs, exchange }: Props) {
  const theme = useTheme();
  const sentiment = useMarketSentiment(exchange);
  if (legs.length === 0) return null;
  const rows = sidesOfMarket(legs, sentiment.rows);

  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.title}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{L.subtitle}</Typography>
      <Stack spacing={1.5}>
        {rows.map((row, i) => {
          const leg = legs[i];
          const long = row.longShare === null ? null : Math.round(row.longShare * 100);
          return (
            <Box key={row.asset}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 64 }}>{ASSET_LABEL[row.asset] ?? '?'}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {interpolate(L.yourSide, { side: leg.isLong ? t.feed.sentence.long : t.feed.sentence.short })}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {long === null ? (
                  <Typography variant="caption" color="text.secondary">{sentiment.loading ? '…' : L.none}</Typography>
                ) : (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={row.withMajority === null ? 'default' : row.withMajority ? 'success' : 'warning'}
                    label={row.withMajority === null ? L.even : row.withMajority ? L.with : L.against}
                    sx={{ height: 22 }}
                  />
                )}
              </Stack>
              {long !== null && (
                <>
                  <Box sx={{ mt: 0.75, height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', bgcolor: 'action.hover' }}>
                    <Box sx={{ width: `${long}%`, bgcolor: theme.palette.success.main }} />
                    <Box sx={{ width: `${100 - long}%`, bgcolor: theme.palette.error.main }} />
                  </Box>
                  <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.25 }}>
                    <Typography variant="caption" color="success.main">{interpolate(L.long, { pct: long })}</Typography>
                    <Typography variant="caption" color="error.main">{interpolate(L.short, { pct: 100 - long })}</Typography>
                  </Stack>
                </>
              )}
            </Box>
          );
        })}
      </Stack>
      {sentiment.missing > 0 && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1.5 }}>
          {interpolate(L.missing, { count: sentiment.missing })}
        </Typography>
      )}
    </Card>
  );
}
