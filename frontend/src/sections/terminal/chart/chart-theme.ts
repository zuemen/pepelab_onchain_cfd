import type { DeepPartial, ChartOptions } from 'lightweight-charts'

import { ColorType, LineStyle, CrosshairMode } from 'lightweight-charts'

import { C } from '../terminal-theme'

/** 終端機調色盤 → lightweight-charts 設定。集中在這裡，元件只負責生命週期。 */
export const chartOptions: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: C.mut,
    fontFamily: C.mono,
    fontSize: 11,
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: C.line },
    horzLines: { color: C.line },
  },
  crosshair: {
    // Normal 才有交易所那種「十字線可自由移動」的手感；Magnet 會黏在收盤價上。
    mode: CrosshairMode.Normal,
    vertLine: { color: C.mut, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.panel2 },
    horzLine: { color: C.mut, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.panel2 },
  },
  rightPriceScale: {
    borderColor: C.line,
    // 下方留白給成交量副圖疊上去。
    scaleMargins: { top: 0.08, bottom: 0.26 },
  },
  timeScale: {
    borderColor: C.line,
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 3,
  },
  handleScroll: true,
  handleScale: true,
}

export const candleSeriesOptions = {
  upColor: C.green,
  downColor: C.red,
  borderUpColor: C.green,
  borderDownColor: C.red,
  wickUpColor: C.green,
  wickDownColor: C.red,
  priceLineColor: C.lime,
}

/** 成交量用半透明，讓它退到蠟燭後面而不是搶戲。 */
export const VOLUME_UP = 'rgba(63,217,138,.32)'
export const VOLUME_DOWN = 'rgba(255,93,93,.32)'
