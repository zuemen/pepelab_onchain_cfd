import { useRef, useMemo, useState, useEffect } from 'react';
import { useSearchParams, Link as RouterLink } from 'react-router';

import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Tabs from '@mui/material/Tabs';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import Button from '@mui/material/Button';
import TableRow from '@mui/material/TableRow';
import MenuItem from '@mui/material/MenuItem';
import Container from '@mui/material/Container';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TextField from '@mui/material/TextField';
import Accordion from '@mui/material/Accordion';
import Typography from '@mui/material/Typography';
import ButtonBase from '@mui/material/ButtonBase';
import ToggleButton from '@mui/material/ToggleButton';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import { t, interpolate } from 'src/locales';
import { useMode } from 'src/contexts/mode-context';
import { usePepefiWallet } from 'src/layouts/pepefi';
import { heroDisclosure } from 'src/lib/pepefi/heroDisclosure';
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags';
import { fUsd, fRatio, fDrawdown, fSignedPct, type HeroSummary } from 'src/lib/pepefi/heroData';
import {
  dayToDate,
  snapParams,
  fetchLabIndex,
  type LabIndex,
  fetchLabResult,
  type LabResult,
  type LabMetrics,
  type LabStrategy,
  fetchSimilarTraders,
} from 'src/lib/pepefi/labData';

import StatCard from 'src/components/pepefi/StatCard';
import { MONO } from 'src/components/pepefi/brandKit';
import { useToast } from 'src/components/pepefi/ToastProvider';
import { LabEquityChart, LabForecastChart } from 'src/components/pepefi/lab/LabCharts';

// ----------------------------------------------------------------------
// 策略實驗室（issue #332）：選策略、參數與標的，看回測與未來 90 天的區間。
//
// 結果全部由 heroes/build_lab.py 預先算好（public/data/lab/），這一頁只讀檔、不計算、不讀鏈，
// 所以未連錢包也能看。唯一和鏈有關的是「相近的模擬交易者」：只在連線的鏈有 #309 績效資料、
// 而且資料裡有用同一條規則的交易者時才出現，否則整塊不顯示（公開展示站上就是不顯示）。
//
// 只在 Expert 模式：馬丁加倉、做空、清算是交易桌的詞，Simple 模式不能出現。

const L = t.lab;

type StrategyText = { name: string; tagline: string; description: string };
const strategyText = (id: string): StrategyText =>
  (L.strategies as Record<string, StrategyText>)[id] ?? { name: id, tagline: '', description: '' };

const paramLabel = (key: string) => (L.params as Record<string, string>)[key] ?? key;

function paramValue(key: string, value: number): string {
  const n = String(value);
  if (key === 'every_days') return interpolate(L.values.days, { n });
  if (key === 'lookback' || key === 'window') return interpolate(L.values.span, { n });
  if (key === 'leverage' || key === 'multiplier') return interpolate(L.values.times, { n });
  if (key === 'levels') return interpolate(L.values.levels, { n });
  if (key.endsWith('_pct')) return interpolate(L.values.pct, { n });
  return n;
}

// 本金是整數金額，寫成「10,000」而不是「10,000.00」。
const capitalText = (index: LabIndex) => index.capitalUsd.toLocaleString('en-US');

const basketLabel = (id: string) => (L.baskets as Record<string, string>)[id] ?? id;

export default function StrategyLabPage() {
  const { mode, setMode } = useMode();

  if (mode !== 'expert') {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>{L.expertOnly.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>{L.expertOnly.body}</Typography>
          <Button variant="contained" onClick={() => setMode('expert')}>{L.expertOnly.action}</Button>
        </Card>
      </Container>
    );
  }
  return <StrategyLab />;
}

