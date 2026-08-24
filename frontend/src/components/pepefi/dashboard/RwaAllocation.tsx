import { useMemo } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import { ASSET_CLASSES, ASSET_CLASS_CONFIG, groupMarginByAssetClass, type MarginRow } from 'src/lib/pepefi/assetClass';

// ----------------------------------------------------------------------
// RWA 是本平台的核心賣點（frontend/CONTEXT.md 的 RWA 詞條）：股債金幣四大類
// 都能在同一個投資組合裡持有。這個區塊把它放上第一屏，緊接在淨值 hero 之後
// ——Simple／Expert 兩種模式都看得到，零持倉也照樣顯示（四類皆 $0／0%），
// 不像 PortfolioAnalysis 那樣整塊消失。兩者回答的問題不一樣：PortfolioAnalysis
// 是「為什麼數字會變成這樣」（診斷用、Expert-only、沒有部位就沒有意義）；這裡
// 是「這個平台能讓你配置什麼」（賣點、永遠成立，$0 也是一種誠實的答案）。
//
// 分母是保證金，不是淨值：這個環回答「我的交易部位怎麼配置」，不是「我全部
// 的錢怎麼配置」——錢包現金、質押、LP 金庫都不屬於任何一個資產類別，刻意不
// 算進來。標題下面的 subtitle 把這件事講清楚，不然容易被誤讀成 Net Worth
// 的配置（兩個分母不同，湊巧顯示在同一個數字旁邊會被當成同一件事）。

type Props = {
  rows: MarginRow[];
};

const fUsd = (v: bigint) =>
  `$${(Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fSignedUsd = (v: bigint) => (v >= 0n ? '+' : '') + fUsd(v);

export default function RwaAllocation({ rows }: Props) {
  const byClass = useMemo(() => groupMarginByAssetClass(rows), [rows]);

  const totalMargin = useMemo(() => rows.reduce((s, r) => s + r.margin, 0n), [rows]);

  return (
    <Card sx={{ p: { xs: 2.5, sm: 3.5 }, border: '1px solid', borderColor: 'divider' }}>
      <Typography
        variant="overline"
        sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block' }}
      >
        {t.portfolio.allocation.title}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2.5 }}>
        {t.portfolio.allocation.subtitle}
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
          gap: { xs: 2, sm: 3 },
        }}
      >
        {ASSET_CLASSES.map((cls) => {
          const cfg = ASSET_CLASS_CONFIG[cls];
          const summary = byClass[cls];
          // totalMargin === 0n → 0%，不是 NaN／Infinity：零持倉時四類都要看得懂,
          // 不是顯示一個算式壞掉的痕跡。
          const pct = totalMargin > 0n ? (Number(summary.margin) / Number(totalMargin)) * 100 : 0;

          return (
            <Box key={cls}>
              <Typography variant="caption" sx={{ color: cfg.color, fontWeight: 700, display: 'block', mb: 0.5 }}>
                {cfg.icon} {cfg.label}
              </Typography>
              <Typography sx={{ fontWeight: 800, fontFamily: MONO, fontSize: '1.4rem', lineHeight: 1.1 }}>
                {pct.toFixed(0)}%
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block' }}>
                {fUsd(summary.margin)}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  fontFamily: MONO,
                  fontWeight: 700,
                  color: summary.pnl === 0n ? 'text.disabled' : summary.pnl > 0n ? 'success.main' : 'error.main',
                }}
              >
                {summary.pnl === 0n ? '—' : fSignedUsd(summary.pnl)}
              </Typography>
            </Box>
          );
        })}
      </Box>

      {totalMargin === 0n && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2.5 }}>
          {t.portfolio.allocation.noPositions}
        </Typography>
      )}
    </Card>
  );
}
