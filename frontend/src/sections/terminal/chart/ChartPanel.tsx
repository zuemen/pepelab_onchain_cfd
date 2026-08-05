import type { CandleFeed } from 'src/hooks/useCandles'
import type { Interval } from 'src/lib/pepefi/candles'

import { useMemo } from 'react'

import Box from '@mui/material/Box'

import { fUsd, fromUnits } from 'src/lib/pepefi/format'

import { ChartToolbar } from './ChartToolbar'
import { DataSourceBadge } from './DataSourceBadge'
import { CandleChart, type PriceLineSpec } from './CandleChart'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

/**
 * 圖表面板：工具列 + 蠟燭圖 + 出處標示。
 *
 * feed 由上層傳進來而不是自己抓：行情列的漲跌幅要用同一份資料，各抓一次會變成
 * 兩條輪詢、兩個數字，還可能不一致。
 */
export function ChartPanel({
  feed,
  interval,
  onIntervalChange,
  indexPrice,
  markPrice,
}: {
  feed: CandleFeed
  interval: Interval
  onIntervalChange: (i: Interval) => void
  indexPrice: bigint
  markPrice: bigint
}) {
  // oracle index 是實際結算價，跟圖上的交易所行情本來就會有落差——把它畫出來，
  // 讓「為什麼成交價跟圖不一樣」變成看得見的事實而不是客訴。
  const priceLines: PriceLineSpec[] = useMemo(() => {
    const lines: PriceLineSpec[] = []
    const idx = fromUnits(indexPrice, 18)
    const mark = fromUnits(markPrice, 18)
    if (idx > 0) lines.push({ price: idx, color: C.lime, title: 'index' })
    if (mark > 0 && mark !== idx) lines.push({ price: mark, color: C.mut, title: 'mark' })
    return lines
  }, [indexPrice, markPrice])

  return (
    <Box sx={{ ...panel, p: 2, minHeight: 420, display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          mb: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <ChartToolbar interval={interval} onChange={onIntervalChange} />

        {/* 這是圖表來源的最後收盤價，跟上方行情列的顯示價（CoinGecko）是不同來源，
            兩者有小幅價差是正常的——所以標清楚它屬於這張圖。 */}
        {feed.last !== undefined && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.7 }}>
            <Box sx={{ ...labelCss, fontSize: 9.5 }}>chart last</Box>
            <Box sx={{ ...monoCss, fontSize: 15, fontWeight: 700, color: C.ink }}>
              {fUsd(feed.last)}
            </Box>
          </Box>
        )}

        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
          {feed.underlying && (
            <Box sx={{ ...labelCss, fontSize: 10 }}>{feed.underlying}</Box>
          )}
          <DataSourceBadge
            source={feed.source}
            degraded={feed.degraded}
            sourceError={feed.sourceError}
            disclaimer="圖表為外部公開來源的參考行情，非本平台成交紀錄；開倉 / 平倉 / 清算一律以鏈上 oracle index 價結算。"
          />
        </Box>
      </Box>

      {feed.error ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 320,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            color: C.red,
            ...monoCss,
            fontSize: 12.5,
            px: 2,
          }}
        >
          <Box>
            <Box sx={{ mb: 0.8 }}>無法載入 K 線</Box>
            <Box sx={{ color: C.mut, fontSize: 11.5 }}>{feed.error}</Box>
          </Box>
        </Box>
      ) : feed.loading && !feed.candles.length ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 320,
            display: 'grid',
            placeItems: 'center',
            color: C.mut,
            ...monoCss,
            fontSize: 13,
          }}
        >
          載入 K 線…
        </Box>
      ) : (
        <CandleChart candles={feed.candles} priceLines={priceLines} />
      )}
    </Box>
  )
}
