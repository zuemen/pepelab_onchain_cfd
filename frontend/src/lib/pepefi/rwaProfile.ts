// RWA 資產卡的靜態事實：每檔標的參照哪一類真實資產、keeper 從哪裡取價。
//
// 這裡只放「不會隨鏈上狀態改變」的事實。是否標記為 rwaAsset、是否需要 KYC、槓桿上限、
// 碳分級……一律是鏈上讀值（rwaCards.ts），不寫死在這裡——同一個前端可能連到不同的部署。
//
// 類別刻意比 assetMeta.ts 的 AssetCategory 細：ESG ETF 與債券 ETF 分開、黃金單獨一類，
// 因為三者的參考價、時段與風險揭露不同（docs/RWA_ALIGNMENT.md §3）。

import type { AssetSymbol } from 'src/contracts/addresses'

import { ASSET_IDS } from 'src/contracts/addresses'

import { ASSET_META } from './assetMeta'

export type RwaClass = 'equity' | 'gold' | 'bondEtf' | 'esgEtf' | 'crypto'

export const RWA_CLASS: Record<AssetSymbol, RwaClass> = {
  sAAPL: 'equity',
  sTSLA: 'equity',
  sNVDA: 'equity',
  sMSFT: 'equity',
  sGOOGL: 'equity',
  sGOLD: 'gold',
  sBOND: 'bondEtf',
  sICLN: 'esgEtf',
  sESGU: 'esgEtf',
  sBTC: 'crypto',
  sETH: 'crypto',
}

/** 卡片的排列順序：先參照現實世界資產的，再加密資產。 */
export const RWA_CARD_ORDER: readonly AssetSymbol[] = [
  'sAAPL',
  'sTSLA',
  'sNVDA',
  'sMSFT',
  'sGOOGL',
  'sGOLD',
  'sBOND',
  'sICLN',
  'sESGU',
  'sBTC',
  'sETH',
]

/** 這檔是否參照現實世界資產（與鏈上有沒有標記 rwaAsset 是兩件事）。 */
export function refersToRealWorldAsset(symbol: AssetSymbol): boolean {
  return RWA_CLASS[symbol] !== 'crypto'
}

export type PriceProvider = 'coingecko' | 'yahoo' | 'coinbase' | 'nasdaq' | 'goldapi'

export interface PriceSourceRef {
  provider: PriceProvider
  ticker: string
}

/**
 * keeper 的第二來源（agent/keeper/feeds.ts 的 SECONDARY_SOURCES，只在偏離過大時抓來確認）。
 * 股票、ETF、黃金沒有——keeper 刻意不列，因為沒有獨立的免費來源。rwaProfile.keeper.test.ts
 * 直接載入 keeper 的原始檔逐鍵比對。
 */
export const KEEPER_SECONDARY: Partial<Record<AssetSymbol, PriceSourceRef>> = {
  sBTC: { provider: 'yahoo', ticker: 'BTC-USD' },
  sETH: { provider: 'yahoo', ticker: 'ETH-USD' },
}

/** keeper 的主來源（assetMeta.ts 的 provenance 已是 keeper SOURCES 的鏡像）。 */
export function keeperPrimary(symbol: AssetSymbol): PriceSourceRef | null {
  const p = ASSET_META[ASSET_IDS[symbol]]?.provenance
  return p ? { provider: p.priceFeed, ticker: p.priceSymbol } : null
}

export function keeperSecondary(symbol: AssetSymbol): PriceSourceRef | null {
  return KEEPER_SECONDARY[symbol] ?? null
}
