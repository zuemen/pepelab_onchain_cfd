// 終端機專用調色盤與樣式原子。
//
// 這一頁刻意不吃 MUI theme：它是強制深色的交易介面，跟站上其他頁的亮/暗色切換
// 無關，走 theme 反而要跟 palette 打架。集中在這裡是為了讓拆出去的十來個元件
// 共用同一組值，而不是每個檔案各自抄一份色碼。

/** 終端機調色盤（forced dark，Hyperliquid 風格 + Pepe 綠）。 */
export const C = {
  bg: '#080b09',
  panel: '#0d1210',
  panel2: '#10160f',
  line: 'rgba(255,255,255,.07)',
  line2: 'rgba(199,249,78,.16)',
  ink: '#e9f0e4',
  mut: '#7e8c7b',
  green: '#3fd98a',
  greenDim: 'rgba(63,217,138,.14)',
  red: '#ff5d5d',
  redDim: 'rgba(255,93,93,.14)',
  lime: '#c7f94e',
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', monospace",
} as const

/** 面板外框。 */
export const panel = {
  bgcolor: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: '12px',
} as const

/** 小標籤：大寫、寬字距、次要色。 */
export const labelCss = {
  color: C.mut,
  fontSize: 11,
  letterSpacing: '.06em',
  textTransform: 'uppercase' as const,
  fontWeight: 700,
} as const

/** 等寬字。數字欄位一律套這個——等寬本身就是 tabular，價格跳動不會推擠版面。 */
export const monoCss = { fontFamily: C.mono } as const
