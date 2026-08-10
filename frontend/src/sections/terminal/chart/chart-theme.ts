import type { Time, DeepPartial, ChartOptions } from 'lightweight-charts'

import { ColorType, LineStyle, TickMarkType, CrosshairMode } from 'lightweight-charts'

import { C } from '../terminal-theme'

// ── 時間顯示：一律本地時區 ───────────────────────────────────────────────────
//
// lightweight-charts 把餵進去的 UTCTimestamp 當 UTC 畫，所以時間軸預設是 UTC。
// 但同一頁的「近期成交」用 toLocaleTimeString（本地時區），兩者並排時在 UTC+8
// 差 8 小時——看起來像圖表延遲了 8 小時，實際上只是兩種時區並存。
//
// 統一成本地時間，因為這個產品的使用者是散戶而非跨時區交易台，而且成交列表已經
// 是本地時間，改一邊比改兩邊小。
//
// 刻意**不用「把時間戳加上 UTC 位移」**那種常見做法：那會讓 series 裡存的
// time 變成假的 UTC 值，之後任何拿 time 做計算的地方（例如 isCandleOpen 判斷
// 當前這根收盤了沒）都會跟著錯掉。這裡只改「怎麼顯示」，資料本身仍是正確的 UTC。

const pad = (n: number) => String(n).padStart(2, '0')

/** Time 理論上可能是 BusinessDay 或字串；我們只餵 UTCTimestamp，其餘防禦性處理。 */
function toDate(time: Time): Date | null {
  if (typeof time === 'number') return new Date(time * 1000)
  if (typeof time === 'string') return new Date(time)
  if (time && typeof time === 'object' && 'year' in time) {
    return new Date(time.year, time.month - 1, time.day)
  }
  return null
}

/**
 * 時間軸刻度。
 *
 * tickMarkType 由圖表依縮放程度決定要顯示到哪個層級，每一級都要處理，否則縮放
 * 時會出現空白刻度。
 *
 * 已知取捨：日線的桶是以 UTC 零點對齊的，換算成本地日期後，在 UTC 以西的時區
 * （例如美洲）可能顯示成前一天。對 UTC+8 不會發生。真的要同時服務兩邊，得讓
 * 日線以上維持 UTC、盤中用本地——但那是同一張圖裡兩種時區，比現在更難解釋。
 */
function localTickMark(time: Time, tickMarkType: TickMarkType, locale: string): string {
  const d = toDate(time)
  if (!d) return ''
  switch (tickMarkType) {
    case TickMarkType.Year:
      return String(d.getFullYear())
    case TickMarkType.Month:
      return d.toLocaleDateString(locale, { month: 'short' })
    case TickMarkType.DayOfMonth:
      return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    case TickMarkType.Time:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    case TickMarkType.TimeWithSeconds:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    default:
      return ''
  }
}

/** 十字準線上的時間標籤。這裡帶日期，因為游標可能停在很久以前的蠟燭上。 */
function localCrosshairTime(time: Time): string {
  const d = toDate(time)
  if (!d) return ''
  return (
    `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

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
    tickMarkFormatter: localTickMark,
  },
  localization: {
    // 十字準線的時間標籤走另一個鉤子，跟 tickMarkFormatter 是分開的——只設一個
    // 會變成「軸是本地時間、游標提示還是 UTC」，比原本更難看懂。
    timeFormatter: localCrosshairTime,
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
