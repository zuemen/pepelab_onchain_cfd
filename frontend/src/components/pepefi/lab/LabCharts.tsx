import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Area, Line, XAxis, YAxis, Legend, Tooltip, ComposedChart, CartesianGrid, ReferenceLine, ResponsiveContainer } from 'recharts';

import { t, interpolate } from 'src/locales';
import { fUsd } from 'src/lib/pepefi/heroData';
import { dayToDate, type LabResult, type LabAction } from 'src/lib/pepefi/labData';

import { lineCursor, tooltipProps } from '../hero/chartTooltip';

// ----------------------------------------------------------------------
// 策略實驗室的兩張圖（issue #332）：回測淨值與買賣點、未來 90 天的淨值區間。資料都是預先算好的。

const L = t.lab;

type EquityRow = { date: string; equity: number; benchmark: number } & Partial<Record<LabAction, number>>;

export function LabEquityChart({ result }: { result: LabResult }) {
  const theme = useTheme();
  const rows: EquityRow[] = result.equity.map((equity, day) => ({
    date: dayToDate(result.start, day),
    equity,
    benchmark: result.benchmark[day],
  }));
  // 買賣點畫在策略的淨值線上：同一天有多筆時只畫一個點。
  for (const trade of result.trades) rows[trade.day][trade.action] = rows[trade.day].equity;

  const markers: { key: LabAction; color: string; label: string }[] = [
    { key: 'open', color: theme.palette.success.main, label: L.chart.open },
    { key: 'close', color: theme.palette.warning.main, label: L.chart.close },
    { key: 'liquidated', color: theme.palette.error.main, label: L.chart.liquidated },
  ];
  const label = (name: string) =>
    ({ equity: L.chart.strategy, benchmark: L.chart.benchmark, ...Object.fromEntries(markers.map((m) => [m.key, m.label])) })[name] ?? name;

  return (
    <Card sx={{ p: 3, pb: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 2 }}>{L.chart.title}</Typography>
      <Box sx={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={48} height={22} tickMargin={4} />
            <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={64} />
            <Tooltip
              {...tooltipProps(theme)}
              cursor={lineCursor(theme)}
              formatter={(value, name) => [`${fUsd(Number(value))} USDC`, label(String(name))]}
            />
            <Legend formatter={(name) => label(String(name))} wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="benchmark" stroke={theme.palette.text.disabled} strokeDasharray="5 4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line type="monotone" dataKey="equity" stroke={theme.palette.primary.main} dot={false} strokeWidth={2} isAnimationActive={false} />
            {markers.map((m) =>
              result.trades.some((tr) => tr.action === m.key) ? (
                <Line
                  key={m.key}
                  dataKey={m.key}
                  stroke="none"
                  dot={{ r: 3, fill: m.color, stroke: m.color }}
                  activeDot={false}
                  legendType="circle"
                  isAnimationActive={false}
                />
              ) : null
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{L.chart.note}</Typography>
    </Card>
  );
}

export function LabForecastChart({ result, capital }: { result: LabResult; capital: number }) {
  const theme = useTheme();
  const p = result.forecast.percentiles;
  const rows = p.p50.map((median, day) => ({
    date: dayToDate(result.forecast.from, day),
    outer: [p.p5[day], p.p95[day]],
    inner: [p.p25[day], p.p75[day]],
    p50: median,
  }));
  const label = (name: string) => ({ outer: L.forecast.outer, inner: L.forecast.inner, p50: L.forecast.p50 })[name] ?? name;
  const range = (value: unknown) =>
    Array.isArray(value) ? `${fUsd(Number(value[0]))} – ${fUsd(Number(value[1]))}` : fUsd(Number(value));

  return (
    <Card sx={{ p: 3, pb: 2 }}>
      <Stack direction="row" alignItems="baseline" spacing={1.5} flexWrap="wrap" sx={{ mb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
          {interpolate(L.forecast.title, { days: p.p50.length - 1 })}
        </Typography>
      </Stack>
      <Box sx={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={48} height={22} tickMargin={4} />
            <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={64} />
            <Tooltip
              {...tooltipProps(theme)}
              cursor={lineCursor(theme)}
              formatter={(value, name) => [`${range(value)} USDC`, label(String(name))]}
            />
            <Legend formatter={(name) => label(String(name))} wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={capital} stroke={theme.palette.text.disabled} strokeDasharray="4 4" />
            <Area dataKey="outer" stroke="none" fill={theme.palette.primary.main} fillOpacity={0.12} isAnimationActive={false} />
            <Area dataKey="inner" stroke="none" fill={theme.palette.primary.main} fillOpacity={0.28} isAnimationActive={false} />
            <Line dataKey="p50" stroke={theme.palette.primary.main} dot={false} strokeWidth={2} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
    </Card>
  );
}
