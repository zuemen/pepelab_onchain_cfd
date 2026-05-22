import { ASSET_IDS } from '../contracts/addresses'

export type AssetCategory = 'crypto' | 'equity' | 'etf' | 'commodity' | 'bond'

export interface AssetMeta {
  symbol:    string
  name:      string
  category:  AssetCategory
  regulated: boolean  // equity / bond / ETF — requires KYC gate
  icon:      string
}

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  crypto:    'Crypto',
  equity:    'Equity',
  etf:       'ETF',
  commodity: 'Commodity',
  bond:      'Bond',
}

export const ASSET_META: Record<string, AssetMeta> = {
  [ASSET_IDS.sBTC]: {
    symbol:    'sBTC',
    name:      'Synthetic Bitcoin',
    category:  'crypto',
    regulated: false,
    icon:      '₿',
  },
  [ASSET_IDS.sETH]: {
    symbol:    'sETH',
    name:      'Synthetic Ethereum',
    category:  'crypto',
    regulated: false,
    icon:      'Ξ',
  },
  [ASSET_IDS.sAAPL]: {
    symbol:    'sAAPL',
    name:      'Synthetic Apple Inc.',
    category:  'equity',
    regulated: true,
    icon:      '',
  },
  [ASSET_IDS.sTSLA]: {
    symbol:    'sTSLA',
    name:      'Synthetic Tesla Inc.',
    category:  'equity',
    regulated: true,
    icon:      '⚡',
  },
  [ASSET_IDS.sGOLD]: {
    symbol:    'sGOLD',
    name:      'Synthetic Gold (XAU/USD)',
    category:  'commodity',
    regulated: false,
    icon:      '🥇',
  },
  [ASSET_IDS.sBOND]: {
    symbol:    'sBOND',
    name:      'Synthetic US Treasury Bond',
    category:  'bond',
    regulated: true,
    icon:      '📜',
  },
  [ASSET_IDS.sNVDA]: {
    symbol:    'sNVDA',
    name:      'Synthetic NVIDIA Corp.',
    category:  'equity',
    regulated: true,
    icon:      '🖥',
  },
  [ASSET_IDS.sMSFT]: {
    symbol:    'sMSFT',
    name:      'Synthetic Microsoft Corp.',
    category:  'equity',
    regulated: true,
    icon:      '🪟',
  },
  [ASSET_IDS.sGOOGL]: {
    symbol:    'sGOOGL',
    name:      'Synthetic Alphabet Inc.',
    category:  'equity',
    regulated: true,
    icon:      '🔍',
  },
  [ASSET_IDS.sICLN]: {
    symbol:    'sICLN',
    name:      'Synthetic iShares Clean Energy ETF',
    category:  'etf',
    regulated: true,
    icon:      '🌿',
  },
  [ASSET_IDS.sESGU]: {
    symbol:    'sESGU',
    name:      'Synthetic iShares MSCI USA ESG ETF',
    category:  'etf',
    regulated: true,
    icon:      '🌱',
  },
}

/** Flat list for selects/maps. Includes backward-compat aliases. */
export const ASSETS_LIST = Object.entries(ASSET_META).map(([id, m]) => ({
  id:          id as `0x${string}`,
  ...m,
  label:       m.symbol,    // backward compat
  requiresKYC: m.regulated, // backward compat
}))

/** id → symbol lookup */
export const ASSET_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_META).map(([id, m]) => [id, m.symbol])
)
