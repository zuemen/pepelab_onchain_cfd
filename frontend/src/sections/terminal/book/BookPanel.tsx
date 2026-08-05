import type { FundingInfo } from 'src/hooks/useFundingData'

import { useState } from 'react'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

import { useOrderBook, useRecentTrades } from 'src/hooks/useBybitMarket'

import { fNum, fBps, fromUnits } from 'src/lib/pepefi/format'
import { BYBIT_ATTRIBUTION } from 'src/lib/pepefi/bybitMarket'

import { OrderBook } from './OrderBook'
import { RecentTrades } from './RecentTrades'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

type Tab = 'book' | 'trades'

/**
 * 盤口面板：訂單簿 / 近期成交。
 *
 * 兩件事值得說清楚：
 *
 * 1. 資料是 Bybit 的公開盤口，**不是本平台的掛單**。本平台是 oracle 計價永續，
 *    沒有自己的訂單簿——成交價由 oracle 決定，不是跟這些掛單撮合出來的。所以這
 *    一區只能當參考，標示必須明講。
 *
 * 2. 非加密貨幣（股票 / ETF / 商品）在 Bybit 沒有對應合約，沒有盤口可顯示。那時
 *    改show 鏈上的 OI 與 funding——那才是這些標的真正有的市場資訊。
 */
export function BookPanel({
  bybitSymbol,
  funding,
  active,
}: {
  bybitSymbol?: string
  funding?: FundingInfo
  /** 面板是否可見。收在分頁裡沒展開時傳 false，輪詢就不會建立。 */
  active: boolean
}) {
  const [tab, setTab] = useState<Tab>('book')

  const book = useOrderBook(bybitSymbol, active && tab === 'book')
  const trades = useRecentTrades(bybitSymbol, active && tab === 'trades')

  return (
    <Box sx={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.2,
          pt: 1.2,
          pb: 1,
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        {(
          [
            ['book', 'Order book'],
            ['trades', 'Trades'],
          ] as const
        ).map(([id, text]) => {
          const on = tab === id
          return (
            <Box
              key={id}
              component="button"
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={on}
              sx={{
                ...labelCss,
                fontSize: 10,
                minHeight: 30,
                px: 1,
                borderRadius: '6px',
                cursor: 'pointer',
                bgcolor: 'transparent',
                border: `1px solid ${on ? C.line2 : 'transparent'}`,
                color: on ? C.lime : C.mut,
                '@media (pointer: coarse)': { minHeight: 44 },
                '&:hover': { color: on ? C.lime : C.ink },
              }}
            >
              {text}
            </Box>
          )
        })}

        {bybitSymbol && (
          <Tooltip title={BYBIT_ATTRIBUTION} arrow>
            <Box
              component="a"
              href={`https://www.bybit.com/trade/usdt/${bybitSymbol}`}
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                ml: 'auto',
                ...monoCss,
                fontSize: 9.5,
                color: C.mut,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                '&:hover': { color: C.ink },
              }}
            >
              ● Bybit
            </Box>
          </Tooltip>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
        {!bybitSymbol ? (
          <NoBook funding={funding} />
        ) : tab === 'book' ? (
          <OrderBook book={book.data} loading={book.loading} />
        ) : (
          <RecentTrades trades={trades.data} loading={trades.loading} />
        )}
      </Box>
    </Box>
  )
}

/** 沒有公開盤口的標的：改顯示鏈上真正有的市場資訊。 */
function NoBook({ funding }: { funding?: FundingInfo }) {
  const longOI = funding ? fromUnits(funding.longOI, 18) : null
  const shortOI = funding ? fromUnits(funding.shortOI, 18) : null
  const total = longOI !== null && shortOI !== null ? longOI + shortOI : 0
  const longPct = total > 0 ? ((longOI as number) / total) * 100 : 50

  return (
    <Box sx={{ px: 1.4, py: 1 }}>
      <Box sx={{ ...monoCss, fontSize: 11, color: C.mut, lineHeight: 1.6, mb: 1.5 }}>
        此標的無公開盤口可對照。本平台為 oracle 計價永續，成交價由 oracle 決定，
        不經掛單撮合——以下為鏈上實際的持倉分布。
      </Box>

      {funding ? (
        <>
          <Box sx={{ ...labelCss, fontSize: 9.5, mb: 0.6 }}>Open interest L/S</Box>
          <Box sx={{ display: 'flex', height: 8, borderRadius: '4px', overflow: 'hidden', mb: 0.8 }}>
            <Box sx={{ width: `${longPct}%`, bgcolor: C.green }} />
            <Box sx={{ width: `${100 - longPct}%`, bgcolor: C.red }} />
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', ...monoCss, fontSize: 11.5, mb: 1.5 }}>
            <Box sx={{ color: C.green }}>L {fNum(longOI as number, { dp: 2 })}</Box>
            <Box sx={{ color: C.red }}>{fNum(shortOI as number, { dp: 2 })} S</Box>
          </Box>

          <Box sx={{ ...labelCss, fontSize: 9.5, mb: 0.4 }}>Funding (8h)</Box>
          <Box
            sx={{
              ...monoCss,
              fontSize: 13,
              fontWeight: 700,
              color: Number(funding.rate) > 0 ? C.red : Number(funding.rate) < 0 ? C.green : C.mut,
            }}
          >
            {Number(funding.rate) >= 0 ? '+' : ''}
            {fBps(Number(funding.rate), 4)}
          </Box>
        </>
      ) : (
        <Box sx={{ ...monoCss, fontSize: 11.5, color: C.mut }}>
          此標的尚無鏈上 funding / OI 資料。
        </Box>
      )}
    </Box>
  )
}