function StrategyLab() {
  const wallet = usePepefiWallet();
  const [search, setSearch] = useSearchParams();
  const [index, setIndex] = useState<LabIndex | null | undefined>(undefined);
  const [result, setResult] = useState<LabResult | null | undefined>(undefined);
  const [similar, setSimilar] = useState<HeroSummary[]>([]);
  const [similarCompressed, setSimilarCompressed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchLabIndex().then((loaded) => {
      if (!cancelled) setIndex(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 選擇放在網址上：分享連結就是分享同一組結果。網址上不合法的值一律退回第一個選項。
  const strategy: LabStrategy | undefined = useMemo(
    () => index?.strategies.find((s) => s.id === search.get('s')) ?? index?.strategies[0],
    [index, search]
  );
  const targets = useMemo(
    () => (!index || !strategy ? [] : strategy.kind === 'single' ? index.assets.map((a) => a.id) : index.baskets.map((b) => b.id)),
    [index, strategy]
  );
  const target = targets.includes(search.get('t') ?? '') ? (search.get('t') as string) : targets[0];
  const values = useMemo(
    () => (strategy ? snapParams(strategy, Object.fromEntries(strategy.params.map((p) => [p.key, Number(search.get(p.key) ?? NaN)]))) : []),
    [strategy, search]
  );
  const valuesKey = values.join('_');

  useEffect(() => {
    if (!strategy || !target) return undefined;
    let cancelled = false;
    setResult(undefined);
    void fetchLabResult(strategy.id, target, values).then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
    // valuesKey 代表 values 的內容；values 本身每次 render 都是新陣列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, target, valuesKey]);

  useEffect(() => {
    let cancelled = false;
    setSimilar([]);
    setSimilarCompressed(false);
    void fetchSimilarTraders(strategy, wallet.chainId).then((found) => {
      if (cancelled) return;
      setSimilar(found.traders);
      setSimilarCompressed(found.timeCompressed);
    });
    return () => {
      cancelled = true;
    };
  }, [strategy, wallet.chainId]);

  // 連續兩次點選時，第二次要接在第一次的結果上。useSearchParams 給的（連函式形式也是）是 render 當下的網址，
  // 還沒反映上一次的點選，所以另外記住最後一次送出的網址。
  const latest = useRef(search);
  useEffect(() => {
    latest.current = search;
  }, [search]);
  const navigateTo = (params: URLSearchParams) => {
    latest.current = params;
    setSearch(params, { replace: true });
  };
  const choose = (next: Record<string, string | number>) => {
    const params = new URLSearchParams(latest.current);
    for (const [k, v] of Object.entries(next)) params.set(k, String(v));
    navigateTo(params);
  };
  // 換策略時參數與標的重設：不同策略的參數格點與標的種類不同
  const chooseStrategy = (id: string) => navigateTo(new URLSearchParams({ s: id }));

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{L.title}</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>{L.subtitle}</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
            {[L.steps.pick, L.steps.tune, L.steps.read].map((step, i) => (
              <Chip key={step} size="small" variant="outlined" label={`${i + 1}. ${step}`} />
            ))}
          </Stack>
        </Box>

        {/* 揭露固定顯示、不可收合 */}
        <Alert severity="warning" variant="outlined" sx={{ '& .MuiAlert-message': { typography: 'caption' } }}>
          {L.disclosure}
        </Alert>

        {index === undefined && <Typography color="text.secondary">{L.loading}</Typography>}
        {index === null && <Alert severity="error">{L.indexMissing}</Alert>}

        {index && strategy && target && (
          <Grid container spacing={3} alignItems="flex-start">
            {/* 左：設定。桌機上捲動時固定在畫面上，改參數時右邊的結果就在旁邊變。 */}
            <Grid size={{ xs: 12, md: 5, lg: 4 }} sx={{ position: { md: 'sticky' }, top: { md: 88 } }}>
              <Picker
                index={index}
                strategy={strategy}
                target={target}
                targets={targets}
                values={values}
                onStrategy={chooseStrategy}
                onChoose={choose}
              />
            </Grid>

            {/* 右：結果。先結論、再圖，明細預設收起，最後是下一步。 */}
            <Grid size={{ xs: 12, md: 7, lg: 8 }}>
              <Stack spacing={3}>
                {result === null && <Alert severity="info">{L.resultMissing}</Alert>}

                <SummaryCard index={index} strategy={strategy} target={target} result={result ?? null} />

                <ResultTabs index={index} result={result ?? null} />

                <Details result={result ?? null} />

                <NextStep strategy={strategy} similar={similar} compressed={similarCompressed} />
              </Stack>
            </Grid>
          </Grid>
        )}
      </Stack>
    </Container>
  );
}

// ── 選擇 ─────────────────────────────────────────────────────────────────────

function Picker(props: {
  index: LabIndex;
  strategy: LabStrategy;
  target: string;
  targets: string[];
  values: number[];
  onStrategy: (id: string) => void;
  onChoose: (next: Record<string, string | number>) => void;
}) {
  const { index, strategy, target, targets, values, onStrategy, onChoose } = props;
  const groups: { kind: LabStrategy['kind']; label: string }[] = [
    { kind: 'single', label: L.picker.single },
    { kind: 'portfolio', label: L.picker.portfolio },
  ];
  const basket = index.baskets.find((b) => b.id === target);
  const step = (n: number, label: string) => (
    <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{`${n}. ${label}`}</Typography>
  );

  return (
    <Card sx={{ p: 2.5 }}>
      <Stack spacing={2.5}>
        <Box>
          {step(1, L.picker.strategy)}
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {groups.map((g) => (
              <Box key={g.kind}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>{g.label}</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)' }, gap: 1 }}>
                  {index.strategies.filter((s) => s.kind === g.kind).map((s) => {
                    const selected = s.id === strategy.id;
                    const text = strategyText(s.id);
                    return (
                      <ButtonBase
                        key={s.id}
                        onClick={() => onStrategy(s.id)}
                        aria-pressed={selected}
                        sx={{
                          display: 'block',
                          textAlign: 'left',
                          p: 1,
                          borderRadius: 1.5,
                          border: '1px solid',
                          borderColor: selected ? 'primary.main' : 'divider',
                          bgcolor: selected ? 'action.selected' : 'transparent',
                          '&:hover': { borderColor: 'primary.main' },
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 700, color: selected ? 'primary.main' : 'text.primary' }}>
                          {text.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>
                          {text.tagline}
                        </Typography>
                      </ButtonBase>
                    );
                  })}
                </Box>
              </Box>
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            {interpolate(strategyText(strategy.id).description, { base: index.martingaleBasePct })}
          </Typography>
        </Box>

        <Box>
          {step(2, L.picker.params)}
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {strategy.params.map((p, i) => (
              <Box key={p.key}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  {paramLabel(p.key)}
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={values[i]}
                  onChange={(_, v: number | null) => v !== null && onChoose({ [p.key]: v })}
                  sx={{ flexWrap: 'wrap' }}
                >
                  {p.values.map((v) => (
                    <ToggleButton key={v} value={v} sx={{ px: 1.5 }}>{paramValue(p.key, v)}</ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>
            ))}
          </Stack>
        </Box>

        <Box>
          {step(3, strategy.kind === 'single' ? L.picker.asset : L.picker.basket)}
          <Box sx={{ mt: 1 }}>
            {strategy.kind === 'single' ? (
              <TextField select size="small" fullWidth value={target} onChange={(e) => onChoose({ t: e.target.value })}>
                {targets.map((id) => (
                  <MenuItem key={id} value={id}>{id}</MenuItem>
                ))}
              </TextField>
            ) : (
              <>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={target}
                  onChange={(_, v: string | null) => v !== null && onChoose({ t: v })}
                  sx={{ flexWrap: 'wrap' }}
                >
                  {targets.map((id) => (
                    <ToggleButton key={id} value={id} sx={{ px: 1.5 }}>{basketLabel(id)}</ToggleButton>
                  ))}
                </ToggleButtonGroup>
                {basket && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, fontFamily: MONO }}>
                    {basket.assets.join(' · ')}
                  </Typography>
                )}
              </>
            )}
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {interpolate(L.range, { from: index.range.from, to: index.range.to, capital: capitalText(index) })}
        </Typography>
      </Stack>
    </Card>
  );
}

function FeeNote({ index, strategy, target, result }: { index: LabIndex; strategy: LabStrategy; target: string; result: LabResult | null }) {
  const asset = index.assets.find((a) => a.id === target);
  const capped =
    result?.effectiveLeverage !== undefined && result.effectiveLeverage < (result.params.leverage ?? 1);
  return (
    <Typography variant="caption" color="text.secondary" component="div">
      {strategy.kind === 'single' && asset
        ? interpolate(L.fees.single, {
            fee: asset.feeBps / 100,
            tier: (L.tiers as Record<string, string>)[asset.carbonTier] ?? asset.carbonTier,
            borrow: asset.borrowBpsPerHour / 100,
          })
        : L.fees.portfolio}
      {strategy.kind === 'portfolio' && strategy.params.some((p) => p.key === 'leverage') && ` ${L.fees.portfolioLeverage}`}
      {capped && asset && ` ${interpolate(L.fees.leverageCapped, { asset: asset.id, max: asset.maxLeverage })}`}
    </Typography>
  );
}

// ── 結論 ─────────────────────────────────────────────────────────────────────

const lastOf = (xs: number[] | undefined) => (xs && xs.length > 0 ? xs[xs.length - 1] : undefined);

function SummaryCard({ index, strategy, target, result }: { index: LabIndex; strategy: LabStrategy; target: string; result: LabResult | null }) {
  const m = result?.metrics;
  const b = result?.benchmarkMetrics;
  const final = lastOf(result?.equity);
  const holdFinal = lastOf(result?.benchmark);
  // 「贏／輸」只比累積報酬；差距四捨五入到 0.1 個百分點，0 就是打平。
  const gap = m && b ? Math.round((m.totalReturnPct - b.totalReturnPct) * 10) / 10 : undefined;
  const verdict =
    gap === undefined
      ? null
      : gap > 0
        ? { label: interpolate(L.summary.beat, { pts: gap.toFixed(1) }), color: 'success' as const }
        : gap < 0
          ? { label: interpolate(L.summary.lose, { pts: Math.abs(gap).toFixed(1) }), color: 'error' as const }
          : { label: L.summary.tie, color: 'default' as const };
  const targetLabel = strategy.kind === 'single' ? target : basketLabel(target);
  const up = (m?.totalReturnPct ?? 0) >= 0;
  const stats = [
    { label: L.summary.maxDrawdown, value: fDrawdown(m?.maxDrawdownPct) },
    { label: L.summary.riskScore, value: m?.riskScore === null || m?.riskScore === undefined ? '—' : `${m.riskScore} / 10` },
    { label: L.summary.trades, value: m ? String(m.trades) : '—' },
    {
      label: interpolate(L.summary.lossProb, { days: index.forecast.horizonDays }),
      value: result ? `${result.forecast.lossProbPct.toFixed(1)}%` : '—',
    },
  ];

  return (
    <Card sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} flexWrap="wrap" useFlexGap>
        <Typography variant="overline" color="text.secondary">{L.summary.title}</Typography>
        {verdict && <Chip size="small" color={verdict.color} label={verdict.label} sx={{ fontWeight: 700 }} />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {interpolate(L.summary.sentence, {
          from: result?.start ?? index.range.from,
          to: index.range.to,
          capital: capitalText(index),
          strategy: strategyText(strategy.id).name,
          target: targetLabel,
        })}
      </Typography>
      <Stack direction="row" alignItems="baseline" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        <Typography variant="h3" sx={{ fontFamily: MONO, fontWeight: 800 }}>
          {final === undefined ? '—' : `${fUsd(final)} USDC`}
        </Typography>
        <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 700, color: m ? (up ? 'success.main' : 'error.main') : 'text.secondary' }}>
          {fSignedPct(m?.totalReturnPct)}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {interpolate(L.summary.benchmark, {
          final: holdFinal === undefined ? '—' : fUsd(holdFinal),
          pct: fSignedPct(b?.totalReturnPct),
        })}
      </Typography>

      <Box sx={{ mt: 2.5, display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' }, gap: 2 }}>
        {stats.map((st) => (
          <Box key={st.label}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{st.label}</Typography>
            <Typography variant="subtitle1" sx={{ fontFamily: MONO, fontWeight: 700 }}>{st.value}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ mt: 2 }}>
        <FeeNote index={index} strategy={strategy} target={target} result={result} />
      </Box>
    </Card>
  );
}

// ── 圖：回測／預測 ─────────────────────────────────────────────────────────────

function ResultTabs({ index, result }: { index: LabIndex; result: LabResult | null }) {
  const [tab, setTab] = useState<'backtest' | 'forecast'>('backtest');
  return (
    <Stack spacing={2}>
      <Card sx={{ px: 3, pb: 2 }}>
        <Tabs
          value={tab}
          onChange={(_, v: 'backtest' | 'forecast') => setTab(v)}
          variant="fullWidth"
          sx={{ mb: 2, '& .MuiTab-root': { whiteSpace: 'normal', minWidth: 0 } }}
        >
          <Tab value="backtest" label={L.tabs.backtest} />
          <Tab value="forecast" label={interpolate(L.tabs.forecast, { days: index.forecast.horizonDays })} />
        </Tabs>
        {tab === 'backtest' && result && <LabEquityChart result={result} embedded />}
        {tab === 'forecast' && <ForecastSection index={index} result={result} />}
      </Card>
      {/* 預測方法的假設固定顯示：不論停在哪個分頁都看得到 */}
      <Alert severity="info" variant="outlined" sx={{ '& .MuiAlert-message': { typography: 'caption' } }}>
        {interpolate(L.forecast.method, {
          from: result?.forecast.from ?? index.range.to,
          capital: capitalText(index),
          block: index.forecast.blockDays,
          paths: index.forecast.paths.toLocaleString('en-US'),
          days: index.forecast.horizonDays,
        })}
      </Alert>
    </Stack>
  );
}

// ── 明細（預設收起）────────────────────────────────────────────────────────────

const ACCORDION_SUMMARY_SX = { '& .MuiAccordionSummary-content': { my: 1.25 } };

function Details({ result }: { result: LabResult | null }) {
  return (
    <Box>
      <Accordion disableGutters>
        <AccordionSummary expandIcon={<Typography variant="caption">▼</Typography>} sx={ACCORDION_SUMMARY_SX}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{L.details.metrics}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <MetricsTable result={result} />
        </AccordionDetails>
      </Accordion>
      <Accordion disableGutters>
        <AccordionSummary expandIcon={<Typography variant="caption">▼</Typography>} sx={ACCORDION_SUMMARY_SX}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {interpolate(L.details.trades, { count: result ? result.trades.length : '—' })}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>{result && <TradesTable result={result} />}</AccordionDetails>
      </Accordion>
    </Box>
  );
}

// ── 下一步 ───────────────────────────────────────────────────────────────────

function NextStep({ strategy, similar, compressed }: { strategy: LabStrategy; similar: HeroSummary[]; compressed: boolean }) {
  const { notify } = useToast();
  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      notify(L.next.copied, true);
    } catch {
      /* 剪貼簿被瀏覽器擋下時不做任何事：網址列上本來就是這組設定 */
    }
  };
  return (
    <Card sx={{ p: 3 }}>
      <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{L.next.title}</Typography>

      {similar.length > 0 && <SimilarTraders traders={similar} compressed={compressed} />}

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
        <Button variant="contained" component={RouterLink} to="/marketplace">{L.next.marketplace}</Button>
        <Button variant="outlined" onClick={() => void share()}>{L.next.share}</Button>
      </Stack>

      <Box sx={{ mt: 2.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 'bold', display: 'block' }}>{L.noOrder.title}</Typography>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.25 }}>
          {L.noOrder.body}
          {FEATURE_COPY_TRADING && ` ${L.noOrder.copy}`}
          {strategy.kind === 'single' && ` ${L.noOrder.single}`}
        </Typography>
      </Box>
    </Card>
  );
}

// ── 指標 ─────────────────────────────────────────────────────────────────────

function metricRows(m: LabMetrics | null) {
  return [
    { label: L.metrics.totalReturn, value: fSignedPct(m?.totalReturnPct) },
    { label: L.metrics.maxDrawdown, value: fDrawdown(m?.maxDrawdownPct) },
    { label: L.metrics.sharpe, value: fRatio(m?.sharpe) },
    { label: L.metrics.winRate, value: m?.winRatePct === null || m?.winRatePct === undefined ? '—' : `${m.winRatePct.toFixed(0)}%` },
    { label: L.metrics.trades, value: m ? String(m.trades) : '—' },
    { label: L.metrics.riskScore, value: m?.riskScore === null || m?.riskScore === undefined ? '—' : `${m.riskScore} / 10` },
  ];
}

function MetricsTable({ result }: { result: LabResult | null }) {
  const mine = metricRows(result?.metrics ?? null);
  const hold = metricRows(result?.benchmarkMetrics ?? null);
  return (
    <Box>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell />
              <TableCell align="right">{L.metrics.strategy}</TableCell>
              <TableCell align="right">{L.metrics.benchmark}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {mine.map((row, i) => (
              <TableRow key={row.label}>
                <TableCell>{row.label}</TableCell>
                <TableCell align="right" sx={{ fontFamily: MONO, fontWeight: 600 }}>{row.value}</TableCell>
                <TableCell align="right" sx={{ fontFamily: MONO, color: 'text.secondary' }}>{hold[i].value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{L.metrics.winRateNote}</Typography>
    </Box>
  );
}

// ── 預測 ─────────────────────────────────────────────────────────────────────

const STAT = { xs: 12, sm: 6, md: 4 };

function ForecastSection({ index, result }: { index: LabIndex; result: LabResult | null }) {
  const f = result?.forecast ?? null;
  const end = (band: number[] | undefined) => (band && band.length > 0 ? `${fUsd(band[band.length - 1])} USDC` : '—');
  const pct = (v: number | undefined) => (v === undefined ? '—' : `${v.toFixed(1)}%`);
  return (
    <Stack spacing={2}>
      {result && <LabForecastChart result={result} capital={index.capitalUsd} embedded />}
      <Grid container spacing={2}>
        <Grid size={STAT}>
          <StatCard title={L.forecast.p5} value={end(f?.percentiles.p5)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.forecast.p50} value={end(f?.percentiles.p50)} />
        </Grid>
        <Grid size={STAT}>
          <StatCard title={L.forecast.p95} value={end(f?.percentiles.p95)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <StatCard title={L.forecast.lossProb} value={pct(f?.lossProbPct)} valueColor="warning.main" />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <StatCard title={L.forecast.halfLossProb} value={pct(f?.halfLossProbPct)} valueColor="error.main" />
        </Grid>
      </Grid>
    </Stack>
  );
}

// ── 交易 ─────────────────────────────────────────────────────────────────────

function TradesTable({ result }: { result: LabResult }) {
  const actionLabel = { open: L.chart.open, close: L.chart.close, liquidated: L.chart.liquidated };
  const rows = [...result.trades].reverse();
  return (
    <Box>
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{L.trades.empty}</Typography>
      ) : (
        <Box sx={{ maxHeight: 360, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>{L.trades.date}</TableCell>
                <TableCell>{L.trades.asset}</TableCell>
                <TableCell>{L.trades.action}</TableCell>
                <TableCell>{L.trades.side}</TableCell>
                <TableCell align="right">{L.trades.price}</TableCell>
                <TableCell align="right">{L.trades.margin}</TableCell>
                <TableCell align="right">{L.trades.pnl}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((tr, i) => (
                <TableRow key={`${tr.day}-${tr.asset}-${tr.action}-${i}`}>
                  <TableCell sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>{dayToDate(result.start, tr.day)}</TableCell>
                  <TableCell>{tr.asset}</TableCell>
                  <TableCell sx={{ color: tr.action === 'liquidated' ? 'error.main' : undefined }}>{actionLabel[tr.action]}</TableCell>
                  <TableCell sx={{ color: tr.isLong ? 'success.main' : 'error.main' }}>{tr.isLong ? L.trades.long : L.trades.short}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>{fUsd(tr.price)}</TableCell>
                  <TableCell align="right" sx={{ fontFamily: MONO }}>{fUsd(tr.marginUsd)}</TableCell>
                  <TableCell
                    align="right"
                    sx={{ fontFamily: MONO, color: tr.pnlUsd === null ? 'text.secondary' : tr.pnlUsd >= 0 ? 'success.main' : 'error.main' }}
                  >
                    {tr.pnlUsd === null ? '—' : fUsd(tr.pnlUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Box>
  );
}

// ── 相近的模擬交易者 ──────────────────────────────────────────────────────────

function SimilarTraders({ traders, compressed }: { traders: HeroSummary[]; compressed: boolean }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{L.similar.title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>{L.similar.body}</Typography>
      <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>{heroDisclosure(compressed)}</Alert>
      <Stack spacing={1}>
        {traders.map((h) => (
          <Stack key={h.address} direction="row" alignItems="center" spacing={2}>
            <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 140 }}>{h.name}</Typography>
            <Typography variant="body2" sx={{ fontFamily: MONO, color: h.totalReturnPct >= 0 ? 'success.main' : 'error.main' }}>
              {fSignedPct(h.totalReturnPct)}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" component={RouterLink} to={`/trader/${h.address}`}>{L.similar.view}</Button>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
