import type { Theme } from '@mui/material/styles';

// 個人頁三張圖（淨值、逐月報酬、跟隨人數）共用的 recharts Tooltip 樣式。
// recharts 預設是白底、文字沿用主題色：深色主題下日期標籤是白字白底，看起來只剩一塊空白。

export const tooltipProps = (theme: Theme) => ({
  contentStyle: {
    backgroundColor: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 8,
    boxShadow: theme.shadows[8],
    padding: '6px 10px',
  },
  labelStyle: { color: theme.palette.text.secondary, marginBottom: 2, fontSize: 12 },
  itemStyle: { color: theme.palette.text.primary, padding: 0, fontSize: 13, fontWeight: 600 },
});

/** 長條圖滑過時的背景；預設是淺灰色整塊，深色主題下很刺眼。 */
export const barCursor = (theme: Theme) => ({ fill: theme.palette.action.hover });

/** 折線圖滑過時的垂直線。 */
export const lineCursor = (theme: Theme) => ({ stroke: theme.palette.divider, strokeWidth: 1 });
