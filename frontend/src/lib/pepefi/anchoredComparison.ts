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
