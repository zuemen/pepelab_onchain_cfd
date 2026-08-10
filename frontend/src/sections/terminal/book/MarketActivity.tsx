import type { ActivityRow } from 'src/hooks/useMarketActivity'

import Box from '@mui/material/Box'

import { fUsd, fNum, fromUnits } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'

const COLS = '.55fr .7fr 1fr .8fr 1fr'

const hhmm = (unix: bigint) => {
  const d = new Date(Number(unix) * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`
}

/**
 * 這個標的在鏈上的實際部位活動——**全平台的，不是只有你自己的**。
 *
 * 取代原本借用 Bybit 盤口的位置。本平台是 oracle 計價永續，沒有掛單簿；顯示別人
 * 交易所的掛單既不是我們的成交，也只有 sBTC / sETH 兩個標的對得上。這裡改成顯示
 * 真正發生過的事，而且 11 個標的一致。
 */
/**
 * 未實現損益：用當前價與進場價重算。
 *
 * 跟 TerminalView 算自己持倉的公式一致，刻意不共用抽象——那邊吃的是 LivePos，
 * 這邊吃的是鏈上原始 struct，硬套一個共同型別只會讓兩邊都變難讀。
 */
function unrealised(p: ActivityRow, cur: bigint): bigint {
  if (p.entryPrice <= 0n) return 0n
  const size = (p.margin * p.leverage * 10n ** 18n) / p.entryPrice
  const pnl = ((cur - p.entryPrice) * size) / 10n ** 18n
  return p.isLong ? pnl : -pnl
}

export function MarketActivity({
  rows,
  loading,
  error,
  truncated,
  missed,
  symbol,
  currentPrice,
}: {
  rows: ActivityRow[]
  loading: boolean
  error: string | null
  truncated: boolean
  /** 重試後仍讀不到的筆數。 */
  missed: number
  symbol?: string
  /**
   * 用來算未實現損益的當前價（18 dp）。拿不到就只顯示已實現的部分——寧可留白，
   * 也不要用過期的價格算出一個看起來很確定的數字。
   */
  currentPrice?: bigint
}) {
  if (error) {
    return <Msg color={C.red}>{error}</Msg>
  }
  if (!rows.length) {
    return <Msg>{loading ? '讀取鏈上部位…' : `${symbol ?? '此標的'} 目前無鏈上部位`}</Msg>
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: COLS,
          px: 1.2,
          pb: 0.6,
          ...labelCss,
          fontSize: 9.5,
        }}
      >
        <Box>Side</Box>
        <Box sx={{ textAlign: 'right' }}>Margin</Box>
        <Box sx={{ textAlign: 'right' }}>Entry</Box>
        <Box sx={{ textAlign: 'right' }}>Time</Box>
        <Box sx={{ textAlign: 'right' }}>PnL</Box>
      </Box>

      {rows.map((p) => {
        // 未平倉 → 用當前價即時算；已平倉 → 用鏈上寫死的已實現損益。
        const live = p.isOpen && currentPrice ? unrealised(p, currentPrice) : null
        const pnlRaw = p.isOpen ? live : p.realizedPnL
        const pnl = pnlRaw === null ? null : fromUnits(pnlRaw, 18)
        return (
          <Box
            key={String(p.id)}
            sx={{
              display: 'grid',
              gridTemplateColumns: COLS,
              px: 1.2,
              py: 0.35,
              ...monoCss,
              fontSize: 11.5,
              '&:hover': { bgcolor: 'rgba(255,255,255,.02)' },
            }}
          >
            <Box sx={{ color: p.isLong ? C.green : C.red, fontWeight: 700 }}>
              {p.isLong ? 'LONG' : 'SHORT'}
              <Box component="span" sx={{ color: C.mut, fontWeight: 400 }}>
                {' '}
                {String(p.leverage)}×
              </Box>
            </Box>
            <Box sx={{ textAlign: 'right', color: C.ink }}>
              {fNum(fromUnits(p.margin, 18), { dp: 0 })}
            </Box>
            <Box sx={{ textAlign: 'right', color: C.mut }}>
              {fUsd(fromUnits(p.entryPrice, 18))}
            </Box>
            <Box sx={{ textAlign: 'right', color: C.mut }}>{hhmm(p.openedAt)}</Box>
            {/* 未實現與已實現是不同的東西，一定要看得出差別：未平倉的用括號、
                較淡、後面掛一個 open 記號；已平倉的是粗體實數。只靠顏色不夠——
                兩者都會是紅或綠。 */}
            <Box
              sx={{
                textAlign: 'right',
                color: pnl === null ? C.mut : pnl >= 0 ? C.green : C.red,
                fontWeight: p.isOpen ? 400 : 700,
                opacity: p.isOpen ? 0.75 : 1,
              }}
            >
              {pnl === null ? '—' : `${p.isOpen ? '(' : ''}${fNum(pnl, { dp: 2, signed: true })}${p.isOpen ? ')' : ''}`}
              {p.isOpen && (
                <Box component="span" sx={{ color: C.mut, fontSize: 9, ml: 0.4 }}>
                  open
                </Box>
              )}
            </Box>
          </Box>
        )
      })}

      {truncated && (
        <Box sx={{ px: 1.2, pt: 0.8, ...monoCss, fontSize: 10, color: C.mut }}>
          只掃描最近的部位，更早的未列出
        </Box>
      )}
      {/* 讀不到的筆數要講出來。靜默跳過會讓不完整的列表看起來像完整的。 */}
      {missed > 0 && (
        <Box sx={{ px: 1.2, pt: 0.8, ...monoCss, fontSize: 10, color: C.lime }}>
          {missed} 筆因 RPC 限流未讀取，列表可能不完整
        </Box>
      )}
    </Box>
  )
}

function Msg({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <Box sx={{ p: 3, textAlign: 'center', color: color ?? C.mut, ...monoCss, fontSize: 12 }}>
      {children}
    </Box>
  )
}
