import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Line, XAxis, YAxis, Tooltip, LineChart, ResponsiveContainer } from 'recharts';

import { t, interpolate } from 'src/locales';
import StatCard from 'src/components/pepefi/StatCard';
import { MONO } from 'src/components/pepefi/brandKit';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { fDrawdown, riskBandLabels, type HeroDetail } from 'src/lib/pepefi/heroData';

import { lineCursor, tooltipProps } from './chartTooltip';

// ----------------------------------------------------------------------
// 參考 eToro 交易者統計頁的「風險」「交易」「其他」三張卡（issue #309）。數字來自
// public/data/heroes/<address>.json，由鏈上事件算出；這個元件只畫。

// 六張卡一列三張、排兩整列（一列四張會變成 4＋2、右邊空一塊，日期也會被擠成兩行）。
const STAT = { xs: 6, md: 4 };

/**
 * 十格量表撐滿卡片寬度，分數在最右邊；每一格下面標出那一級的單日 VaR 範圍，
 * 讀的人可以直接對照「這位交易者的 VaR 落在哪一格」。窄螢幕放不下十個標籤時只顯示格子。
 */
function RiskMeter({ score }: { score: number | null }) {
  const theme = useTheme();
  const colorOf = (n: number) =>
    n <= 3 ? theme.palette.success.main : n <= 6 ? theme.palette.warning.main : theme.palette.error.main;
  const labels = riskBandLabels();
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr)) auto', columnGap: 0.5, rowGap: 0.5, alignItems: 'center' }}>
      {labels.map((_, i) => (
        <Box
          key={`box-${i}`}
          sx={{ height: 18, borderRadius: 0.5, bgcolor: score !== null && i + 1 <= score ? colorOf(score) : 'action.hover' }}
        />
      ))}
      <Typography sx={{ ml: 1.5, fontFamily: MONO, fontWeight: 'bold', fontSize: '1.25rem', lineHeight: 1 }}>
        {score ?? '—'}
      </Typography>
      {labels.map((label, i) => (
        <Typography
          key={`label-${i}`}
          variant="caption"
          sx={{
            display: { xs: 'none', sm: 'block' },
            textAlign: 'center',
            fontFamily: MONO,
            fontSize: '0.625rem',
            color: score === i + 1 ? 'text.primary' : 'text.disabled',
            fontWeight: score === i + 1 ? 'bold' : 'normal',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </Typography>
      ))}
    </Box>
  );
}

export default function HeroRiskStats({ hero }: { hero: HeroDetail }) {
  const theme = useTheme();
  const L = t.traderProfile.hero;

  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>{L.riskTitle}</Typography>

      <Stack spacing={0.5} sx={{ mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Typography variant="subtitle2">{L.riskScore}</Typography>
          <Typography variant="caption" color="text.secondary">{L.riskScoreScale}</Typography>
        </Stack>
        <RiskMeter score={hero.riskScore} />
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">{L.riskScoreNote}</Typography>
          <Typography variant="caption" color="text.secondary">{L.riskScoreBands}</Typography>
          <Typography variant="caption" color="text.secondary">{L.riskScoreReference}</Typography>
        </Stack>
      </Stack>

      {/* 三個損失欄位跟回撤一樣存正數，用同一個 fDrawdown 顯示成損失。 */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={STAT}><StatCard title={L.worstDay} value={fDrawdown(hero.worstDayLossPct)} /></Grid>
        <Grid size={STAT}><StatCard title={L.worstWeek} value={fDrawdown(hero.worstWeekLossPct)} /></Grid>
        <Grid size={STAT}><StatCard title={L.drawdown1y} value={fDrawdown(hero.maxDrawdown1yPct)} /></Grid>
        <Grid size={STAT}>
          <StatCard
            title={L.profitableWeeks}
            value={hero.profitableWeeksPct === null ? '—' : `${hero.profitableWeeksPct.toFixed(0)}%`}
          />
        </Grid>
        <Grid size={STAT}><StatCard title={L.tradesPerWeek} value={hero.tradesPerWeek.toFixed(1)} /></Grid>
        <Grid size={STAT}><StatCard title={L.activeSince} value={hero.activeSince ?? '—'} /></Grid>
      </Grid>

      {hero.topAssets.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
          <Typography variant="subtitle2" sx={{ mr: 1 }}>{L.topAssets}</Typography>
          {hero.topAssets.map((a) => (
            <Chip
              key={a.asset}
              size="small"
              variant="outlined"
              label={interpolate(L.topAssetValue, { asset: a.asset, share: a.sharePct.toFixed(0) })}
              sx={{ fontFamily: MONO }}
            />
          ))}
        </Stack>
      )}

      {/* 跟隨人數跟個人頁的跟隨者統計卡一樣，跟單旗標關閉時不出現。 */}
      {FEATURE_COPY_TRADING && hero.followerHistory.length > 1 && (
        <>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{L.followersTitle}</Typography>
          <Box sx={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hero.followerHistory} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} minTickGap={24} height={22} tickMargin={4} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
                <Tooltip
                  {...tooltipProps(theme)}
                  cursor={lineCursor(theme)}
                  formatter={(value) => [String(value), L.followersTitle]}
                />
                <Line type="stepAfter" dataKey="followers" stroke={theme.palette.info.main} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </>
      )}
    </Card>
  );
}
