// 資產 → 聯合國永續發展目標（SDG）的對應（#333）。
//
// 這是**團隊依資產組成所做的判斷**，不是第三方評等：每個資產列出相關目標、正向或負向，
// 理由（顯示字串）在 catalog 的 `esg.sdg.reasons[symbol][goal]`，比照 esg.ts 把每檔一句話的
// 評分理由放 catalog 的作法。性質比照碳分級的「質性」依據，畫面照實標示。
//
// SDG 不進入任何定價：手續費與槓桿只看碳分級（docs/ADR-003-carbon-priced-capital.md）。
//
// 內容需要組員撰寫並審過（issue #333 Further Notes）；改表時 sdg.test.ts 會要求兩個語系的理由一起改。

import { ASSET_META } from './assetMeta'

export const SDG_GOALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] as const

export type SdgEffect = 'positive' | 'negative'

export interface SdgLink {
  goal: number
  effect: SdgEffect
}

/** 鍵是資產代號（ASSET_IDS 的鍵）。 */
export const ASSET_SDG: Readonly<Record<string, readonly SdgLink[]>> = {
  sBTC: [
    { goal: 7, effect: 'negative' },
    { goal: 13, effect: 'negative' },
  ],
  sETH: [{ goal: 9, effect: 'positive' }],
  sAAPL: [
    { goal: 12, effect: 'positive' },
    { goal: 8, effect: 'negative' },
  ],
  sTSLA: [
    { goal: 7, effect: 'positive' },
    { goal: 11, effect: 'positive' },
    { goal: 12, effect: 'negative' },
  ],
  sGOLD: [
    { goal: 15, effect: 'negative' },
    { goal: 6, effect: 'negative' },
  ],
  sBOND: [
    { goal: 7, effect: 'positive' },
    { goal: 13, effect: 'positive' },
  ],
  sNVDA: [
    { goal: 9, effect: 'positive' },
    { goal: 7, effect: 'negative' },
  ],
  sMSFT: [
    { goal: 9, effect: 'positive' },
    { goal: 7, effect: 'negative' },
  ],
  sGOOGL: [
    { goal: 9, effect: 'positive' },
    { goal: 7, effect: 'positive' },
  ],
  sICLN: [
    { goal: 7, effect: 'positive' },
    { goal: 13, effect: 'positive' },
  ],
  sESGU: [
    { goal: 13, effect: 'positive' },
    { goal: 12, effect: 'positive' },
  ],
}

export interface WeightedSymbol {
  symbol: string
  /** 任何非負刻度（bps、市值），只有相對大小有意義。 */
  weight: number
  /** false＝空方部位。放空一個資產不代表支持它對應的目標，所以不計入任何目標。省略＝做多（現貨）。 */
  isLong?: boolean
}

/** 鏈上的資產 id（bytes32，大小寫不拘）→ 代號；認不得的 id 原樣留著，在分布裡算成未對應。 */
export function sdgHoldings(
  legs: readonly { asset: string; weight: number; isLong?: boolean }[],
): WeightedSymbol[] {
  return legs.map((l) => ({
    symbol: ASSET_META[l.asset.toLowerCase()]?.symbol ?? l.asset,
    weight: l.weight,
    ...(l.isLong === undefined ? {} : { isLong: l.isLong }),
  }))
}

export interface SdgShare {
  goal: number
  /** 正向對應這個目標的資產佔總權重的百分比，0–100。 */
  positivePct: number
  /** 負向對應這個目標的資產佔總權重的百分比，0–100。 */
  negativePct: number
}

export interface SdgDistribution {
  /** 依總曝險（正＋負）由大到小。 */
  goals: SdgShare[]
  /** 不在對應表裡的資產佔總權重的百分比——不被當成中性、也不分攤到各目標。 */
  unmappedPct: number
  /** 空方部位佔總權重的百分比，不計入任何目標。 */
  shortPct: number
}

/**
 * 依權重的 SDG 分布。一個資產對應多個目標時，它的權重完整算進每一個目標——這不是把
 * 100% 分給各目標，而是「這個目標牽涉到多少比例的持倉」，所以各目標加總可以超過 100%。
 */
export function sdgDistribution(holdings: readonly WeightedSymbol[]): SdgDistribution {
  let total = 0
  let unmapped = 0
  let short = 0
  const pos = new Map<number, number>()
  const neg = new Map<number, number>()
  for (const h of holdings) {
    if (!(h.weight > 0)) continue
    total += h.weight
    if (h.isLong === false) {
      short += h.weight
      continue
    }
    const links = ASSET_SDG[h.symbol]
    if (!links) {
      unmapped += h.weight
      continue
    }
    for (const { goal, effect } of links) {
      const m = effect === 'positive' ? pos : neg
      m.set(goal, (m.get(goal) ?? 0) + h.weight)
    }
  }
  if (total === 0) return { goals: [], unmappedPct: 0, shortPct: 0 }
  const goals = [...new Set([...pos.keys(), ...neg.keys()])]
    .map((goal) => ({
      goal,
      positivePct: ((pos.get(goal) ?? 0) / total) * 100,
      negativePct: ((neg.get(goal) ?? 0) / total) * 100,
    }))
    .sort((a, b) => b.positivePct + b.negativePct - (a.positivePct + a.negativePct) || a.goal - b.goal)
  return { goals, unmappedPct: (unmapped / total) * 100, shortPct: (short / total) * 100 }
}

/** 排行榜的 SDG 篩選：策略裡有任何（權重 > 0、做多的）資產正向對應 `goal`。 */
export function hasPositiveExposure(holdings: readonly WeightedSymbol[], goal: number): boolean {
  return holdings.some(
    (h) =>
      h.weight > 0 &&
      h.isLong !== false &&
      (ASSET_SDG[h.symbol] ?? []).some((l) => l.goal === goal && l.effect === 'positive'),
  )
}

/** catalog 裡的目標名稱（鍵是 1–17）。 */
export function sdgGoalName(names: Readonly<Record<number, string>>, goal: number): string {
  return names[goal] ?? ''
}

/** 對應表裡出現過的目標，由小到大——篩選選單的選項。 */
export const MAPPED_GOALS: readonly number[] = [
  ...new Set(Object.values(ASSET_SDG).flatMap((links) => links.map((l) => l.goal))),
].sort((a, b) => a - b)
