import type { ActivityRow } from 'src/hooks/useMarketActivity'

import { useState } from 'react'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

import { useOrderBook, useRecentTrades } from 'src/hooks/useBybitMarket'

import { BYBIT_ATTRIBUTION } from 'src/lib/pepefi/bybitMarket'

import { OrderBook } from './OrderBook'
import { RecentTrades } from './RecentTrades'
import { MarketActivity } from './MarketActivity'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

type Tab = 'activity' | 'book' | 'trades'

/**
 * 市場面板。
 *
 * 主分頁是 **Activity：這個標的在鏈上的真實部位活動**（全平台的，不只自己的）。
 *
 * 這裡原本是 Bybit 的訂單簿。換掉的理由不是美觀：
 *   1. 本平台是 oracle 計價永續，**沒有掛單簿**——成交價由 oracle 決定，不是跟
 *      那些掛單撮合出來的。拿別人的盤口當主角，等於把不相干的東西放在最顯眼的
 *      位置。
 *   2. Bybit 只有 sBTC / sETH 對得上，另外九個標的永遠是空的。而鏈上的部位資料
 *      11 個標的都有。
 *
 * Bybit 沒有整個拿掉——對加密貨幣它仍是有意義的外部參考，所以降級成次要分頁，
 * 並在標題列標明來源。非加密貨幣則根本不顯示那兩個分頁，而不是留著空殼。
 */
export function BookPanel({
  bybitSymbol,
  symbol,
  activity,
  active,
  split = false,
}: {
  bybitSymbol?: string
  /** 顯示用的標的代號，例如 sBTC。 */
  symbol?: string
  activity: {
    rows: ActivityRow[]
    loading: boolean
    error: string | null
    truncated: boolean
    missed: number
  }
  /** 面板是否可見。收在分頁裡沒展開時傳 false，輪詢就不會建立。 */
  active: boolean
  /**
   * 併排模式：左邊活動、右邊盤口。
   *
   * 給「面板在圖表下方、寬度很寬」的情況用——單欄內容撐不滿那個寬度，右邊會空
   * 出一大片看起來像版面壞掉。沒有 Bybit 對照的標的維持單欄，因為右邊沒東西放。
   */
  split?: boolean
}) {
  const [tab, setTab] = useState<Tab>('activity')

  const hasRef = !!bybitSymbol
  // split 時右欄固定顯示訂單簿，所以那時候 book 一定要有資料。
  const book = useOrderBook(bybitSymbol, active && hasRef && (split || tab === 'book'))
  const trades = useRecentTrades(bybitSymbol, active && hasRef && !split && tab === 'trades')

  const tabs: [Tab, string][] = hasRef
    ? split
      ? [['activity', 'Activity']]
      : [
          ['activity', 'Activity'],
          ['book', 'Order book'],
          ['trades', 'Trades'],
        ]
    : [['activity', 'Activity']]

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
        {tabs.length === 1 ? (
          <Box sx={{ ...labelCss, fontSize: 10, color: C.mut }}>
            {split ? 'On-chain activity · Order book' : 'On-chain activity'}
          </Box>
        ) : (
          tabs.map(([id, text]) => {
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

        {/* 出處只在真的顯示 Bybit 資料時才標，免得在純鏈上分頁誤導成資料來自 Bybit。 */}
        {hasRef && (split || tab !== 'activity') && (
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
              ● Bybit 參考
            </Box>
          </Tooltip>
        )}
        {tab === 'activity' && !split && (
          <Box sx={{ ml: 'auto', ...monoCss, fontSize: 9.5, color: C.mut, whiteSpace: 'nowrap' }}>
            ● 鏈上
          </Box>
        )}
      </Box>

      {split && hasRef ? (
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
            <MarketActivity {...activity} symbol={symbol} />
          </Box>
          <Box sx={{ minHeight: 0, overflowY: 'auto', py: 1 }}>
            <OrderBook book={book.data} loading={book.loading} />
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
          {tab === 'activity' && <MarketActivity {...activity} symbol={symbol} />}
          {tab === 'book' && <OrderBook book={book.data} loading={book.loading} />}
          {tab === 'trades' && <RecentTrades trades={trades.data} loading={trades.loading} />}
        </Box>
      )}
    </Box>
  )
}
