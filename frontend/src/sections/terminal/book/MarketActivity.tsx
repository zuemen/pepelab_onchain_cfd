import type { ActivityRow } from 'src/hooks/useMarketActivity'

import Box from '@mui/material/Box'

import { t, interpolate } from 'src/locales'
import { positionPnl } from 'src/lib/pepefi/positionPnl'
import { fUsd, fNum, fromUnits } from 'src/lib/pepefi/format'
import { pnlStatusText } from 'src/lib/pepefi/positionFreshness'

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
 * 未實現損益：合約 getPositionValue − 保證金，跟下方持倉表、投資組合頁同一個定義
 * （lib/pepefi/positionPnl.ts）。以前用鏈下參考價自己重算，同一個部位在這裡、在持倉表、
 * 在投資組合會是三個數字。讀不到、價格為 0 或過期就是 null（顯示「—」＋原因），不補 0，
 * 也不讓 oracle 價格為 0 時把所有人的部位畫成「保證金全虧」。
 */
export function unrealised(p: ActivityRow, nowSec = p.nowSec ?? Math.floor(Date.now() / 1000)) {
  return positionPnl({
    margin: p.margin,
    positionValue: p.positionValue ?? null,
    oracle: p.oracle ?? null,
    nowSec,
    maxPriceAgeSec: p.maxPriceAgeSec,
  })
}

export function MarketActivity({
  rows,
  loading,
  error,
  truncated,
  missed,
  symbol,
}: {
  rows: ActivityRow[]
  loading: boolean
  error: string | null
  truncated: boolean
  /** 重試後仍讀不到的筆數。 */
  missed: number
  symbol?: string
}) {
  if (error) {
    return <Msg color={C.red}>{error}</Msg>
  }
  if (!rows.length) {
    return (
      <Msg>
        {loading
          ? t.terminal.activity.loading
          : interpolate(t.terminal.activity.emptyForAsset, {
              asset: symbol ?? t.terminal.activity.thisAsset,
            })}
      </Msg>
    )
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
        <Box>{t.terminal.activity.column.side}</Box>
        <Box sx={{ textAlign: 'right' }}>{t.terminal.activity.column.margin}</Box>
        <Box sx={{ textAlign: 'right' }}>{t.terminal.activity.column.entry}</Box>
        <Box sx={{ textAlign: 'right' }}>{t.terminal.activity.column.time}</Box>
        <Box sx={{ textAlign: 'right' }}>{t.terminal.activity.column.pnl}</Box>
      </Box>

      {rows.map((p) => {
        // 未平倉 → 合約的平倉淨額 − 保證金；已平倉 → 鏈上寫死的已實現損益。
        const live = p.isOpen ? unrealised(p) : null
        const pnlRaw = p.isOpen ? (live?.pnl ?? null) : p.realizedPnL
        const why = live ? pnlStatusText(live.status) : null
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
              {p.isLong ? t.terminal.activity.long : t.terminal.activity.short}
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
              title={pnl === null ? why?.hint : undefined}
              sx={{
                textAlign: 'right',
                color: pnl === null ? C.mut : pnl >= 0 ? C.green : C.red,
                fontWeight: p.isOpen ? 400 : 700,
                opacity: p.isOpen ? 0.75 : 1,
              }}
            >
              {pnl === null ? `— ${why?.label ?? ''}` : `${p.isOpen ? '(' : ''}${fNum(pnl, { dp: 2, signed: true })}${p.isOpen ? ')' : ''}`}
              {p.isOpen && (
                <Box component="span" sx={{ color: C.mut, fontSize: 9, ml: 0.4 }}>
                  {t.terminal.activity.openMarker}
                </Box>
              )}
            </Box>
          </Box>
        )
      })}

      {truncated && (
        <Box sx={{ px: 1.2, pt: 0.8, ...monoCss, fontSize: 10, color: C.mut }}>
          {t.terminal.activity.truncated}
        </Box>
      )}
      {/* 讀不到的筆數要講出來。靜默跳過會讓不完整的列表看起來像完整的。 */}
      {missed > 0 && (
        <Box sx={{ px: 1.2, pt: 0.8, ...monoCss, fontSize: 10, color: C.lime }}>
          {interpolate(t.terminal.activity.missed, { count: missed })}
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
