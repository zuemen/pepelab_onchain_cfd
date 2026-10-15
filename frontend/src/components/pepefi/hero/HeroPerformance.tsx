import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Bar, Cell, Line, XAxis, YAxis, Tooltip, BarChart, LineChart, CartesianGrid, ResponsiveContainer } from 'recharts';

import { t, interpolate } from 'src/locales';
import StatCard from 'src/components/pepefi/StatCard';
import { MONO } from 'src/components/pepefi/brandKit';
import { fUsd, fRatio, fDrawdown, fSignedPct, type HeroDetail } from 'src/lib/pepefi/heroData';

import { barCursor, lineCursor, tooltipProps } from './chartTooltip';

// ----------------------------------------------------------------------
// 模擬交易者的歷史績效（issue #309）。資料來自 public/data/heroes/<address>.json，
// 由鏈上事件在鏈下算出；這個元件只畫，不讀鏈。

const STAT = { xs: 6, md: 4 };

export default function HeroPerformance({ hero }: { hero: HeroDetail }) {
  const theme = useTheme();
  const L = t.traderProfile.hero;
  const up = theme.palette.success.main;
  const down = theme.palette.error.main;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="baseline" spacing={1.5} flexWrap="wrap">
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{L.performanceTitle}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {interpolate(L.range, {
            from: hero.equityCurve[0]?.date ?? '—',
            to: hero.equityCurve[hero.equityCurve.length - 1]?.date ?? '—',
          })}
        </Typography>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={STAT}>
          <StatCard
            title={L.totalReturn}
            value={fSignedPct(hero.totalReturnPct)}
            valueColor={hero.totalReturnPct >= 0 ? 'success.main' : 'error.main'}
          />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.maxDrawdown} value={fDrawdown(hero.maxDrawdownPct)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.sharpe} value={fRatio(hero.sharpe)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.winRate}
            value={hero.winRatePct === null ? '—' : `${hero.winRatePct.toFixed(0)}%`}
            sub={interpolate(L.winRateSub, { count: hero.closedTrades })}
          />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.esgCorrelation} value={fRatio(hero.esgCorrelation)} sub={L.esgCorrelationSub} />
        </Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.avgHold}
            value={hero.avgHoldDays === null ? '—' : interpolate(L.avgHoldValue, { days: hero.avgHoldDays.toFixed(1) })}
          />
        </Grid>
      </Grid>

      {/* 圖表卡片底部留白比一般卡片少一點：X 軸標籤本身已經有空間，再加滿 p: 3 會空一大塊。 */}
      <Card sx={{ p: 3, pb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.equityTitle}</Typography>
        <Box sx={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={hero.equityCurve} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={48} height={22} tickMargin={4} />
              <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={64} />
              <Tooltip
                {...tooltipProps(theme)}
                cursor={lineCursor(theme)}
                formatter={(value) => [`${fUsd(Number(value))} USDC`, L.equityTitle]}
              />
              <Line type="monotone" dataKey="equity" stroke={theme.palette.primary.main} dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{L.equityNote}</Typography>
      </Card>

      <Card sx={{ p: 3, pb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.monthlyTitle}</Typography>
        <Box sx={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hero.monthlyReturns} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} minTickGap={24} height={22} tickMargin={4} />
              <YAxis tick={{ fontSize: 11 }} width={48} unit="%" />
              <Tooltip
                {...tooltipProps(theme)}
                cursor={barCursor(theme)}
                formatter={(value) => [fSignedPct(Number(value)), L.monthlyTitle]}
              />
              <Bar dataKey="returnPct" isAnimationActive={false}>
                {hero.monthlyReturns.map((m) => (
                  <Cell key={m.month} fill={m.returnPct >= 0 ? up : down} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Box>
      </Card>

      {hero.exposure.length > 0 && (
        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.exposureTitle}</Typography>
          <Stack spacing={1}>
            {hero.exposure.map((leg) => (
              <Box key={leg.asset}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 64 }}>{leg.asset}</Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={leg.isLong ? 'success' : 'error'}
                    label={`${leg.isLong ? L.long : L.short} ${leg.leverage}×`}
                    sx={{ height: 20, fontSize: '0.6875rem' }}
                  />
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>{leg.weightPct.toFixed(0)}%</Typography>
                </Stack>
                <Box sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}>
                  <Box sx={{ width: `${leg.weightPct}%`, height: '100%', bgcolor: leg.isLong ? up : down }} />
                </Box>
              </Box>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
