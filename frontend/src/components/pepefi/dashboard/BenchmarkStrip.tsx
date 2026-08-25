import { Line, XAxis, YAxis, Tooltip, LineChart, CartesianGrid, ResponsiveContainer } from 'recharts';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
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
  formatAxisPrice,
  formatAxisDate,
  priceDomainOf,
  type BenchmarkKey,
  type SeriesPoint,
} from 'src/lib/pepefi/benchmarks';

// ----------------------------------------------------------------------
// 對照指數列（Benchmark，見 frontend/CONTEXT.md）：四個指數的當前水準、當日
// 漲跌與近一個月走勢。四個標的一對一對應上面配置環的四個 Asset Class，所以
// 每一類都有一個外部對照，不是隨便挑幾個有名的指數。左到右的順序由
// lib/pepefi/benchmarks 的 BENCHMARK_KEYS 決定，這個檔案不自己排序。
//
// 刻意不吃任何跟持倉相關的 props——自己打 signal-api，零持倉、甚至從未開過倉
// 的使用者也照常看到即時數字（issue #65）。
//
// 當日漲跌的基準是後端給的 previousClose（相對最新那根的前一根收盤），不是
// 「昨天」這個日曆日。用日曆日的舊版本有一個結構性的錯：美股收盤後，最新的
// 日線就是「昨天」那根，於是 current 與「不晚於昨天的收盤」會解析到同一根
// K 棒，標普永遠顯示 +0.00%——線上實測就是這樣。
//
// 走勢圖用 recharts 而不是手刻 SVG：有了縱橫軸與刻度標籤之後，recharts 提供
// 的正是這些（軸、刻度、tooltip 的命中判定），手刻等於重寫一遍。純函式的部分
// （刻度格式、縱軸範圍）仍留在 lib 裡被測試釘住。

const CHART_H = 128;

function BenchmarkChart({ series, positive }: { series: SeriesPoint[]; positive: boolean }) {
  if (series.length === 0) return null;

  const color = positive ? 'var(--palette-success-main)' : 'var(--palette-error-main)';
  const domain = priceDomainOf(series.map((p) => p.c));

  return (
    <Box sx={{ width: '100%', height: CHART_H, mt: 1 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="t"
            // type="number" 是必要的：預設的類別軸會把每個交易日畫成等距，
            // 週末與假日的空檔就消失了。但刻意**不加** scale="time"——那會走
            // d3 的 scaleTime，而它假設數值是毫秒，我們的 t 是 unix 秒，刻度
            // 會被算在 1970 年的尺度上。線性軸對時間戳同樣是等比例的，間距
            // 一樣正確，日期則由 tickFormatter 正確還原。
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatAxisDate}
            tickCount={3}
            stroke="#454F5B"
            tick={{ fill: '#637381', fontSize: 10 }}
            tickLine={false}
          />
          <YAxis
            domain={domain}
            tickFormatter={formatAxisPrice}
            tickCount={3}
            stroke="#454F5B"
            tick={{ fill: '#637381', fontSize: 10 }}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#161c24',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              fontSize: 11,
            }}
            itemStyle={{ color: '#fff' }}
            labelStyle={{ color: '#919eab' }}
            labelFormatter={(v) => formatAxisDate(Number(v))}
            formatter={(v) => [
              Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }),
              t.portfolio.allocation.benchmark.chartPrice,
            ]}
          />
          <Line type="monotone" dataKey="c" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}

export default function BenchmarkStrip() {
  const { benchmarks, loading, error } = useBenchmarks();

  return (
    <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '1px dashed', borderColor: 'divider' }}>
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
          {t.portfolio.allocation.benchmark.heading}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {t.portfolio.allocation.benchmark.chartRange}
        </Typography>
      </Stack>

      {error ? (
        <Typography variant="body2" color="text.secondary">
          {error}
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
            gap: 3,
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
                    <Stack direction="row" alignItems="baseline" spacing={0.75}>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: MONO,
                          color: pct === null ? 'text.disabled' : pct >= 0 ? 'success.main' : 'error.main',
                        }}
                      >
                        {pct === null ? '—' : formatPct(pct)}
                      </Typography>
                      <Typography variant="caption" color="text.disabled">
                        {t.portfolio.allocation.benchmark.dayChange}
                      </Typography>
                    </Stack>
                    <BenchmarkChart series={series} positive={(pct ?? 0) >= 0} />
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
