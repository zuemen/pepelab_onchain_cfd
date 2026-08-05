import type { SourceInfo } from 'src/lib/pepefi/candles'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

import { C, monoCss } from '../terminal-theme'

/**
 * 出處標示。
 *
 * 這不是裝飾。圖表畫的是外部交易所的行情、不是本平台的成交，使用者有權知道
 * 每一條線是誰給的；模擬資料更必須一眼看得出來。後端每筆回應都帶 source
 * metadata 就是為了讓這件事不可能被漏掉。
 */
export function DataSourceBadge({
  source,
  degraded,
  sourceError,
  disclaimer,
}: {
  source: SourceInfo | null
  degraded?: boolean
  sourceError?: string
  disclaimer?: string
}) {
  if (!source) return null

  const simulated = source.kind === 'simulated'
  const color = simulated ? C.red : degraded ? C.lime : C.mut

  const tip = [
    source.attribution,
    disclaimer,
    degraded && sourceError ? `已退用備援來源：${sourceError}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  const label = (
    <Box
      sx={{
        ...monoCss,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.6,
        fontSize: 10.5,
        color,
        border: `1px solid ${simulated ? C.redDim : C.line}`,
        borderRadius: '6px',
        px: 0.9,
        py: 0.35,
        whiteSpace: 'nowrap',
      }}
    >
      {simulated ? '⚠' : '●'} {simulated ? 'SIMULATED' : `data · ${source.name}`}
      {degraded && !simulated ? ' (備援)' : ''}
    </Box>
  )

  return (
    <Tooltip title={<Box sx={{ whiteSpace: 'pre-line', fontSize: 11.5 }}>{tip}</Box>} arrow>
      {source.url ? (
        <Box
          component="a"
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ textDecoration: 'none', '&:hover': { filter: 'brightness(1.3)' } }}
        >
          {label}
        </Box>
      ) : (
        label
      )}
    </Tooltip>
  )
}
