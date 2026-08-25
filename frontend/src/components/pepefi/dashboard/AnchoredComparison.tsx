import { useMemo } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { useBenchmarks } from 'src/hooks/useBenchmarks';
import { MONO } from 'src/components/pepefi/brandKit';
import { BENCHMARK_KEYS, pctChangeOf, formatPct } from 'src/lib/pepefi/benchmarks';
import {
  earliestOpenedAt,
  toDateStr,
  notionalReturnPct,
  daysSince,
  beatCountOf,
  divergingBarOf,
  comparisonScaleOf,
} from 'src/lib/pepefi/anchoredComparison';

// ----------------------------------------------------------------------
// 「你 vs 大盤」（issue #67）：以最早一筆未平倉部位的開倉時間為 Anchor Date
// （見 frontend/CONTEXT.md），比較你的報酬率與四個 Benchmark 同一區間的
// 報酬率。
//
// 你的報酬率分母是名目（margin × leverage），不是保證金——$100 保證金、5 倍
// 槓桿、標的漲 5%，以保證金計是 +25%，並排在 +5% 的指數旁邊會讓純粹的槓桿
// 看起來像超額報酬。上面 RwaAllocation 的配置環用保證金當分母，這裡用名目，
// 兩者不一致是刻意的：它們回答不同問題（我投了多少錢 vs 標的漲跌多少）。
//
// 五個並排的百分比本身沒有回答「所以我到底贏了誰、贏多少」——那個減法留給
// 讀者心算，等於把這一區的重點藏起來。所以：一句結論（贏過幾個）、每一列的
// 差距（百分點），以及共用刻度的長條，讓長短直接可比。
//
// 差距的單位是**百分點（pp）**不是 %：24.21% 與 23.10% 差的是 1.11 個百分點，
// 寫成「+1.11%」會被讀成相對變化（那是 4.8%），是另一個數字。
//
// 沒有部位就沒有 Anchor Date，比較在數學上不成立——顯示「尚無持倉」，
// 不是 0%（0% 看起來像是「你跟大盤打平」，那是一個真的、但編出來的答案）。

export interface ComparisonRow {
  asset: string;
  margin: bigint;
  leverage: bigint;
  unrealizedPnL: bigint;
  /** unix 秒，這筆部位的開倉時間（合約 Position.openedAt）。 */
  openedAt: bigint;
}

type Props = {
  rows: ComparisonRow[];
};

