import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { useBenchmarks } from 'src/hooks/useBenchmarks';
import { MONO } from 'src/components/pepefi/brandKit';
import Skeleton from 'src/components/pepefi/Skeleton';
import {
  BENCHMARK_KEYS,
  pctChangeOf,
  formatBenchmarkValue,
  formatPct,
  sparklinePoints,
  type BenchmarkKey,
} from 'src/lib/pepefi/benchmarks';

// ----------------------------------------------------------------------
// 對照指數列（Benchmark，見 frontend/CONTEXT.md）：四個指數的當前水準、當日
// 漲跌與近一個月走勢。四個標的刻意對應四個 Asset Class（股債金幣），所以上面
// 配置環的每一類都有一個外部對照，不是隨便挑幾個有名的指數。
//
// 刻意不吃任何跟持倉相關的 props——自己打 signal-api，零持倉、甚至從未開過倉
// 的使用者也照常看到即時數字（issue #65）。
//
// 當日漲跌的基準是後端給的 previousClose（相對最新那根的前一根收盤），不是
// 「昨天」這個日曆日。用日曆日的舊版本有一個結構性的錯：美股收盤後，最新的
// 日線就是「昨天」那根，於是 current 與「不晚於昨天的收盤」會解析到同一根
// K 棒，標普永遠顯示 +0.00%——線上實測就是這樣。

const SPARK_W = 88;
const SPARK_H = 24;

function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  const points = sparklinePoints(values, SPARK_W, SPARK_H);
  if (!points) return null;
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden
      sx={{ width: '100%', maxWidth: SPARK_W, height: SPARK_H, display: 'block', mt: 0.5, overflow: 'visible' }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ color: positive ? 'var(--palette-success-main)' : 'var(--palette-error-main)' }}
      />
    </Box>
  );
}

export default function BenchmarkStrip() {
  const { benchmarks, loading, error } = useBenchmarks();

  return (
    <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '1px dashed', borderColor: 'divider' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 700, display: 'block', mb: 1.5 }}
      >
        {t.portfolio.allocation.benchmark.heading}
      </Typography>

      {error ? (
        <Typography variant="body2" color="text.secondary">
          {error}
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
            gap: 2,
          }}
        >
          {BENCHMARK_KEYS.map((key: BenchmarkKey) => {
            const item = benchmarks?.[key];
            const name = t.portfolio.allocation.benchmark.names[key];
            const current = item?.current;
            // previousClose 缺席（新上市／只有一根資料）→ null → 顯示「—」，
            // 絕不拿 current 跟自己比生出一個 0.00%。
            const pct = pctChangeOf(current, item?.previousClose);
            const series = item?.series ?? [];

            return (
              <Box key={key}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {name}
                </Typography>
                {loading && !item ? (
                  <Skeleton width={72} height={20} />
                ) : current ? (
                  <>
                    <Typography sx={{ fontFamily: MONO, fontWeight: 700 }}>
                      {formatBenchmarkValue(key, current.value)}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: MONO,
                        color: pct === null ? 'text.disabled' : pct >= 0 ? 'success.main' : 'error.main',
                      }}
                    >
                      {pct === null ? '—' : formatPct(pct)}
                    </Typography>
                    <Sparkline values={series} positive={(pct ?? 0) >= 0} />
                  </>
                ) : (
                  <Typography variant="caption" color="text.disabled">
                    {t.portfolio.allocation.benchmark.itemUnavailable}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
