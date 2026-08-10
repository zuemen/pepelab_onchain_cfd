import { ASSET_IDS, CHAIN_MAP } from 'src/contracts/addresses'

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
    icon:      '🍎',
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

// PEPE (the platform's own ERC20 utility token, not a synthetic perp market —
// it has no ASSET_IDS entry and no oracle price feed) used to be hardcoded
// here under two addresses: Sepolia's PepeToken and the zero address as a
// placeholder. Neither matches Base Sepolia's real PepeToken
// (0xccd05cbd…), so on Base Sepolia a held/displayed PEPE balance couldn't
// find its metadata, AND the two stale entries each turned into their own
// "PEPE" tab in every ASSETS_LIST consumer (Pro Terminal, Exchange, oracle
// admin…) — visibly duplicated, and neither one tradable since PEPE was
// never in ASSET_IDS to begin with.
//
// Deriving from CHAIN_MAP means adding a new chain's PepeToken address never
// needs a second edit here, and registering it under every known chain (not
// just whichever one happens to be connected right now) keeps portfolio /
// dashboard lookups working when they read a position's raw asset address —
// which arrives checksummed from ethers, not lowercased — while chains
// vary in whether PepeToken is deployed at all (zero address = not
// deployed, skipped).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
for (const chain of Object.values(CHAIN_MAP)) {
  if (!chain.PepeToken || chain.PepeToken === ZERO_ADDRESS) continue
  ASSET_META[chain.PepeToken] = {
    symbol:    'PEPE',
    name:      'Pepe RWA Utility Token',
    category:  'crypto',
    regulated: false,
    icon:      '🐸',
  }
}

/**
 * Flat list for selects/maps of TRADABLE synthetic markets — the tab strip in
 * Pro Terminal / Exchange, the oracle admin roster, agent monitoring, etc.
 *
 * Deliberately built from ASSET_IDS rather than "every key in ASSET_META":
 * PEPE lives in ASSET_META for display lookups (portfolio holdings, ESG
 * badges) but has no oracle price feed and can't be opened as a position, so
 * it must never show up as a selectable market here.
 */
export const ASSETS_LIST = Object.entries(ASSET_IDS).map(([, id]) => ({
  id: id as `0x${string}`,
  ...ASSET_META[id],
  label:       ASSET_META[id].symbol,    // backward compat
  requiresKYC: ASSET_META[id].regulated, // backward compat
}))

/** id → symbol lookup */
export const ASSET_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_META).map(([id, m]) => [id, m.symbol])
)
