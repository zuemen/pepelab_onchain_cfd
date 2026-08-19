import type { FundingData } from 'src/hooks/useFundingData'

import Box from '@mui/material/Box'

import { t, interpolate } from 'src/locales'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { fBps, fNum, fromUnits } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'

const COLS = '1fr 1fr 1fr 1fr 1.2fr'

const ago = (unix: bigint) => {
  if (unix === 0n) return t.terminal.funding.agoNever
  const secs = Math.floor(Date.now() / 1000) - Number(unix)
  if (secs < 60) return interpolate(t.terminal.funding.agoSeconds, { n: secs })
  if (secs < 3600) return interpolate(t.terminal.funding.agoMinutes, { n: Math.floor(secs / 60) })
  return interpolate(t.terminal.funding.agoHours, { n: Math.floor(secs / 3600) })
}

export function FundingTable({ funding }: { funding: FundingData }) {
  const rows = Object.entries(funding)

  if (!rows.length) {
    return (
      <Box sx={{ p: 4, textAlign: 'center', color: C.mut, ...monoCss, fontSize: 13 }}>
        {t.terminal.funding.empty}
      </Box>
    )
  }

  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box sx={{ minWidth: 620 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: COLS,
            px: 2,
            py: 1,
            ...labelCss,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          {[
            t.terminal.funding.column.asset,
            t.terminal.funding.column.rate,
            t.terminal.funding.column.longOi,
            t.terminal.funding.column.shortOi,
            t.terminal.funding.column.lastSettled,
          ].map((h) => (
            <Box key={h}>{h}</Box>
          ))}
        </Box>

        {rows.map(([id, f]) => {
          const rate = Number(f.rate)
          return (
            <Box
              key={id}
              sx={{
                display: 'grid',
                gridTemplateColumns: COLS,
                px: 2,
                py: 1.1,
                alignItems: 'center',
                borderBottom: `1px solid ${C.line}`,
                ...monoCss,
                fontSize: 12.5,
              }}
            >
              <Box sx={{ fontWeight: 700 }}>{ASSET_META[id]?.symbol ?? f.label}</Box>
              {/* 正值 = 多方付錢給空方，對持多單的人是成本，所以標紅。 */}
              <Box sx={{ color: rate > 0 ? C.red : rate < 0 ? C.green : C.mut }}>
                {rate >= 0 ? '+' : ''}
                {fBps(rate, 4)}
              </Box>
              <Box sx={{ color: C.green }}>{fNum(fromUnits(f.longOI, 18), { dp: 2 })}</Box>
              <Box sx={{ color: C.red }}>{fNum(fromUnits(f.shortOI, 18), { dp: 2 })}</Box>
              <Box sx={{ color: C.mut }}>
                {ago(f.lastSettled)}
                {f.canSettle && (
                  <Box component="span" sx={{ color: C.lime, ml: 0.8 }}>
                    {t.terminal.funding.canSettle}
                  </Box>
                )}
              </Box>
            </Box>
          )
        })}

        <Box sx={{ px: 2, py: 1.2, ...monoCss, fontSize: 10.5, color: C.mut, lineHeight: 1.5 }}>
          {t.terminal.funding.note}
        </Box>
      </Box>
    </Box>
  )
}
