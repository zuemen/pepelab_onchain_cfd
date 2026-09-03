// 分散度：一組權重分佈有多「攤開」。
//
// 詞彙表 Diversification：「How spread out a holding is across its assets.
// Measured and shown for a user's own holdings, never enforced on them;
// enforced only on a published Allocation, where the word is a claim being
// made to other people.」——所以這個模組只算數字,不做任何判斷「夠不夠分散」;
// Allocation 的「至少 3 個資產、單一權重 ≤ 50%」那種門檻是 StrategyRegistry
// 的事,不在這裡。
//
// 用的是 Herfindahl–Hirschman Index(HHI = Σ 權重佔比的平方):完全集中在
// 一個資產時 HHI = 1,平均攤在 n 個資產時 HHI = 1/n。它的倒數就是「等效
// 資產數」(Laakso–Taagepera),一個比百分比更好讀的量:HHI 0.25 → 等效
// 4 個資產。

export interface Diversification {
  /** Σ 權重佔比²,落在 (0, 1]；沒有任何正權重時為 0。 */
  hhi: number
  /** 1 / HHI,等效資產數；沒有任何正權重時為 0。 */
  effectiveAssets: number
  /**
   * 0–1 的分數。0 = 全押一個資產,1 = 在「實際持有的資產」之間完全均分。
   *
   * 分母是實際持有的資產數,不是平台上所有資產——所以「3 個資產各 1/3」和
   * 「8 個資產各 1/8」都會拿到 1。這個分數說的是「持有的東西之間攤得均不
   * 均」,不是「持有的東西夠不夠多」。後者由呼叫端自己看 `effectiveAssets`
   * 或資產筆數決定。
   */
  score: number
}

const EMPTY: Diversification = { hhi: 0, effectiveAssets: 0, score: 0 }

/**
 * 從一組權重算分散度。權重可以是任何非負刻度(bps、市值、比例),只有相對
 * 大小有意義。零與負權重的項目直接略過——它們不是「持有 0」而是「沒有這個
 * 部位」,不該把等效資產數灌水。
 */
export function diversification(weights: readonly number[]): Diversification {
  const positive = weights.filter((w) => w > 0)
  const n = positive.length
  if (n === 0) return EMPTY

  const total = positive.reduce((a, b) => a + b, 0)
  const hhi = positive.reduce((acc, w) => {
    const f = w / total
    return acc + f * f
  }, 0)
  const effectiveAssets = 1 / hhi
  const score = n === 1 ? 0 : (effectiveAssets - 1) / (n - 1)

  return { hhi, effectiveAssets, score }
}

/**
 * 同上,但吃 18-dec(或任何刻度)的 bigint 市值——投資組合的持倉市值是
 * bigint,先轉 Number 個別會在大部位掉精度。這裡先用整數比例把每個值縮到
 * ppm 再轉 Number,分散度是顯示量、ppm 精度綽綽有餘。
 */
export function diversificationByValue(values: readonly bigint[]): Diversification {
  const positive = values.filter((v) => v > 0n)
  if (positive.length === 0) return EMPTY
  const total = positive.reduce((a, b) => a + b, 0n)
  const ppm = positive.map((v) => Number((v * 1_000_000n) / total))
  return diversification(ppm)
}
