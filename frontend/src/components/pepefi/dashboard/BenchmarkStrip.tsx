import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { useBenchmarks } from 'src/hooks/useBenchmarks';
import { MONO } from 'src/components/pepefi/brandKit';
import Skeleton from 'src/components/pepefi/Skeleton';
import { BENCHMARK_KEYS, pctChangeOf, formatBenchmarkValue, formatPct } from 'src/lib/pepefi/benchmarks';

// ----------------------------------------------------------------------
// 對照指數列（Benchmark，見 frontend/CONTEXT.md）：S&P 500／黃金／比特幣的
// 當前水準與當日漲跌。刻意不吃任何跟持倉相關的 props——自己打 signal-api，
// 零持倉、甚至從未開過倉的使用者也照常看到即時數字（issue #65）。
//
// 三個指數同一來源（見 lib/pepefi/benchmarks.ts），漲跌一律是「現價 vs 昨天
// 或之前最近一個交易日的收盤」，不是「今天開盤 vs 現在」——這個 app 沒有
// 「今天開盤價」這個資料，硬湊一個出來就是假數字。

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
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>
          {BENCHMARK_KEYS.map((key) => {
            const item = benchmarks?.[key];
            const name = t.portfolio.allocation.benchmark.names[key];
            const current = item?.current;
            const pct = pctChangeOf(current, item?.atDate);

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
