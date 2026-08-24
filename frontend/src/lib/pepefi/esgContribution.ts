import type { ESGInfo } from 'src/hooks/useESG'

import { ASSET_META } from './assetMeta'

// 各持倉對投資組合 ESG 分數的貢獻比（依市值加權，跟 PortfolioAnalysis 算
// composite 用同一套權重）。抽成純函式是為了不靠渲染 React 就能測試——
// 這個 repo 的 vitest 跑在 node 環境，沒有 DOM。

export interface EsgContributionRow {
  asset: string
  /** 18-dec。 */
  currentValue: bigint
}

export interface EsgContribution {
  asset: string
  symbol: string
  /** 這個標的佔投資組合市值的百分比。 */
  weightPct: number
  composite: number
  rating: string
}

/**
 * 依市值由大到小排序。同一個標的的多筆部位（例如分批加倉）合併成一筆——
 * 「sBTC 出現兩次、各佔一半權重」比「sBTC 出現一次、佔完整權重」更難讀，
 * 也沒有多帶任何資訊。
 *
 * 呼叫端應該只在每個標的都有 ESG 資料時才呼叫這個函式（PortfolioAnalysis
 * 的 portfolioESG !== null 已經做過這個判斷）；缺資料的標的會拿到
 * composite 0 / rating "—"，不是拿去騙一個看起來正常的分數。
 */
export function esgContributionOf(rows: EsgContributionRow[], esg: Record<string, ESGInfo>): EsgContribution[] {
  const valueByAsset = new Map<string, number>()
  let totalVal = 0
  for (const row of rows) {
    const val = Number(row.currentValue) / 1e18
    valueByAsset.set(row.asset, (valueByAsset.get(row.asset) ?? 0) + val)
    totalVal += val
  }
  if (totalVal === 0) return []

  return [...valueByAsset.entries()]
    .map(([asset, val]) => {
      const info = esg[asset]
      return {
        asset,
        symbol: ASSET_META[asset]?.symbol ?? '?',
        weightPct: (val / totalVal) * 100,
        composite: info?.composite ?? 0,
        rating: info?.rating ?? '—',
      }
    })
    .sort((a, b) => b.weightPct - a.weightPct)
}
