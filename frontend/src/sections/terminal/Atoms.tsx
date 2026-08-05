import Box from '@mui/material/Box'

import { C } from './terminal-theme'

// 兩個到處都在用的展示原子。原本住在 TradeTerminalPage 底部，拆檔後行情列、
// 下單面板、帳戶面板都要用，所以獨立出來。

/** 行情列的單一統計格：小標題 + 等寬數值。 */
export function Stat({ label, v, color }: { label: string; v: string; color?: string }) {
  return (
    <Box>
      <Box
        sx={{
          color: C.mut,
          fontSize: 11,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          fontWeight: 700,
        }}
      >
        {label}
      </Box>
      <Box sx={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: color ?? C.ink, mt: 0.3 }}>
        {v}
      </Box>
    </Box>
  )
}

/** 左標籤右數值的一行。 */
export function Row({
  k,
  v,
  color,
  strong,
}: {
  k: string
  v: string
  color?: string
  strong?: boolean
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Box sx={{ color: C.mut, fontSize: 12.5 }}>{k}</Box>
      <Box
        sx={{
          fontFamily: C.mono,
          fontSize: strong ? 15 : 13,
          fontWeight: strong ? 800 : 600,
          color: color ?? C.ink,
        }}
      >
        {v}
      </Box>
    </Box>
  )
}
