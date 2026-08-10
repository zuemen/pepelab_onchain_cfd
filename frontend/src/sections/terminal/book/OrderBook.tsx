import type { BookLevel, OrderBookSnapshot } from 'src/lib/pepefi/bybitMarket'

import Box from '@mui/material/Box'

import { fNum, fAuto } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'

const ROWS = 10

/** 一側的掛單列。深度用背景條表示，由最佳價往外累加。 */
function Side({ levels, side, maxTotal }: { levels: BookLevel[]; side: 'bid' | 'ask'; maxTotal: number }) {
  const color = side === 'bid' ? C.green : C.red
  const tint = side === 'bid' ? 'rgba(63,217,138,.12)' : 'rgba(255,93,93,.12)'
  // 賣方由外往內排（最佳價貼近中間價），跟交易所的視覺慣例一致。
  const rows = side === 'ask' ? [...levels].slice(0, ROWS).reverse() : levels.slice(0, ROWS)

  return (
    <Box>
      {rows.map((l) => (
        <Box
          key={`${side}-${l.price}`}
          sx={{
            position: 'relative',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            px: 1,
            py: 0.28,
            ...monoCss,
            fontSize: 11.5,
          }}
        >
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              width: `${maxTotal > 0 ? (l.total / maxTotal) * 100 : 0}%`,
              bgcolor: tint,
              // 深度條從價格那一側長出來，跟交易所一致。
              ...(side === 'bid' ? { right: 0, left: 'auto' } : { left: 0 }),
            }}
          />
          <Box sx={{ position: 'relative', color }}>{fAuto(l.price)}</Box>
          <Box sx={{ position: 'relative', textAlign: 'right', color: C.ink }}>
            {fNum(l.size, { dp: 3 })}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export function OrderBook({ book, loading }: { book: OrderBookSnapshot; loading: boolean }) {
  const maxTotal = Math.max(
    book.bids[ROWS - 1]?.total ?? book.bids[book.bids.length - 1]?.total ?? 0,
    book.asks[ROWS - 1]?.total ?? book.asks[book.asks.length - 1]?.total ?? 0,
  )

  if (!book.bids.length && !book.asks.length) {
    return (
      <Box sx={{ p: 3, textAlign: 'center', color: C.mut, ...monoCss, fontSize: 12 }}>
        {loading ? '載入盤口…' : '無盤口資料'}
      </Box>
    )
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          px: 1,
          pb: 0.6,
          ...labelCss,
          fontSize: 9.5,
        }}
      >
        <Box>Price</Box>
        <Box sx={{ textAlign: 'right' }}>Size</Box>
      </Box>

      <Side levels={book.asks} side="ask" maxTotal={maxTotal} />

      {/* 中間價與價差 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          px: 1,
          py: 0.7,
          my: 0.3,
          borderTop: `1px solid ${C.line}`,
          borderBottom: `1px solid ${C.line}`,
          ...monoCss,
        }}
      >
        <Box sx={{ fontSize: 13, fontWeight: 700, color: C.ink }}>
          {book.mid !== undefined ? fAuto(book.mid) : '—'}
        </Box>
        <Box sx={{ fontSize: 10.5, color: C.mut }}>
          {book.spread !== undefined && book.spreadPct !== undefined
            ? `spread ${fAuto(book.spread)} · ${fNum(book.spreadPct, { dp: 3 })}%`
            : ''}
        </Box>
      </Box>

      <Side levels={book.bids} side="bid" maxTotal={maxTotal} />
    </Box>
  )
}
