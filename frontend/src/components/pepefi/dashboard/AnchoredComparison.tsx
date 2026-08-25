import { useMemo } from 'react';

import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { useBenchmarks } from 'src/hooks/useBenchmarks';
import { MONO } from 'src/components/pepefi/brandKit';
import { BENCHMARK_KEYS, pctChangeOf, formatPct } from 'src/lib/pepefi/benchmarks';
import { earliestOpenedAt, toDateStr, notionalReturnPct } from 'src/lib/pepefi/anchoredComparison';

// ----------------------------------------------------------------------
// 「你 vs 大盤」（issue #67）：以最早一筆未平倉部位的開倉時間為 Anchor Date
// （見 frontend/CONTEXT.md），比較你的報酬率與三個 Benchmark 同一區間的
// 報酬率。
//
// 你的報酬率分母是名目（margin × leverage），不是保證金——$100 保證金、5 倍
// 槓桿、標的漲 5%，以保證金計是 +25%，並排在 +5% 的指數旁邊會讓純粹的槓桿
// 看起來像超額報酬。上面 RwaAllocation 的配置環用保證金當分母，這裡用名目，
// 兩者不一致是刻意的：它們回答不同問題（我投了多少錢 vs 標的漲跌多少）。
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

export default function AnchoredComparison({ rows }: Props) {
  const anchorSec = useMemo(() => earliestOpenedAt(rows), [rows]);
  const anchorDate = anchorSec !== null ? toDateStr(anchorSec) : null;

  const userPct = useMemo(() => notionalReturnPct(rows), [rows]);

  // date === null → 沒有部位可比，完全不打 API（見 useBenchmarks 的三態說明）。
  const { benchmarks } = useBenchmarks(anchorDate);

  return (
    <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '1px dashed', borderColor: 'divider' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 700, display: 'block', mb: 1.5 }}
      >
        {t.portfolio.allocation.comparison.heading}
      </Typography>

      {rows.length === 0 || anchorDate === null ? (
        <Typography variant="body2" color="text.secondary">
          {t.portfolio.allocation.comparison.noPositions}
        </Typography>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {interpolate(t.portfolio.allocation.comparison.since, { date: anchorDate })}
          </Typography>

          {/* 你 + 四個指數 = 五欄。欄數跟著 BENCHMARK_KEYS 走,加減指數不必再改這裡。 */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: `repeat(${BENCHMARK_KEYS.length + 1}, 1fr)` },
              gap: 2,
            }}
          >
            <Box>
              <Tooltip title={t.portfolio.allocation.comparison.youHint}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
                >
                  {t.portfolio.allocation.comparison.youLabel}
                </Typography>
              </Tooltip>
              <Typography
                sx={{
                  fontFamily: MONO,
                  fontWeight: 700,
                  color: userPct === null ? 'text.disabled' : userPct >= 0 ? 'success.main' : 'error.main',
                }}
              >
                {userPct === null ? '—' : formatPct(userPct)}
              </Typography>
            </Box>

            {BENCHMARK_KEYS.map((key) => {
              // benchmarks 還沒載入完成、或這個指數的歷史值抓不到，都落在同一種
              // null → "—" 的處理：跟 BenchmarkStrip 一致，絕不編一個 0% 出來。
              const item = benchmarks?.[key];
              const pct = pctChangeOf(item?.current, item?.atDate);
              return (
                <Box key={key}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {t.portfolio.allocation.benchmark.names[key]}
                  </Typography>
                  <Typography
                    sx={{
                      fontFamily: MONO,
                      fontWeight: 700,
                      color: pct === null ? 'text.disabled' : pct >= 0 ? 'success.main' : 'error.main',
                    }}
                  >
                    {pct === null ? '—' : formatPct(pct)}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
}
