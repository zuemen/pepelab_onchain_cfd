import type { Interval } from 'src/lib/pepefi/candles'

import Box from '@mui/material/Box'

import { INTERVALS } from 'src/lib/pepefi/candles'

import { C, monoCss } from '../terminal-theme'

/** 時間框切換。 */
export function ChartToolbar({
  interval,
  onChange,
}: {
  interval: Interval
  onChange: (i: Interval) => void
}) {
  return (
    <Box sx={{ display: 'flex', gap: 0.4 }}>
      {INTERVALS.map((iv) => {
        const on = iv === interval
        return (
          <Box
            key={iv}
            component="button"
            type="button"
            onClick={() => onChange(iv)}
            aria-pressed={on}
            sx={{
              ...monoCss,
              // 44px 觸控目標：02ff7cd 已經處理過這件事，新元件不要再走回頭路。
              minWidth: 38,
              minHeight: 32,
              px: 1,
              borderRadius: '7px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
              bgcolor: on ? C.lime : 'transparent',
              color: on ? '#0a0d07' : C.mut,
              border: `1px solid ${on ? C.lime : C.line}`,
              transition: '.15s',
              '@media (pointer: coarse)': { minHeight: 44, minWidth: 44 },
              '&:hover': { color: on ? '#0a0d07' : C.ink, borderColor: on ? C.lime : C.line2 },
            }}
          >
            {iv}
          </Box>
        )
      })}
    </Box>
  )
}
