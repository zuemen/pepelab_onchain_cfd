// 「你 vs 大盤」（issue #67）的純函式部分：Anchor Date 與去槓桿報酬率。
// 抽出來是為了能在不渲染 React 的情況下鎖住這兩個算法——這個 repo 的
// vitest 跑在 node 環境，沒有 DOM。

/** 這兩個純函式各自需要的最小部位形狀——刻意比元件的 ComparisonRow 窄。 */
export interface NotionalRow {
  margin:        bigint
  leverage:      bigint
  unrealizedPnL: bigint
}

export interface OpenedAtRow {
  /** unix 秒，這筆部位的開倉時間（合約 Position.openedAt）。 */
  openedAt: bigint
}

/**
 * Anchor Date（見 frontend/CONTEXT.md）＝一組未平倉部位裡最早的開倉時間。
 * 沒有部位就沒有 Anchor Date——回傳 null，不是 0 或現在的時間戳，那兩者
 * 都會讓呼叫端誤以為存在一個比較區間。
 */
export function earliestOpenedAt(rows: OpenedAtRow[]): bigint | null {
  if (rows.length === 0) return null
  return rows.reduce((min, r) => (r.openedAt < min ? r.openedAt : min), rows[0].openedAt)
}

/** unix 秒 → UTC 日期字串，YYYY-MM-DD。 */
export function toDateStr(sec: bigint): string {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10)
}

/**
 * 使用者報酬率＝未實現損益 ÷ 名目（margin × leverage）。
 *
 * 刻意用名目而不是保證金當分母：$100 保證金、5 倍槓桿、標的漲 5%，以保證金
 * 計是 +25%，那個數字放在未槓桿的指數旁邊會讓純粹的槓桿看起來像超額報酬。
 * 名目為 0（沒有部位）時回傳 null，不是 0%——「打平」是一個真實但編出來的
 * 答案，跟「沒有東西可比」是兩件不同的事。
 */
export function notionalReturnPct(rows: NotionalRow[]): number | null {
  let notional = 0n
  let pnl = 0n
  for (const r of rows) {
    notional += r.margin * r.leverage
    pnl += r.unrealizedPnL
  }
  return notional > 0n ? (Number(pnl) / Number(notional)) * 100 : null
}

// ── 比較的呈現 ───────────────────────────────────────────────────────────────

/** 錨定日到現在經過幾個日曆天。無條件捨去,不足一天顯示 0。 */
export function daysSince(anchorSec: bigint, nowSec: number = Math.floor(Date.now() / 1000)): number {
  return Math.max(0, Math.floor((nowSec - Number(anchorSec)) / 86400))
}

/**
 * 「你贏過幾個指數」。
 *
 * 分母只算**真的拿到報酬率**的指數:某個指數的歷史值抓不到時,把它算進分母
 * 等於憑空宣稱一場沒有發生的比較。四個指數只回來三個,答案就是「N / 3」。
 */
export function beatCountOf(userPct: number | null, benchmarkPcts: (number | null)[]): { beat: number; total: number } {
  const known = benchmarkPcts.filter((p): p is number => p !== null)
  if (userPct === null) return { beat: 0, total: known.length }
  return { beat: known.filter((p) => userPct > p).length, total: known.length }
}

/**
 * 一根「發散長條」在共用刻度上的位置與寬度,單位是百分比(0–100)。
 *
 * 五個項目共用同一個刻度才比得出長短,而刻度必須包含 0——負報酬要能從零線
 * 往左長出去。回傳的 leftPct 是長條起點(零線或負值端),widthPct 是長度。
 *
 * lo === hi(全部項目都一樣,含全為 0)時回寬度 0:與其畫一根長度隨機的長條,
 * 不如什麼都不畫,數字本身仍在旁邊。
 */
export function divergingBarOf(value: number, lo: number, hi: number): { leftPct: number; widthPct: number } {
  const span = hi - lo
  if (span <= 0) return { leftPct: 0, widthPct: 0 }
  const toPct = (v: number) => ((v - lo) / span) * 100
  const zero = toPct(0)
  const point = toPct(value)
  return value >= 0
    ? { leftPct: zero, widthPct: point - zero }
    : { leftPct: point, widthPct: zero - point }
}

/**
 * 五個項目共用的刻度範圍。一定包含 0(零線要在圖上),並在兩端留 8% 餘裕,
 * 最長的那根才不會頂到邊。
 */
export function comparisonScaleOf(values: number[]): [number, number] {
  const withZero = [0, ...values]
  const min = Math.min(...withZero)
  const max = Math.max(...withZero)
  const span = max - min
  if (span === 0) return [0, 1]
  const pad = span * 0.08
  return [min - pad, max + pad]
}
