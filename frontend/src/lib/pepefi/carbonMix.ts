// 持倉的碳分級組成（#333）：多少比例在低、中、高碳分級。
//
// 刻意不是「碳足跡噸數」：不同資產的碳強度單位不同（營收基礎、絕對排放、質性），不能加總成
// 一個噸數（CONTEXT.md 的 Carbon Basis）。能誠實比較的只有「落在哪一級」。

import type { Tier } from './carbon'

/**
 * `unrated`：鏈上讀到了，但沒有有效見證（定價照最保守一級）。
 * `unknown`：讀不到——不知道就是不知道，不能算成低碳。
 */
export type TierBucket = Tier | 'unknown'

export const TIER_BUCKETS: readonly TierBucket[] = ['low', 'mid', 'high', 'unrated', 'unknown']

export interface WeightedAsset {
  /** 資產 id（bytes32）或任何呼叫端用來查等級的鍵。 */
  asset: string
  weight: number
}

/** 各級佔總權重的百分比；有權重時加總為 100，沒有權重時全部為 0。 */
export function carbonTierMix(
  holdings: readonly WeightedAsset[],
  tierOf: (asset: string) => Tier | null,
): Record<TierBucket, number> {
  const out: Record<TierBucket, number> = { low: 0, mid: 0, high: 0, unrated: 0, unknown: 0 }
  let total = 0
  for (const h of holdings) {
    if (!(h.weight > 0)) continue
    total += h.weight
    out[tierOf(h.asset) ?? 'unknown'] += h.weight
  }
  if (total === 0) return out
  for (const b of TIER_BUCKETS) out[b] = (out[b] / total) * 100
  return out
}
