import type { ESGInfo } from 'src/hooks/useESG';

import { useMemo } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';

import { t } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import ESGBadge from 'src/components/pepefi/ESGBadge';
import { esgContributionOf } from 'src/lib/pepefi/esgContribution';

// ----------------------------------------------------------------------
// 投資組合的價值加權 ESG 分數。只在專家模式出現，回答的是「為什麼數字會
// 變成這樣」，新手要的還是「我現在有多少、我下一步做什麼」——在看得懂之前，
// 這個分數只是雜訊。
//
// 配置佔比與分類損益曾經也在這裡，issue #66 移到 RwaAllocation：那個區塊
// 永遠可見（不像這裡 Expert-only 又要求非空持倉），繼續在這裡重複畫一次
// 同一批部位，就是這個頁面在合併 Dashboard 時已經刻意消除過的那種重複。
// 這裡剩下的是「你的持倉在 ESG 上表現如何、為什麼」，是分類配置以外的另一個
// 維度，不是同一個東西畫兩次。
//
// Dashboard 上還有一個四資產趨勢圖與一塊鯨魚動向，兩者都沒有跟過來：趨勢圖
// 畫的是市場價格（不是你的部位），鯨魚動向則是 /whale 整頁的縮小重複版。

export interface AnalysisRow {
  asset:         string;
  currentValue:  bigint;
  unrealizedPnL: bigint;
}

type Props = {
  rows: AnalysisRow[];
  esg: Record<string, ESGInfo>;
};

const barColor = (score: number) =>
  score >= 80 ? 'success.main' : score >= 60 ? 'info.main' : score >= 40 ? 'warning.main' : 'error.main';

export default function PortfolioAnalysis({ rows, esg }: Props) {
  // 價值加權，不是簡單平均：$10,000 的部位跟 $10 的部位對整體責任的影響
  // 顯然不一樣。任何一個標的缺 ESG 資料就整個不算——用一半的資料算出來的
  // 分數會比沒有分數更容易誤導。
  //
  // 環境／社會／治理三個子分數用同一套加權法，跟 composite 是同一組資料
  // （ESGRegistry 每個標的本來就回三個維度，composite 只是三者平均）——單獨
  // 顯示 composite 卻不顯示子分數，等於把已經有的資料丟掉不用。
  const portfolioESG = useMemo(() => {
    if (rows.length === 0) return null;
    let totalVal = 0;
    let weightedComposite = 0;
    let weightedE = 0;
    let weightedS = 0;
    let weightedG = 0;
    for (const row of rows) {
      const info = esg[row.asset];
      if (!info) return null;
      const val = Number(row.currentValue) / 1e18;
      totalVal += val;
      weightedComposite += info.composite * val;
      weightedE += info.environmental * val;
      weightedS += info.social * val;
      weightedG += info.governance * val;
    }
    if (totalVal === 0) return null;
    const composite = Math.round(weightedComposite / totalVal);
    const rating =
      composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' : composite >= 50 ? 'BBB' : 'CCC';
    return {
      composite,
      rating,
      environmental: Math.round(weightedE / totalVal),
      social: Math.round(weightedS / totalVal),
      governance: Math.round(weightedG / totalVal),
    };
  }, [rows, esg]);

  // 只在每個標的都有 ESG 資料時才算——跟 portfolioESG 用同一個判斷結果，
  // 不重新掃一次 rows 檢查缺不缺資料。
  const contributions = useMemo(
    () => (portfolioESG === null ? [] : esgContributionOf(rows, esg)),
    [rows, esg, portfolioESG],
  );

  if (rows.length === 0) return null;

  return (
    <Card sx={{ p: 3 }}>
      <Tooltip title={t.portfolio.analysis.esgMethodology}>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{
            fontWeight: 'bold',
            letterSpacing: 1,
            display: 'block',
            mb: 1.5,
            width: 'fit-content',
            cursor: 'help',
            textDecoration: 'underline dotted',
            textUnderlineOffset: 3,
          }}
        >
          {t.portfolio.analysis.esgScore}
        </Typography>
      </Tooltip>
      {portfolioESG === null ? (
        <Typography variant="body2" color="text.secondary">
          {/* 缺一個標的的資料就不給分。半套資料算出來的分數比沒有分數更誤導。 */}
          {t.portfolio.analysis.esgIncomplete}
        </Typography>
      ) : (
        <>
          <Typography sx={{ fontWeight: 800, fontFamily: MONO, fontSize: '1.5rem' }}>
            {portfolioESG.composite}{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              {portfolioESG.rating}
            </Typography>
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, mt: 2 }}>
            {(
              [
                ['environmental', t.esg.dimension.environmental, portfolioESG.environmental],
                ['social', t.esg.dimension.social, portfolioESG.social],
                ['governance', t.esg.dimension.governance, portfolioESG.governance],
              ] as const
            ).map(([key, label, score]) => (
              <Box key={key}>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700 }}>
                    {score}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={score}
                  sx={{
                    height: 6,
                    borderRadius: 1,
                    mt: 0.5,
                    bgcolor: 'action.hover',
                    '& .MuiLinearProgress-bar': { bgcolor: barColor(score), borderRadius: 1 },
                  }}
                />
              </Box>
            ))}
          </Box>

          {contributions.length > 0 && (
            <Box sx={{ mt: 2.5, pt: 2, borderTop: '1px dashed', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, display: 'block', mb: 1.5 }}>
                {t.portfolio.analysis.byAsset}
              </Typography>
              <Stack spacing={1.25}>
                {contributions.map((c) => (
                  <Stack key={c.asset} direction="row" alignItems="center" justifyContent="space-between">
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: '0.8125rem' }}>
                        {c.symbol}
                      </Typography>
                      <ESGBadge composite={c.composite} rating={c.rating} size="sm" />
                    </Stack>
                    <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>
                      {c.weightPct.toFixed(0)}%
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}
        </>
      )}
    </Card>
  );
}
