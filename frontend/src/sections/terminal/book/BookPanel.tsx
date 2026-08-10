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
  split = false,
}: {
  bybitSymbol?: string
  funding?: FundingInfo
  /** 面板是否可見。收在分頁裡沒展開時傳 false，輪詢就不會建立。 */
  active: boolean
  /**
   * 併排模式：訂單簿與近期成交左右並列，取代分頁。
   *
   * 給「面板在圖表下方、寬度很寬」的情況用。那個位置只放一個兩欄數字的訂單簿，
   * 右邊會空出一大片，看起來像版面壞掉；併排才用得掉那個寬度。
   */
  split?: boolean
}) {
  const [tab, setTab] = useState<Tab>('book')

  // 併排時兩邊都要資料；分頁模式只有當前那頁要。
  const book = useOrderBook(bybitSymbol, active && (split || tab === 'book'))
  const trades = useRecentTrades(bybitSymbol, active && (split || tab === 'trades'))

  return (
    <Box
      sx={{
        ...panel,
        // flex:1 + width:100% 缺一不可——這個元件的外層容器是 display:flex，
        // 沒有它 flex item 會縮成內容寬度，右邊留下一大片空白。
        flex: 1,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
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
        {split ? (
          // 併排模式沒有分頁可切，標題就直接寫兩邊是什麼。
          <Box sx={{ ...labelCss, fontSize: 10, color: C.mut }}>
            Order book · Trades
          </Box>
        ) : (
          (
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
          })
        )}

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

      {!bybitSymbol ? (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
          <NoBook funding={funding} />
        </Box>
      ) : split ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            // minmax(0, 1fr) 同樣的理由：內容不該把欄位撐開。
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          }}
        >
          <Box sx={{ minHeight: 0, overflowY: 'auto', py: 1, borderRight: `1px solid ${C.line}` }}>
            <OrderBook book={book.data} loading={book.loading} />
          </Box>
          <Box sx={{ minHeight: 0, overflowY: 'auto', py: 1 }}>
            <RecentTrades trades={trades.data} loading={trades.loading} />
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
          {tab === 'book' ? (
            <OrderBook book={book.data} loading={book.loading} />
          ) : (
            <RecentTrades trades={trades.data} loading={trades.loading} />
          )}
        </Box>
      )}
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
