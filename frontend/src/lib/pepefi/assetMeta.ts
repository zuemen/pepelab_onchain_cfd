import { ASSET_IDS, CHAIN_MAP } from 'src/contracts/addresses'

import type { Tier } from './carbon'

export type AssetCategory = 'crypto' | 'equity' | 'etf' | 'commodity' | 'bond'

/**
 * 一顆資產「追蹤什麼、價格哪裡來」的可查證事實。
 *
 * issue #100 ①:代號卡 → 身世卡。這裡放的是識別碼、來源系統、來源符號——
 * 機讀的事實,不是文字。畫面上要顯示的那句「標的是什麼」「為什麼受 KYC 管制」
 * 是顯示字串,活在 catalog 的 `tokens.provenance` 而不是這裡(比照 esg.ts 把
 * 每檔一句話的評分理由放 catalog 的作法)。
 */
export interface AssetProvenance {
  /** 真實世界識別碼:交易所 + 代號、ETF 代號、商品代碼、加密網路。可自行查證的東西。 */
  referenceId: string
  /**
   * 鏈上結算價的來源系統(keeper `agent/keeper/feeds.ts` 的 `SOURCES`):
   * `coingecko`(加密現貨)或 `yahoo`(股票 / ETF / 黃金 chart)。畫面把它
   * 轉成標籤;新鮮度門檻沿用 priceFreshness.ts,對齊合約的 maxPriceAge。
   */
  priceFeed: 'coingecko' | 'yahoo'
  /** 這顆資產在該來源系統裡的符號(keeper 實際查詢用的值)。 */
  priceSymbol: string
}

/**
 * 碳強度與它的出處。數字與門檻對齊 `docs/data/carbon-intensity.md`(issue #94
 * 的蒐集產出)與 `carbon.ts` 的 `tierOf`。`ESGRegistryV2` 之後上鏈時,這張表
 * 會被鏈上讀取取代;在那之前,這是唯一的來源。
 *
 * 只放機讀的事實。出處名稱、已知限制那些顯示字串在 catalog 的
 * `tokens.provenance.assets[symbol]`,比照 esg.ts 把每檔一句話放 catalog。
 */
export interface AssetCarbon {
  /** tCO2e / 每百萬美元營收。非營收基準的資產(黃金、加密、質性判定)為 null。 */
  intensity: number | null
  /**
   * 碳強度是怎麼得到的:
   *  - `revenue`      營收基準,可直接餵 `tierOf`
   *  - `absolute`     絕對年排放量 + 產業基準(黃金、加密)——不能跨資產類別正規化
   *  - `qualitative`  依類別組成判定,沒有計算出來的數字(sICLN、待替換的 sBOND)
   */
  basis: 'revenue' | 'absolute' | 'qualitative'
  /** 對齊 carbon.ts 的 Tier;`revenue` 基準的資產,這個值必須等於 `tierOf(intensity, true)`。 */
  tier: Tier
  /** 見證觀測日,ISO `YYYY-MM-DD`;沒有可稽核來源時為 `'—'`(視同過期 → 未評等)。 */
  observed: string
  /** 出處網址——使用者自己去查證那個數字的地方,不是「相信平台」。 */
  sourceUrl: string
}

export interface AssetMeta {
  symbol:    string
  name:      string
  category:  AssetCategory
  regulated: boolean  // equity / bond / ETF — requires KYC gate
  icon:      string
  /** issue #100 ①。ASSET_IDS 裡的每一顆都有;PEPE(工具代幣,非追蹤標的)沒有。 */
  provenance?: AssetProvenance
  carbon?:     AssetCarbon
}

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  crypto:    'Crypto',
  equity:    'Equity',
  etf:       'ETF',
  commodity: 'Commodity',
  bond:      'Bond',
}

// 碳強度數字、門檻與出處全部對齊 docs/data/carbon-intensity.md（issue #94 的
// 蒐集產出，2026-09-02 擷取）。營收基準的資產（equity / 部分 ETF）的 `tier`
// 必須等於 carbon.ts `tierOf(intensity, true)`——assetMeta.test.ts 釘住這件事。
// 非營收基準（黃金、加密）用絕對年排放量 + 產業基準判級，不套 tierOf。
//
// referenceId 只放可自行查證的識別碼（交易所 + 代號、加密網路），不放中文——
// 顯示用的標的說明、出處名稱、已知限制在 catalog 的 tokens.provenance.assets。
const CARBON_DOC =
  'https://github.com/zuemen/pepelab_onchain_cfd/blob/master/docs/data/carbon-intensity.md'

