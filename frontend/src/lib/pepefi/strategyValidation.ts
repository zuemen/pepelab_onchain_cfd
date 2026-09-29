// 策略發布前的驗證——對齊 StrategyRegistry.publishStrategy 的每一條 revert。
//
//   TooFewAssets      allocations.length < MIN_ALLOCATION_ASSETS (3)
//   DuplicateAsset    同一標的出現兩次
//   ZeroWeight        權重為 0
//   WeightExceedsMax  單檔 > MAX_ALLOCATION_WEIGHT_BPS (5000 = 50%)
//   InvalidWeightSum  Σ weight != 10000
//
// 權重在 UI 上以百分比輸入（最多兩位小數），送鏈前換成 bps。三檔各 33.33% 四捨五入
// 後是 9,999 bps——使用者的意思明明是 100%，合約卻會 revert InvalidWeightSum。所以
// 「原始輸入加起來本來就是 100%、只差在四捨五入」時，把差額補到權重最大的那一檔
// （補 1–2 bps 對它的佔比影響最小）；原始輸入本來就不是 100%，就照實報錯，不幫
// 使用者猜。

export const MIN_ALLOCATION_ASSETS = 3
export const MAX_ALLOCATION_WEIGHT_BPS = 5_000
export const TOTAL_WEIGHT_BPS = 10_000

export type StrategyIssue =
  | { code: 'TooFewAssets'; got: number }
  | { code: 'DuplicateAsset' }
  | { code: 'ZeroWeight'; index: number }
  | { code: 'WeightExceedsMax'; index: number; bps: number }
  | { code: 'InvalidWeightSum'; bps: number }

export interface StrategyCheck {
  /** 送鏈的 bps（已補過四捨五入差額）。只有 issues 為空時才可以送。 */
  bps: number[]
  issues: StrategyIssue[]
  /** 補了多少 bps 的四捨五入差額（0 = 沒補）。 */
  roundingAdjust: number
}

export function validateStrategy(rows: readonly { asset: string; weight: string }[]): StrategyCheck {
  const issues: StrategyIssue[] = []

  const exact = rows.map((r) => {
    const pct = parseFloat(r.weight || '0')
    return Number.isFinite(pct) ? pct * 100 : 0
  })
  const bps = exact.map((v) => Math.round(v))
  const exactSum = exact.reduce((s, v) => s + v, 0)
  let roundingAdjust = 0

  const roundedSum = bps.reduce((s, v) => s + v, 0)
  if (roundedSum !== TOTAL_WEIGHT_BPS && Math.abs(exactSum - TOTAL_WEIGHT_BPS) < 0.5 && bps.length > 0) {
    const diff = TOTAL_WEIGHT_BPS - roundedSum
    let largest = 0
    bps.forEach((v, i) => {
      if (v > bps[largest]) largest = i
    })
    bps[largest] += diff
    roundingAdjust = diff
  }

  if (rows.length < MIN_ALLOCATION_ASSETS) issues.push({ code: 'TooFewAssets', got: rows.length })
  if (new Set(rows.map((r) => r.asset.toLowerCase())).size !== rows.length) issues.push({ code: 'DuplicateAsset' })
  bps.forEach((v, index) => {
    if (v <= 0) issues.push({ code: 'ZeroWeight', index })
    else if (v > MAX_ALLOCATION_WEIGHT_BPS) issues.push({ code: 'WeightExceedsMax', index, bps: v })
  })
  const finalSum = bps.reduce((s, v) => s + v, 0)
  if (finalSum !== TOTAL_WEIGHT_BPS) issues.push({ code: 'InvalidWeightSum', bps: finalSum })

  return { bps, issues, roundingAdjust }
}
