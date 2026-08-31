import { Line, LineChart, ResponsiveContainer } from 'recharts';

import Box from '@mui/material/Box';

import { PEPE } from 'src/components/pepefi/brandKit';

const SPARKLINE_W = 72;
const SPARKLINE_H = 28;

/** 跟 PnL 數字用同一套三態色階:>0 綠、<0 紅、剛好 0 中性灰,不能只顧多數情況而漏了打平這個邊界。 */
const SPARKLINE_NEUTRAL = '#919EAB'; // 跟 MarketplacePage 的 MEDAL_ROW_TINT 銀牌灰同一個顏色

interface Props {
  /** 依平倉時序累加的損益,少於 2 筆平倉時是空陣列——呼叫端已經決定不畫線,這裡照做。 */
  curve: bigint[];
  /** 這一列的 7 日損益,只用來決定顏色——不是跟著曲線自己的起訖方向走,好跟旁邊的 PnL 數字同一套顏色語言。 */
  pnl: bigint;
}

/**
 * 排行榜表格「7 日走勢」欄的小折線——固定 72×28,無軸線無 tooltip。表格一次要
 * 渲染五十來條,任何一條額外的互動判定都是白白的效能負擔,`isAnimationActive={false}`
 * 同理。領獎台卡片不用這個(改用勝負方塊列),所以只有一種尺寸。
 */
export default function EquitySparkline({ curve, pnl }: Props) {
  if (curve.length === 0) return <>—</>;
  const data = curve.map((c, i) => ({ i, c: Number(c) / 1e18 }));
  const stroke = pnl > 0n ? PEPE.long : pnl < 0n ? PEPE.short : SPARKLINE_NEUTRAL;

  return (
    <Box sx={{ width: SPARKLINE_W, height: SPARKLINE_H }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="c"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