export const ASSET_META: Record<string, AssetMeta> = {
  [ASSET_IDS.sBTC]: {
    symbol:    'sBTC',
    name:      'Synthetic Bitcoin',
    category:  'crypto',
    regulated: false,
    icon:      '₿',
    provenance: {
      referenceId: 'BTC · Bitcoin mainnet (proof-of-work)',
      priceFeed:   'coingecko',
      priceSymbol: 'bitcoin',
    },
    carbon: {
      intensity: null,
      basis:     'absolute',
      tier:      'high',
      observed:  '2026-09-02',
      sourceUrl: 'https://ccaf.io/cbnsi/cbeci/ghg',
    },
  },
  [ASSET_IDS.sETH]: {
    symbol:    'sETH',
    name:      'Synthetic Ethereum',
    category:  'crypto',
    regulated: false,
    icon:      'Ξ',
    provenance: {
      referenceId: 'ETH · Ethereum mainnet (proof-of-stake)',
      priceFeed:   'coingecko',
      priceSymbol: 'ethereum',
    },
    carbon: {
      intensity: null,
      basis:     'absolute',
      tier:      'low',
      observed:  '2026-09-02',
      sourceUrl: 'https://www.jbs.cam.ac.uk/2026/new-report-maps-ethereums-climate-footprint-with-new-precision/',
    },
  },
  [ASSET_IDS.sAAPL]: {
    symbol:    'sAAPL',
    name:      'Synthetic Apple Inc.',
    category:  'equity',
    regulated: true,
    icon:      '🍎',
    provenance: {
      referenceId: 'NASDAQ: AAPL · Apple Inc.',
      priceFeed:   'yahoo',
      priceSymbol: 'AAPL',
    },
    carbon: {
      intensity: 0.150,
      basis:     'revenue',
      tier:      'low',
      observed:  '2026-09-02',
      sourceUrl: 'https://tracenable.com/company/apple/ghg-emissions',
    },
  },
  [ASSET_IDS.sTSLA]: {
    symbol:    'sTSLA',
    name:      'Synthetic Tesla Inc.',
    category:  'equity',
    regulated: true,
    icon:      '⚡',
    provenance: {
      referenceId: 'NASDAQ: TSLA · Tesla, Inc.',
      priceFeed:   'yahoo',
      priceSymbol: 'TSLA',
    },
    carbon: {
      intensity: 10.021,
      basis:     'revenue',
      tier:      'high',
      observed:  '2026-09-02',
      sourceUrl: 'https://tracenable.com/company/tesla/ghg-emissions',
    },
  },
  [ASSET_IDS.sGOLD]: {
    symbol:    'sGOLD',
    name:      'Synthetic Gold (XAU/USD)',
    category:  'commodity',
    regulated: false,
    icon:      '🥇',
    provenance: {
      referenceId: 'COMEX: GC=F · front-month gold future (XAU/USD)',
      priceFeed:   'yahoo',
      priceSymbol: 'GC=F',
    },
    carbon: {
      intensity: null,
      basis:     'absolute',
      tier:      'high',
      observed:  '2026-09-02',
      sourceUrl: 'https://pages.marketintelligence.spglobal.com/greenhouse-gas-and-gold-mines-EMC.html',
    },
  },
  [ASSET_IDS.sBOND]: {
    symbol:    'sBOND',
    name:      'Synthetic US Treasury Bond ETF (TLT)',
    category:  'bond',
    regulated: true,
    icon:      '📜',
    provenance: {
      referenceId: 'NASDAQ: TLT · iShares 20+ Year Treasury Bond ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'TLT',
    },
    carbon: {
      intensity: null,
      basis:     'qualitative',
      tier:      'unrated',
      observed:  '—',
      sourceUrl: CARBON_DOC,
    },
  },
  [ASSET_IDS.sNVDA]: {
    symbol:    'sNVDA',
    name:      'Synthetic NVIDIA Corp.',
    category:  'equity',
    regulated: true,
    icon:      '🖥',
    provenance: {
      referenceId: 'NASDAQ: NVDA · NVIDIA Corporation',
      priceFeed:   'yahoo',
      priceSymbol: 'NVDA',
    },
    carbon: {
      intensity: 0.099,
      basis:     'revenue',
      tier:      'low',
      observed:  '2026-09-02',
      sourceUrl: 'https://tracenable.com/company/nvidia/ghg-emissions',
    },
  },
  [ASSET_IDS.sMSFT]: {
    symbol:    'sMSFT',
    name:      'Synthetic Microsoft Corp.',
    category:  'equity',
    regulated: true,
    icon:      '🪟',
    provenance: {
      referenceId: 'NASDAQ: MSFT · Microsoft Corporation',
      priceFeed:   'yahoo',
      priceSymbol: 'MSFT',
    },
    carbon: {
      intensity: 10.226,
      basis:     'revenue',
      tier:      'high',
      observed:  '2026-09-02',
      sourceUrl: 'https://ditchcarbon.com/organizations/microsoft',
    },
  },
  [ASSET_IDS.sGOOGL]: {
    symbol:    'sGOOGL',
    name:      'Synthetic Alphabet Inc.',
    category:  'equity',
    regulated: true,
    icon:      '🔍',
    provenance: {
      referenceId: 'NASDAQ: GOOGL · Alphabet Inc. Class A',
      priceFeed:   'yahoo',
      priceSymbol: 'GOOGL',
    },
    carbon: {
      intensity: 8.949,
      basis:     'revenue',
      tier:      'high',
      observed:  '2026-09-02',
      sourceUrl: 'https://tracenable.com/company/alphabet/ghg-emissions',
    },
  },
  [ASSET_IDS.sICLN]: {
    symbol:    'sICLN',
    name:      'Synthetic iShares Clean Energy ETF',
    category:  'etf',
    regulated: true,
    icon:      '🌿',
    provenance: {
      referenceId: 'NASDAQ: ICLN · iShares Global Clean Energy ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'ICLN',
    },
    carbon: {
      intensity: null,
      basis:     'qualitative',
      tier:      'low',
      observed:  '2026-09-02',
      sourceUrl: 'https://www.ishares.com/us/literature/fact-sheet/icln-ishares-global-clean-energy-etf-fund-fact-sheet-en-us.pdf',
    },
  },
  [ASSET_IDS.sESGU]: {
    symbol:    'sESGU',
    name:      'Synthetic iShares MSCI USA ESG ETF',
    category:  'etf',
    regulated: true,
    icon:      '🌱',
    provenance: {
      referenceId: 'ESGU · iShares ESG Aware MSCI USA ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'ESGU',
    },
    carbon: {
      intensity: 4.34,
      basis:     'revenue',
      tier:      'mid',
      observed:  '2026-09-02',
      sourceUrl: 'https://www.ishares.com/us/literature/fact-sheet/esgu-ishares-esg-aware-msci-usa-etf-fund-fact-sheet-en-us.pdf',
    },
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