/** 一列：名稱 + 報酬率 + 共用刻度的長條 + 與「你」的差距。 */
function ComparisonRowView({
  label,
  labelHint,
  pct,
  scale,
  gapPp,
  emphasis,
}: {
  label: string;
  labelHint?: string;
  pct: number | null;
  scale: [number, number];
  /** 相對「你」的差距（百分點）。正 = 你領先。「你」自己這一列不給。 */
  gapPp?: number | null;
  emphasis?: boolean;
}) {
  const bar = pct === null ? null : divergingBarOf(pct, scale[0], scale[1]);
  const tone = pct === null ? 'text.disabled' : pct >= 0 ? 'success.main' : 'error.main';

  const nameNode = (
    <Typography
      variant="caption"
      sx={{
        color: emphasis ? 'text.primary' : 'text.secondary',
        fontWeight: emphasis ? 700 : 400,
        ...(labelHint ? { cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 3 } : {}),
      }}
    >
      {label}
    </Typography>
  );

  return (
    <Stack direction="row" alignItems="center" spacing={1.5}>
      <Box sx={{ width: { xs: 92, sm: 116 }, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {labelHint ? <Tooltip title={labelHint}>{nameNode}</Tooltip> : nameNode}
      </Box>

      <Typography
        sx={{
          width: 92,
          flexShrink: 0,
          textAlign: 'right',
          whiteSpace: 'nowrap',
          fontFamily: MONO,
          fontWeight: emphasis ? 800 : 700,
          fontSize: emphasis ? '1rem' : '0.875rem',
          color: tone,
        }}
      >
        {pct === null ? '—' : formatPct(pct)}
      </Typography>

      {/* 共用刻度的長條。零線位置由 scale 決定，五列一致才比得出長短。 */}
      <Box sx={{ position: 'relative', flex: 1, height: 8, minWidth: 40 }}>
        <Box sx={{ position: 'absolute', inset: 0, borderRadius: 1, bgcolor: 'action.hover' }} />
        {bar && bar.widthPct > 0 && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${bar.leftPct}%`,
              width: `${bar.widthPct}%`,
              borderRadius: 1,
              bgcolor: tone,
              opacity: emphasis ? 1 : 0.65,
            }}
          />
        )}
      </Box>

      {/* 固定寬度 + nowrap：差距文字長度隨數值變動（「領先 1.08 百分點」vs
          「領先 25.56 百分點」），不釘住寬度就會換行，把那一列撐高、五列的
          基線就對不齊了。xs 藏起來——這一列在手機上已經很擠，而差距本來就
          能從左邊兩個百分比看出來，長條也還在。 */}
      <Typography
        variant="caption"
        sx={{
          display: { xs: 'none', sm: 'block' },
          width: 112,
          flexShrink: 0,
          textAlign: 'right',
          whiteSpace: 'nowrap',
          color: 'text.disabled',
        }}
      >
        {gapPp === null || gapPp === undefined
          ? ''
          : interpolate(gapPp >= 0 ? t.portfolio.allocation.comparison.aheadBy : t.portfolio.allocation.comparison.behindBy, {
              pp: Math.abs(gapPp).toFixed(2),
            })}
      </Typography>
    </Stack>
  );
}

export default function AnchoredComparison({ rows }: Props) {
  const anchorSec = useMemo(() => earliestOpenedAt(rows), [rows]);
  const anchorDate = anchorSec !== null ? toDateStr(anchorSec) : null;

  const userPct = useMemo(() => notionalReturnPct(rows), [rows]);

  // date === null → 沒有部位可比，完全不打 API（見 useBenchmarks 的三態說明）。
  const { benchmarks } = useBenchmarks(anchorDate);

  const items = useMemo(
    () =>
      BENCHMARK_KEYS.map((key) => {
        const item = benchmarks?.[key];
        return {
          key,
          label: t.portfolio.allocation.benchmark.names[key],
          pct: pctChangeOf(item?.current, item?.atDate),
        };
      }),
    [benchmarks],
  );

  const { beat, total } = beatCountOf(
    userPct,
    items.map((i) => i.pct),
  );

  // 五個項目共用同一個刻度,長條的長短才有可比性。
  const scale = useMemo(
    () => comparisonScaleOf([userPct, ...items.map((i) => i.pct)].filter((p): p is number => p !== null)),
    [userPct, items],
  );

  return (
    <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '1px dashed', borderColor: 'divider' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 700, display: 'block', mb: 1.5 }}
      >
        {t.portfolio.allocation.comparison.heading}
      </Typography>

      {rows.length === 0 || anchorDate === null || anchorSec === null ? (
        <Typography variant="body2" color="text.secondary">
          {t.portfolio.allocation.comparison.noPositions}
        </Typography>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {interpolate(t.portfolio.allocation.comparison.since, {
              date: anchorDate,
              days: daysSince(anchorSec),
            })}
          </Typography>

          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 700, mt: 0.5, mb: 2, color: beat === total && total > 0 ? 'success.main' : 'text.primary' }}
          >
            {total === 0
              ? t.portfolio.allocation.comparison.beatSummaryNone
              : interpolate(t.portfolio.allocation.comparison.beatSummary, { beat, total })}
          </Typography>

          <Stack spacing={1.25}>
            <ComparisonRowView
              label={t.portfolio.allocation.comparison.youLabel}
              labelHint={t.portfolio.allocation.comparison.youHint}
              pct={userPct}
              scale={scale}
              emphasis
            />
            {items.map((i) => (
              <ComparisonRowView
                key={i.key}
                label={i.label}
                pct={i.pct}
                scale={scale}
                gapPp={userPct === null || i.pct === null ? null : userPct - i.pct}
              />
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}
