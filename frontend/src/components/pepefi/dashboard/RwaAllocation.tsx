import { useMemo } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';

import { t } from 'src/locales';
import { SHOW_PERPETUALS } from 'src/lib/pepefi/featureFlags';
import { MONO } from 'src/components/pepefi/brandKit';
import {
  ASSET_CLASSES,
  ASSET_CLASS_CONFIG,
  groupByAssetClass,
  type HoldingRow,
} from 'src/lib/pepefi/assetClass';

import BenchmarkStrip from './BenchmarkStrip';
import AnchoredComparison, { type ComparisonRow } from './AnchoredComparison';

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
  rows: ComparisonRow[];
  /**
   * 使用者持有的代幣化資產。平台改以現貨為門面之後，一般使用者的資產在這裡，
   * 不在 `rows`（永續部位的保證金）——只算 rows 的話，買了 sGOLD 與 sBOND、
   * 一張永續都沒開的人會看到四類皆 0%，正好是這個區塊要證明的事情的反面。
   */
  holdings?: HoldingRow[];
};

const fUsd = (v: bigint) =>
  `$${(Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fSignedUsd = (v: bigint) => (v >= 0n ? '+' : '') + fUsd(v);

export default function RwaAllocation({ rows, holdings = [] }: Props) {
  const byClass = useMemo(() => groupByAssetClass(rows, holdings), [rows, holdings]);

  // 分母是四類的合計，不是 rows 的保證金合計——加進持倉之後兩者不再相等，
  // 用舊的分母會讓百分比加起來超過 100%。
  const total = useMemo(
    () => ASSET_CLASSES.reduce((sum, cls) => sum + byClass[cls].value, 0n),
    [byClass],
  );

  return (
    <Card sx={{ p: { xs: 2.5, sm: 3.5 }, border: '1px solid', borderColor: 'divider' }}>
      <Typography
        variant="overline"
        sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block' }}
      >
        {t.portfolio.allocation.title}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2.5 }}>
        {SHOW_PERPETUALS ? t.portfolio.allocation.subtitle : t.portfolio.allocation.subtitleSpot}
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
          // total === 0n → 0%，不是 NaN／Infinity：零持倉時四類都要看得懂,
          // 不是顯示一個算式壞掉的痕跡。
          const pct = total > 0n ? (Number(summary.value) / Number(total)) * 100 : 0;

          return (
            <Box key={cls}>
              <Typography variant="caption" sx={{ color: cfg.color, fontWeight: 700, display: 'block', mb: 0.5 }}>
                {cfg.icon} {cfg.label}
              </Typography>
              <Typography sx={{ fontWeight: 800, fontFamily: MONO, fontSize: '1.4rem', lineHeight: 1.1 }}>
                {pct.toFixed(0)}%
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block' }}>
                {fUsd(summary.value)}
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

      {total === 0n && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2.5 }}>
          {t.portfolio.allocation.noPositions}
        </Typography>
      )}

      {/* 只有現貨持倉、一張部位都沒有時，四個「損益」都會是「—」。不解釋的話
          那看起來像壞掉，而它其實是「現貨沒有鏈上成本基礎可算」的正確結果。 */}
      {total > 0n && rows.length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2.5 }}>
          {t.portfolio.allocation.holdingsOnlyNote}
        </Typography>
      )}

      <BenchmarkStrip />
      <AnchoredComparison rows={rows} />
    </Card>
  );
}
