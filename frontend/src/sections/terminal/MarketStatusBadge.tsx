import type { MarketTone, MarketStatus } from 'src/lib/pepefi/marketStatus'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

import { t } from 'src/locales'

import { C, monoCss } from './terminal-theme'

const TONE_COLOR: Record<MarketTone, { fg: string; bg: string; border: string }> = {
  ok: { fg: C.green, bg: C.greenDim, border: 'rgba(63,217,138,.35)' },
  warn: { fg: '#f5b545', bg: 'rgba(245,181,69,.12)', border: 'rgba(245,181,69,.4)' },
  danger: { fg: C.red, bg: C.redDim, border: 'rgba(255,93,93,.4)' },
  muted: { fg: C.mut, bg: 'transparent', border: C.line },
}

/**
 * 市場狀態徽章（lib/pepefi/marketStatus.ts）。
 *   variant="full"  — 資產標頭：完整句子（休市而且不會停單時，那句話要完整說出來）。
 *   variant="short" — 市場列表：短標籤；24/7 與開盤不顯示，避免列表滿是綠點。
 */
export function MarketStatusBadge({
  status,
  variant = 'full',
}: {
  status: MarketStatus
  variant?: 'full' | 'short'
}) {
  if (variant === 'short' && (status.kind === 'always' || status.kind === 'open')) return null
  const c = TONE_COLOR[status.tone]
  const pill = (
    <Box
      component="span"
      data-testid={variant === 'full' ? 'market-status' : undefined}
      data-market-status={status.kind}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.6,
        px: variant === 'full' ? 1 : 0.6,
        py: variant === 'full' ? 0.35 : 0.1,
        borderRadius: '6px',
        border: `1px solid ${c.border}`,
        bgcolor: c.bg,
        color: c.fg,
        ...monoCss,
        fontSize: variant === 'full' ? 11.5 : 10,
        fontWeight: 700,
        lineHeight: 1.35,
        whiteSpace: variant === 'full' ? 'normal' : 'nowrap',
        cursor: variant === 'full' ? 'help' : undefined,
      }}
    >
      <Box component="span" aria-hidden sx={{ fontSize: 8 }}>
        ●
      </Box>
      {variant === 'full' ? status.label : status.short}
    </Box>
  )
  if (variant === 'short') return pill
  return (
    <Tooltip
      title={<Box sx={{ whiteSpace: 'pre-line', fontSize: 12 }}>{t.status.market.hint}</Box>}
      arrow
      enterTouchDelay={0}
    >
      {pill}
    </Tooltip>
  )
}
