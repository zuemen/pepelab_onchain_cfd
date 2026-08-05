import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  UTCTimestamp,
  HistogramData,
  CandlestickData,
} from 'lightweight-charts'
import type { Candle } from 'src/lib/pepefi/candles'

import { memo, useRef, useEffect } from 'react'
import { LineStyle, createChart, HistogramSeries, CandlestickSeries } from 'lightweight-charts'

import Box from '@mui/material/Box'

import { C } from '../terminal-theme'
import { VOLUME_UP, VOLUME_DOWN, chartOptions, candleSeriesOptions } from './chart-theme'

export interface PriceLineSpec {
  price: number
  color: string
  title: string
}

/**
 * 蠟燭圖 + 成交量副圖。
 *
 * 這個元件刻意是 imperative 的，而且用 memo 包起來。
 *
 * lightweight-charts 自己管 canvas，React 只負責掛載與拆除。把價格當 props 一路
 * 傳下來、靠重繪更新，會讓每 8 秒一次的報價 tick 重建整張圖——在這一頁那是很有感
 * 的卡頓。所以資料進來時走 series.setData()/update()，圖表本身不重建。
 *
 * 另外一個必須自己處理的點：**lightweight-charts 不會自動 resize**。recharts 的
 * ResponsiveContainer 有做，這個沒有。容器變窄時（例如 MetaMask 開在 Chrome 側邊欄
 * 把頁面壓窄）canvas 會維持舊寬度直接溢出面板，看起來就像版面爆掉。下面的
 * ResizeObserver 就是在補這件事。
 */
function CandleChartImpl({
  candles,
  priceLines = [],
  height = 380,
}: {
  candles: Candle[]
  priceLines?: PriceLineSpec[]
  height?: number
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const linesRef = useRef<IPriceLine[]>([])
  // 已經餵過資料才做 fitContent，否則每次輪詢都把使用者的縮放/平移重設掉。
  const fittedRef = useRef(false)

  // ── 建立圖表（只在掛載時做一次）──
  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined

    const chart = createChart(el, {
      ...chartOptions,
      width: el.clientWidth,
      height: el.clientHeight || height,
    })
    chartRef.current = chart

    candleRef.current = chart.addSeries(CandlestickSeries, candleSeriesOptions)

    // 成交量疊在同一個 pane，但用自己的價格軸並壓到底部 —— 這樣它不會影響
    // 蠟燭的價格刻度。
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    volumeRef.current = volume

    // resize：用 rAF 節流，拖曳側邊欄時每幀重繪會頓。
    let raf = 0
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        chart.applyOptions({ width: Math.floor(rect.width), height: Math.floor(rect.height) })
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      linesRef.current = []
      fittedRef.current = false
    }
    // height 只在建立時當初值用，之後尺寸由 ResizeObserver 接手。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 餵資料 ──
  useEffect(() => {
    const cs = candleRef.current
    const vs = volumeRef.current
    if (!cs || !vs) return

    if (!candles.length) {
      cs.setData([])
      vs.setData([])
      fittedRef.current = false
      return
    }

    const bars: CandlestickData[] = candles.map((k) => ({
      time: k.t as UTCTimestamp,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
    }))
    const vols: HistogramData[] = candles.map((k) => ({
      time: k.t as UTCTimestamp,
      value: k.v,
      color: k.c >= k.o ? VOLUME_UP : VOLUME_DOWN,
    }))

    cs.setData(bars)
    vs.setData(vols)

    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent()
      fittedRef.current = true
    }
  }, [candles])

  // ── 疊線：oracle index / mark / 持倉進場價與清算價 ──
  useEffect(() => {
    const cs = candleRef.current
    if (!cs) return

    for (const line of linesRef.current) cs.removePriceLine(line)
    linesRef.current = priceLines
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        cs.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.title,
        }),
      )
  }, [priceLines])

  return (
    <Box
      ref={boxRef}
      sx={{
        flex: 1,
        // minHeight 0 讓它在 flex 容器裡真的能被壓縮；沒有的話 canvas 會把面板撐開。
        minHeight: 0,
        width: '100%',
        '& .tv-lightweight-charts': { borderRadius: '8px' },
      }}
      style={{ background: C.panel }}
    />
  )
}

export const CandleChart = memo(CandleChartImpl)
