import type { ActivityRow } from 'src/hooks/useMarketActivity'

import Box from '@mui/material/Box'

import { t } from 'src/locales'

import { MarketActivity } from './MarketActivity'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

/**
 * 市場面板：這個標的在鏈上的實際部位活動（全平台的，不只自己的）。
 *
 * 這裡原本是 Bybit 的訂單簿與近期成交，已整個移除。理由不是版面，是它本來就
 * 不屬於這個產品：
 *   1. 本平台是 oracle 計價永續，**沒有掛單簿**——成交價由 oracle 決定，不是跟
 *      那些掛單撮合出來的。把別人交易所的掛單放在最顯眼的位置，等於在暗示一個
 *      不存在的撮合機制。
 *   2. Bybit 只有 sBTC / sETH 對得上，另外九個標的永遠是空的。
 *
 * 要找那份程式碼的話在 git 歷史裡（OrderBook.tsx / RecentTrades.tsx /
 * useBybitMarket.ts / bybitMarket.ts）。K 線圖仍然用 Bybit 的資料，但那是走後端
 * agent/signal-api 抓的，跟這裡移除的「瀏覽器直連盤口」無關。
 */
export function BookPanel({
  symbol,
  activity,
  currentPrice,
}: {
  /** 顯示用的標的代號，例如 sBTC。 */
  symbol?: string
  activity: {
    rows: ActivityRow[]
    loading: boolean
    error: string | null
    truncated: boolean
    missed: number
  }
  /** 算未實現損益用的當前價（18 dp）。 */
  currentPrice?: bigint
}) {
  return (
    <Box
      sx={{
        ...panel,
        // flex:1 + width:100% 缺一不可——外層容器是 display:flex，沒有它 flex item
        // 會縮成內容寬度，右邊留下一大片空白。
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
        <Box sx={{ ...labelCss, fontSize: 10, color: C.mut }}>{t.terminal.activity.title}</Box>
        <Box sx={{ ml: 'auto', ...monoCss, fontSize: 9.5, color: C.mut, whiteSpace: 'nowrap' }}>
          {t.terminal.activity.onChainBadge}
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
        <MarketActivity {...activity} symbol={symbol} currentPrice={currentPrice} />
      </Box>
    </Box>
  )
}
