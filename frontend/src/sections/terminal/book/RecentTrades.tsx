import type { PublicTrade } from 'src/lib/pepefi/bybitMarket'

import Box from '@mui/material/Box'

import { fNum, fAuto } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour12: false })

export function RecentTrades({ trades, loading }: { trades: PublicTrade[]; loading: boolean }) {
  if (!trades.length) {
    return (
      <Box sx={{ p: 3, textAlign: 'center', color: C.mut, ...monoCss, fontSize: 12 }}>
        {loading ? '載入成交…' : '無成交資料'}
      </Box>
    )
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          px: 1,
          pb: 0.6,
          ...labelCss,
          fontSize: 9.5,
        }}
      >
        <Box>Price</Box>
        <Box sx={{ textAlign: 'right' }}>Size</Box>
        <Box sx={{ textAlign: 'right' }}>Time</Box>
      </Box>

      {trades.slice(0, 22).map((t) => (
        <Box
          key={t.id}
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            px: 1,
            py: 0.28,
            ...monoCss,
            fontSize: 11.5,
          }}
        >
          {/* Buy = 主動買進吃掉賣單，用綠色，跟交易所慣例一致。 */}
          <Box sx={{ color: t.side === 'Buy' ? C.green : C.red }}>{fAuto(t.price)}</Box>
          <Box sx={{ textAlign: 'right', color: C.ink }}>{fNum(t.size, { dp: 3 })}</Box>
          <Box sx={{ textAlign: 'right', color: C.mut }}>{hhmmss(t.time)}</Box>
        </Box>
      ))}
    </Box>
  )
}
