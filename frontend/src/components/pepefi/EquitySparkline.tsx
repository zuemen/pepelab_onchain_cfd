import { Line, LineChart, ResponsiveContainer } from 'recharts';

import Box from '@mui/material/Box';

import { PEPE } from 'src/components/pepefi/brandKit';

const SPARKLINE_W = 72;
const SPARKLINE_H = 28;
const PODIUM_CHART_H = 40;

/** 跟 PnL 數字用同一套三態色階:>0 綠、<0 紅、剛好 0 中性灰,不能只顧多數情況而漏了打平這個邊界。 */
const SPARKLINE_NEUTRAL = '#919EAB'; // 跟 MarketplacePage 的 MEDAL_ROW_TINT 銀牌灰同一個顏色

interface Props {
  /** 依平倉時序累加的損益,少於 2 筆平倉時是空陣列——呼叫端已經決定不畫線,這裡照做。 */
  curve: bigint[];
  /** 這一列的 7 日損益,只用來決定顏色——不是跟著曲線自己的起訖方向走,好跟旁邊的 PnL 數字同一套顏色語言。 */
  pnl: bigint;
  /** 'sm'(預設)= 表格用的固定尺寸小折線;'lg' = 領獎台卡片用的全寬折線,略高一點但仍是配角,不是佔半張卡的大面積圖。 */
  variant?: 'sm' | 'lg';
}

/**
 * 7 天權益曲線,無軸線無 tooltip——排行榜表格與領獎台都要同時渲染最多五十來條,
 * 任何一條額外的互動判定都是白白的效能負擔,`isAnimationActive={false}` 同理。
 * 兩種尺寸都是折線(不是填色區域圖):領獎台卡片的視覺主體是策略配置與關鍵數字,
 * 曲線只是「這 7 天大致往哪走」的一眼掃描,不該搶版面。
 */
export default function EquitySparkline({ curve, pnl, variant = 'sm' }: Props) {
  if (curve.length === 0) return <>—</>;
  const data = curve.map((c, i) => ({ i, c: Number(c) / 1e18 }));
  const stroke = pnl > 0n ? PEPE.long : pnl < 0n ? PEPE.short : SPARKLINE_NEUTRAL;

  const isLg = variant === 'lg';
  const width = isLg ? '100%' : SPARKLINE_W;
  const height = isLg ? PODIUM_CHART_H : SPARKLINE_H;

  return (
    <Box sx={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="c"
            stroke={stroke}
            strokeWidth={isLg ? 2 : 1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
