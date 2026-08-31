import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';

import { t, interpolate } from 'src/locales';
import { ASSET_LABEL } from 'src/lib/pepefi/assetMeta';
import AssetIcon from 'src/components/pepefi/AssetIcon';
import type { RawAlloc } from 'src/lib/pepefi/leaderboardMetrics';

/** 單一配置籌碼的標籤文字:↑sBTC 50% 3×。表格 chip 與領獎台卡片共用同一個格式。 */
export const allocLabel = (a: RawAlloc): string =>
  interpolate(t.marketplace.card.allocChip, {
    side: a.isLong ? '↑' : '↓',
    asset: ASSET_LABEL[a.asset] ?? '?',
    weight: (Number(a.weight) / 100).toFixed(0),
    leverage: String(a.leverage),
  });

interface Props {
  /** registry.getLatestStrategy() 解析出來的配置。空陣列時的顯示由 hasStrategy 決定。 */
  allocs: RawAlloc[];
  /** allocs 為空時:true → 曾發布策略但目前無部位(罕見);false → 從未發布,顯示「尚無策略」。 */
  hasStrategy: boolean;
  /** 資產圖示直徑,預設 22(表格用);領獎台卡片給大一點。 */
  size?: number;
}

/**
 * 一排疊在一起的圓形資產圖示,做多綠邊、做空紅邊,細節在 hover 的 tooltip 裡
 * ——參考 Hyperdash 排行榜的持倉欄位。文字 chip 再怎麼縮都比一排疊起來的頭像
 * 佔空間,籌碼數一多還得省略。表格「策略」欄與領獎台卡片共用。
 */
export default function AllocationRow({ allocs, hasStrategy, size = 22 }: Props) {
  if (!hasStrategy || allocs.length === 0) {
    return (
      <Chip
        label={t.marketplace.card.noStrategy}
        size="small"
        variant="outlined"
        sx={{ color: 'text.secondary', borderColor: 'divider', alignSelf: 'flex-start' }}
      />
    );
  }

  return (
    // isolation:isolate 開一個新的 stacking context——不然這排圖示疊放用的 zIndex
    // 沒有邊界,滾動時會蓋到表格 sticky header 上面。
    <Box sx={{ display: 'flex', alignItems: 'center', isolation: 'isolate' }}>
      {allocs.map((a, i) => (
        <Tooltip key={i} title={allocLabel(a)}>
          <Box
            sx={{
              ml: i === 0 ? 0 : -1,
              zIndex: allocs.length - i,
              position: 'relative',
              lineHeight: 0,
              borderRadius: '50%',
              border: '2px solid',
              borderColor: a.isLong ? 'success.main' : 'error.main',
            }}
          >
            <AssetIcon symbol={ASSET_LABEL[a.asset] ?? '?'} size={size} />
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}
