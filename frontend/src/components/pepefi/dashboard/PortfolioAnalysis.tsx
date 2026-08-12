import type { ESGInfo } from 'src/hooks/useESG';

import { useMemo } from 'react';
import { Pie, Cell, Legend, PieChart, Tooltip, ResponsiveContainer } from 'recharts';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { MONO } from 'src/components/pepefi/brandKit';
import { ASSET_META } from 'src/lib/pepefi/assetMeta';

// ----------------------------------------------------------------------
// 「為什麼會長成這樣」——配置佔比、分類損益、ESG 加權分數。
//
// 從 Dashboard 併過來的。這三塊講的都是**你的持倉**的組成，所以跟著持倉走；
// 留在一個唯讀的首頁上，等於要使用者在兩頁之間對照同一批部位。
//
// 只在專家模式出現：它們回答的是「為什麼數字會變成這樣」，而新手要的還是
// 「我現在有多少、我下一步做什麼」。在看得懂之前，這些圖只是雜訊。
//
// Dashboard 上還有一個四資產趨勢圖與一塊鯨魚動向。兩者都沒有跟過來：趨勢圖
// 畫的是市場價格（不是你的部位），鯨魚動向則是 /whale 整頁的縮小重複版。

type DisplayCat = 'crypto' | 'equity' | 'commodity' | 'bond';

const DISPLAY_CATS: DisplayCat[] = ['crypto', 'equity', 'commodity', 'bond'];

const CAT_CONFIG: Record<DisplayCat, { label: string; icon: string; color: string }> = {
  crypto:    { label: 'Crypto',          icon: '₿', color: '#6366f1' },
  equity:    { label: 'Equity',          icon: '◈', color: '#a855f7' },
  commodity: { label: 'Commodity & ETF', icon: '◆', color: '#f59e0b' },
  bond:      { label: 'Bond',            icon: '◉', color: '#10b981' },
};

const displayCatOf = (assetId: string): DisplayCat => {
  const cat = ASSET_META[assetId]?.category;
  if (cat === 'equity') return 'equity';
  if (cat === 'bond') return 'bond';
  if (cat === 'commodity' || cat === 'etf') return 'commodity';
  return 'crypto';
};

const fUsd = (v: bigint) =>
  `$${(Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fPnL = (v: bigint) => (v >= 0n ? '+' : '') + (Number(v) / 1e18).toFixed(2);

const pnlColor = (v: bigint) => (v >= 0n ? 'success.main' : 'error.main');

/** 這個元件需要的最小持倉形狀。 */
export interface AnalysisRow {
  asset:         string;
  currentValue:  bigint;
  unrealizedPnL: bigint;
}

type Props = {
  rows: AnalysisRow[];
  esg: Record<string, ESGInfo>;
};

export default function PortfolioAnalysis({ rows, esg }: Props) {
  const byCat = useMemo(() => {
    const out: Record<DisplayCat, { value: bigint; pnl: bigint; symbols: string[] }> = {
      crypto:    { value: 0n, pnl: 0n, symbols: [] },
      equity:    { value: 0n, pnl: 0n, symbols: [] },
      commodity: { value: 0n, pnl: 0n, symbols: [] },
      bond:      { value: 0n, pnl: 0n, symbols: [] },
    };
    for (const row of rows) {
      const cat = displayCatOf(row.asset);
      out[cat].value += row.currentValue;
      out[cat].pnl += row.unrealizedPnL;
      const sym = ASSET_META[row.asset]?.symbol ?? '?';
      if (!out[cat].symbols.includes(sym)) out[cat].symbols.push(sym);
    }
    return out;
  }, [rows]);

  const pieData = useMemo(
    () =>
      DISPLAY_CATS.filter((c) => byCat[c].value > 0n).map((c) => ({
        name: CAT_CONFIG[c].label,
        value: Number(byCat[c].value) / 1e18,
        color: CAT_CONFIG[c].color,
      })),
    [byCat]
  );

  // 價值加權，不是簡單平均：$10,000 的部位跟 $10 的部位對整體責任的影響
  // 顯然不一樣。任何一個標的缺 ESG 資料就整個不算——用一半的資料算出來的
  // 分數會比沒有分數更容易誤導。
  const portfolioESG = useMemo(() => {
    if (rows.length === 0) return null;
    let totalVal = 0;
    let weighted = 0;
    for (const row of rows) {
      const info = esg[row.asset];
      if (!info) return null;
      const val = Number(row.currentValue) / 1e18;
      totalVal += val;
      weighted += info.composite * val;
    }
    if (totalVal === 0) return null;
    const composite = Math.round(weighted / totalVal);
    const rating =
      composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' : composite >= 50 ? 'BBB' : 'CCC';
    return { composite, rating };
  }, [rows, esg]);

  if (rows.length === 0) return null;

  return (
    <Grid container spacing={3}>
      {/* Allocation */}
      <Grid size={{ xs: 12, md: 5 }}>
        <Card sx={{ p: 3, height: '100%', minHeight: 300 }}>
          <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1, display: 'block', mb: 2 }}>
            Allocation
          </Typography>
          {pieData.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No positions to break down.</Typography>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={45}>
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v) => `$${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                  contentStyle={{ background: '#0e1420', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </Grid>

      {/* Category PnL + ESG */}
      <Grid size={{ xs: 12, md: 7 }}>
        <Card sx={{ p: 3, height: '100%', display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', letterSpacing: 1 }}>
            By asset class
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2 }}>
            {DISPLAY_CATS.map((cat) => {
              const summary = byCat[cat];
              const config = CAT_CONFIG[cat];
              return (
                <Box
                  key={cat}
                  sx={{ p: 1.5, borderRadius: 1.5, border: '1px solid', borderColor: 'divider' }}
                >
                  <Typography variant="caption" sx={{ color: config.color, fontWeight: 700, display: 'block' }}>
                    {config.icon} {config.label}
                  </Typography>
                  {summary.value === 0n ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      No positions
                    </Typography>
                  ) : (
                    <>
                      <Typography sx={{ fontWeight: 700, fontFamily: MONO, mt: 0.5 }}>
                        {fUsd(summary.value)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: pnlColor(summary.pnl), fontFamily: MONO, fontWeight: 700 }}>
                        {fPnL(summary.pnl)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {summary.symbols.join(' · ')}
                      </Typography>
                    </>
                  )}
                </Box>
              );
            })}
          </Box>

          <Box sx={{ mt: 'auto', pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block' }}>
              ESG score (value-weighted)
            </Typography>
            {portfolioESG === null ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {/* 缺一個標的的資料就不給分。半套資料算出來的分數比沒有分數更誤導。 */}
                Not all holdings have ESG data yet.
              </Typography>
            ) : (
              <Typography sx={{ fontWeight: 800, fontFamily: MONO, fontSize: '1.25rem', mt: 0.25 }}>
                {portfolioESG.composite}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  {portfolioESG.rating}
                </Typography>
              </Typography>
            )}
          </Box>
        </Card>
      </Grid>
    </Grid>
  );
}
