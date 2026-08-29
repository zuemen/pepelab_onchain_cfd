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
  /** 交易部位投入的保證金。 */
  margin: bigint
  /** 持有的代幣化資產市值（18-dec USD）。 */
  holdings: bigint
  /** 未實現損益，只有交易部位有——現貨持倉沒有鏈上成本基礎可算。 */
  pnl: bigint
  /** 這一類在配置圖裡的總量：保證金 + 持倉市值。 */
  value: bigint
}

/**
 * 一筆代幣化資產持倉。價格用 8-dec（oracle 原生刻度）、餘額用 18-dec，
 * 與 TokenizedAssetsPage 讀回來的形狀一致，呼叫端不必先換算。
 */
export interface HoldingRow {
  asset: string
  /** 代幣餘額，18-dec。 */
  balance: bigint
  /** oracle 價格，8-dec。 */
  price: bigint
}

/**
 * 持倉市值，回 18-dec USD。
 *
 * balance(18) × price(8) 會得到 26 位小數，除 1e8 收回 18 位。全程走 bigint：
 * 中途轉 Number 會在部位大到 2^53 之後開始掉精度，而這個值會被拿去算佔比。
 */
export function holdingValue(row: HoldingRow): bigint {
  return (row.balance * row.price) / 100_000_000n
}

/**
 * 依 Asset Class 加總一組未平倉部位與代幣化資產持倉。
 *
 * 四類永遠都在回傳裡，即使兩邊都是空的——RWA 配置區塊零持倉時要顯示四類皆 $0，
 * 不是整塊消失（issue #64），呼叫端不必自己補零或另外判斷。
 *
 * 為什麼要同時吃兩種來源：平台把門面改成代幣化 RWA 現貨之後，一般使用者的資產
 * 是 /tokens 買來的合成代幣，不是永續部位的保證金。只算保證金的話，一個買了
 * sGOLD 與 sBOND 的人在配置圖上會是四類皆 0%——正好是這個區塊要證明的事情的反面。
 */
export function groupByAssetClass(
  positions: MarginRow[],
  holdings: HoldingRow[] = [],
): Record<AssetClass, AssetClassSummary> {
  const out: Record<AssetClass, AssetClassSummary> = {
    crypto:    { margin: 0n, holdings: 0n, pnl: 0n, value: 0n },
    equity:    { margin: 0n, holdings: 0n, pnl: 0n, value: 0n },
    commodity: { margin: 0n, holdings: 0n, pnl: 0n, value: 0n },
    bond:      { margin: 0n, holdings: 0n, pnl: 0n, value: 0n },
  }
  for (const row of positions) {
    const cls = assetClassOf(row.asset)
    out[cls].margin += row.margin
    out[cls].pnl    += row.unrealizedPnL
  }
  for (const row of holdings) {
    const cls = assetClassOf(row.asset)
    out[cls].holdings += holdingValue(row)
  }
  for (const cls of ASSET_CLASSES) {
    out[cls].value = out[cls].margin + out[cls].holdings
  }
  return out
}

/**
 * 舊名，只吃部位。保留是因為它已經是公開 API 且語意仍然正確；新的呼叫端請用
 * `groupByAssetClass`，它多帶持倉。
 */
export function groupMarginByAssetClass(rows: MarginRow[]): Record<AssetClass, AssetClassSummary> {
  return groupByAssetClass(rows)
}

