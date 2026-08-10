import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

import { C } from './terminal-theme'

// 兩個到處都在用的展示原子。原本住在 TradeTerminalPage 底部，拆檔後行情列、
// 下單面板、帳戶面板都要用，所以獨立出來。

/**
 * 行情列的單一統計格：小標題 + 等寬數值。
 *
 * 給了 hint 就掛上滑鼠提示，標題也會加一條虛線底線暗示「這裡有東西可以看」——
 * 沒有那個視覺線索，沒有人會知道要把游標移上去。Funding、Open interest、
 * Vault backing 這些名詞對非交易員完全不透明，值得解釋。
 */
export function Stat({
  label,
  v,
  color,
  hint,
}: {
  label: string
  v: string
  color?: string
  hint?: string
}) {
  const body = (
    <Box sx={{ cursor: hint ? 'help' : undefined }}>
      <Box
        sx={{
          color: C.mut,
          fontSize: 11,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          fontWeight: 700,
          ...(hint
            ? {
                textDecoration: 'underline dotted',
                textUnderlineOffset: '3px',
                textDecorationColor: 'rgba(255,255,255,.25)',
              }
            : {}),
        }}
      >
        {label}
      </Box>
      <Box sx={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: color ?? C.ink, mt: 0.3 }}>
        {v}
      </Box>
    </Box>
  )

  if (!hint) return body
  return (
    <Tooltip
      arrow
      placement="bottom-start"
      title={<Box sx={{ fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{hint}</Box>}
      slotProps={{ tooltip: { sx: { maxWidth: 300 } } }}
    >
      {body}
    </Tooltip>
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
