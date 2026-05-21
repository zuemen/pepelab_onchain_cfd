import { ASSET_IDS } from '../contracts/addresses'

export interface AssetMeta {
  label:       string   // display name, e.g. "sBTC"
  coingeckoId: string   // CoinGecko price id (empty = simulated/no live feed)
  category:    'crypto' | 'equity' | 'commodity' | 'bond'
  description: string
}

export const ASSET_META: Record<string, AssetMeta> = {
  [ASSET_IDS.sBTC]: {
    label:       'sBTC',
    coingeckoId: 'bitcoin',
    category:    'crypto',
    description: 'Synthetic Bitcoin',
  },
  [ASSET_IDS.sETH]: {
    label:       'sETH',
    coingeckoId: 'ethereum',
    category:    'crypto',
    description: 'Synthetic Ethereum',
  },
  [ASSET_IDS.sAAPL]: {
    label:       'sAAPL',
    coingeckoId: '',
    category:    'equity',
    description: 'Synthetic Apple Inc.',
  },
  [ASSET_IDS.sTSLA]: {
    label:       'sTSLA',
    coingeckoId: '',
    category:    'equity',
    description: 'Synthetic Tesla Inc.',
  },
  [ASSET_IDS.sGOLD]: {
    label:       'sGOLD',
    coingeckoId: '',
    category:    'commodity',
    description: 'Synthetic Gold (XAU/USD)',
  },
  [ASSET_IDS.sBOND]: {
    label:       'sBOND',
    coingeckoId: '',
    category:    'bond',
    description: 'Synthetic US Treasury Bond',
  },
}

/** Flat array of { id, label, ...meta } for use in selects / maps */
export const ASSETS_LIST = Object.entries(ASSET_META).map(([id, m]) => ({
  id: id as `0x${string}`,
  ...m,
}))

/** id → label lookup */
export const ASSET_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_META).map(([id, m]) => [id, m.label])
)
