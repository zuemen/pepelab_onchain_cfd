import { ASSET_META, type AssetCategory } from './assetMeta'

import { t } from 'src/locales'

// Asset Class：畫面上把持倉分成的四大類（股債金幣），frontend/CONTEXT.md 的
// Asset Class 詞條。跟 assetMeta.ts 的 AssetCategory 不是同一件事——那邊 etf
// 是獨立的第五個值，這裡刻意把 ETF 併進 Equity（見同一份 CONTEXT.md 詞條），
// 因為 ETF 本質上是一籃子股票，跟黃金放在一起在概念上說不通。
//
// 曾經只活在 PortfolioAnalysis 元件內部，RWA 配置區塊（issue #64）需要同一套
// 分類；兩邊各寫一份遲早會漂移，所以在這裡建立單一來源。

export type AssetClass = 'crypto' | 'equity' | 'commodity' | 'bond'

export const ASSET_CLASSES: AssetClass[] = ['crypto', 'equity', 'commodity', 'bond']

export interface AssetClassConfig {
  label: string
  icon: string
  color: string
}

export const ASSET_CLASS_CONFIG: Record<AssetClass, AssetClassConfig> = {
  crypto: { label: t.portfolio.analysis.cat.crypto, icon: '₿', color: '#6366f1' },
  equity: { label: t.portfolio.analysis.cat.equity, icon: '◈', color: '#a855f7' },
  commodity: { label: t.portfolio.analysis.cat.commodity, icon: '◆', color: '#f59e0b' },
  bond: { label: t.portfolio.analysis.cat.bond, icon: '◉', color: '#10b981' },
}

const CATEGORY_TO_CLASS: Record<AssetCategory, AssetClass> = {
  equity: 'equity',
  etf: 'equity', // 併入股，不是商品——見上方模組註解與 CONTEXT.md
  bond: 'bond',
  commodity: 'commodity',
  crypto: 'crypto',
}

/**
 * 把一個持倉的資產 id 對到它的 Asset Class。
 *
 * 對到不了 ASSET_META（未知資產 id）時退回 crypto——跟改版前 PortfolioAnalysis
 * 裡的行為一致：那份邏輯本來就把「查無分類」跟「crypto」用同一個 fallthrough
 * 處理，這裡照舊，不是新行為。
 */
export function assetClassOf(assetId: string): AssetClass {
  const cat = ASSET_META[assetId]?.category
  return cat ? CATEGORY_TO_CLASS[cat] : 'crypto'
}

// ── 依 Asset Class 彙總 ──────────────────────────────────────────────────────

export interface MarginRow {
  asset: string
  margin: bigint
  unrealizedPnL: bigint
}

export interface AssetClassSummary {
  margin: bigint
  pnl: bigint
}

/**
 * 依 Asset Class 加總一組未平倉部位的保證金與未實現損益。
 *
 * 四類永遠都在回傳裡，即使輸入是空陣列——RWA 配置區塊零持倉時要顯示四類
 * 皆 $0，不是整塊消失（issue #64），呼叫端不必自己補零或另外判斷。
 */
export function groupMarginByAssetClass(rows: MarginRow[]): Record<AssetClass, AssetClassSummary> {
  const out: Record<AssetClass, AssetClassSummary> = {
    crypto: { margin: 0n, pnl: 0n },
    equity: { margin: 0n, pnl: 0n },
    commodity: { margin: 0n, pnl: 0n },
    bond: { margin: 0n, pnl: 0n },
  }
  for (const row of rows) {
    const cls = assetClassOf(row.asset)
    out[cls].margin += row.margin
    out[cls].pnl += row.unrealizedPnL
  }
  return out
}
