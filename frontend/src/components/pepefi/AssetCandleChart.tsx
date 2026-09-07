// issue #135：詳情層裡每一檔資產自己的走勢，資料來自平台自己的 K 線服務。
//
// 重用 useCandles（抓資料、輪詢、往回翻頁）與 CandleChart（畫圖，含 resize
// 與增量更新）——這兩個是 Terminal 頁已經在用、正確處理過一堆細節的元件，
// 這裡不重新做一次。不重用的是 Terminal 自己的深色主題與 interval 工具列：
// 這一頁的定位是「投資的時間尺度，不是交易的」，沒有切換 1m/5m/15m 的需要，
// 固定用日線，讓 300 根蠟燭涵蓋將近一年、接近「成立以來」。

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

import { t } from 'src/locales'
import { useCandles } from 'src/hooks/useCandles'
import { CandleChart } from 'src/sections/terminal/chart/CandleChart'
import type { Interval } from 'src/lib/pepefi/candles'

/** 投資的時間尺度而不是交易的——日線, 不開放切換。 */
const SINCE_INCEPTION_INTERVAL: Interval = '1d'

export function AssetCandleChart({ symbol, height = 260 }: { symbol: string; height?: number }) {
  const feed = useCandles(symbol, SINCE_INCEPTION_INTERVAL)

  // #135 驗收條件：K 線服務取不到資料時，這裡壞掉，不能連累旁邊的身世卡與
  // 買進表單——所以錯誤處理整個包在這個獨立小元件裡，不往外拋。
  if (feed.error) {
    return (
      <Box sx={{ height, display: 'grid', placeItems: 'center', textAlign: 'center', px: 2 }}>
        <Box>
          <Typography variant="body2" color="text.secondary">{t.terminal.chart.error}</Typography>
          <Typography variant="caption" color="text.disabled">{feed.error}</Typography>
        </Box>
      </Box>
    )
  }

  if (feed.loading && !feed.candles.length) {
    return (
      <Box sx={{ height, display: 'grid', placeItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">{t.terminal.chart.loading}</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ height, display: 'flex', flexDirection: 'column' }}>
      <CandleChart candles={feed.candles} height={height} onNeedOlder={feed.loadOlder} />
    </Box>
  )
}
