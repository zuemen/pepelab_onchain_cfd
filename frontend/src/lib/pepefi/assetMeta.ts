import { ASSET_IDS } from 'src/contracts/addresses'
import { chainMap } from 'src/contracts/deployment'

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
   *  - `qualitative`  依類別組成判定,沒有計算出來的數字(sBOND)
   */
  basis: 'revenue' | 'absolute' | 'qualitative'
  /** 對齊 carbon.ts 的 Tier;`revenue` 基準的資產,這個值必須等於 `tierOf(intensity, true)`。 */
  tier: Tier
  /** 見證觀測日,ISO `YYYY-MM-DD`;沒有可稽核來源時為 `'—'`(視同過期 → 未評等)。 */
  observed: string
  /** 出處網址——使用者自己去查證那個數字的地方,不是「相信平台」。 */
  sourceUrl: string
}

/**
 * 發行方自己公布的轉型資訊(追蹤指數、產業組成、隱含升溫、SDG)的出處。文字在
 * catalog 的 `tokens.provenance.transition.assets`。這是轉述,不是平台的評分,
 * 也不進定價——費率與槓桿只讀碳分級(ADR-003)。碳分級量的是成分公司自己的營運
 * 排放,這裡講的是它在做什麼;兩件事並排顯示,不合成一個分數
 * (docs/data/carbon-tier-etf-waci.md)。沒有發行方揭露的資產不帶這個欄位。
 */
export interface AssetTransition {
  /** 讀取發行方資料的日期,ISO `YYYY-MM-DD`。 */
  observed:  string
  sourceUrl: string
}

export interface AssetMeta {
  /**
   * 鏈上識別碼:合成代幣的 ERC-20 symbol(sETH)、ASSET_IDS 與 catalog 的鍵。
   * 只拿來查表、加進錢包,不上畫面——畫面顯示的是 `ticker`。
   */
  symbol:    string
  /**
   * 畫面上的代號:標的在真實世界的代號(sETH → ETH、sGOLD → XAU、sBOND → BGRN)。
   * 黃金與綠債不是把 s 拿掉——GOLD 是 Barrick Gold、BOND 是 PIMCO 的 ETF,
   * 兩個都是別的真實證券。見 ADR-0002 規則 1。
   */
  ticker:    string
  /** 標的原名(英文),不帶「Synthetic」。中文名稱在 catalog 的 tokens.assetName。 */
  name:      string
  category:  AssetCategory
  regulated: boolean  // equity / bond / ETF — requires KYC gate
  /** issue #100 ①。ASSET_IDS 裡的每一顆都有;PEPE(工具代幣,非追蹤標的)沒有。 */
  provenance?: AssetProvenance
  carbon?:     AssetCarbon
  transition?: AssetTransition
}

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  crypto:    'Crypto',
  equity:    'Equity',
  etf:       'ETF',
  commodity: 'Commodity',
  bond:      'Bond',
}

// 碳強度數字、門檻與出處全部對齊 docs/data/carbon-intensity.md（issue #94 的
// 蒐集產出，2026-09-02 擷取；sICLN、sESGU 於 2026-10-16 改用 iShares 自己公布的
// MSCI 持股加權碳強度）。營收基準的資產（equity / 兩檔股票 ETF）的 `tier`
// 必須等於 carbon.ts `tierOf(intensity, true)`——assetMeta.test.ts 釘住這件事。
// 非營收基準（黃金、加密）用絕對年排放量 + 產業基準判級，不套 tierOf。
//
// referenceId 只放可自行查證的識別碼（交易所 + 代號、加密網路），不放中文——
// 顯示用的標的說明、出處名稱、已知限制在 catalog 的 tokens.provenance.assets。

export const ASSET_META: Record<string, AssetMeta> = {
  [ASSET_IDS.sBTC]: {
    symbol:    'sBTC',
    ticker:    'BTC',
    name:      'Bitcoin',
    category:  'crypto',
    regulated: false,
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
    ticker:    'ETH',
    name:      'Ethereum',
    category:  'crypto',
    regulated: false,
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
    ticker:    'AAPL',
    name:      'Apple Inc.',
    category:  'equity',
    regulated: true,
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
    ticker:    'TSLA',
    name:      'Tesla Inc.',
    category:  'equity',
    regulated: true,
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
    ticker:    'XAU',
    name:      'Gold',
    category:  'commodity',
    regulated: false,
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
    ticker:    'BGRN',
    name:      'iShares USD Green Bond ETF',
    category:  'bond',
    regulated: true,
    provenance: {
      referenceId: 'NASDAQ: BGRN · iShares USD Green Bond ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'BGRN',
    },
    carbon: {
      // #106：從追蹤美國公債（無可稽核發行方碳強度來源）換成綠色債券 ETF。
      // 碳資料表的工作預設值是「依資產類別基準的定性判斷」——投資等級綠色債券
      // 基金依 Green Bond Principles 的准入標準，在碳排意圖上結構性地低於未篩選
      // 的債券指數。發行方頁面上的 MSCI 持股加權碳強度是 708.64,但它量的是發行人
      // 整體的營運排放;綠債資金專款用在指名的專案上,所以不採用這個數字——理由在
      // catalog 的 carbonCaveat 寫明,見 docs/data/carbon-tier-etf-waci.md。
      intensity: null,
      basis:     'qualitative',
      tier:      'low',
      observed:  '2026-09-02',
      sourceUrl: 'https://www.ishares.com/us/literature/fact-sheet/bgrn-ishares-usd-green-bond-etf-fund-fact-sheet-en-us.pdf',
    },
    transition: {
      observed:  '2026-10-16',
      sourceUrl: 'https://www.ishares.com/us/literature/presentation/bgrn-impact-report.pdf',
    },
  },
  [ASSET_IDS.sNVDA]: {
    symbol:    'sNVDA',
    ticker:    'NVDA',
    name:      'NVIDIA Corp.',
    category:  'equity',
    regulated: true,
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
    ticker:    'MSFT',
    name:      'Microsoft Corp.',
    category:  'equity',
    regulated: true,
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
    ticker:    'GOOGL',
    name:      'Alphabet Inc.',
    category:  'equity',
    regulated: true,
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
    ticker:    'ICLN',
    name:      'iShares Global Clean Energy ETF',
    category:  'etf',
    regulated: true,
    provenance: {
      referenceId: 'NASDAQ: ICLN · iShares Global Clean Energy ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'ICLN',
    },
    carbon: {
      // iShares 產品頁的 MSCI 持股加權碳強度(2026-09-18,涵蓋 92.81%)。原本依產業組成
      // 質性判為低碳,理由「每營收排放結構性偏低」被這個數字推翻——約 45% 持股是發電業。
      // 見 docs/data/carbon-tier-etf-waci.md。
      intensity: 241.74,
      basis:     'revenue',
      tier:      'high',
      observed:  '2026-10-16',
      sourceUrl: 'https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf',
    },
    transition: {
      observed:  '2026-10-16',
      sourceUrl: 'https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf',
    },
  },
  [ASSET_IDS.sESGU]: {
    symbol:    'sESGU',
    ticker:    'ESGU',
    name:      'iShares ESG Aware MSCI USA ETF',
    category:  'etf',
    regulated: true,
    provenance: {
      referenceId: 'ESGU · iShares ESG Aware MSCI USA ETF',
      priceFeed:   'yahoo',
      priceSymbol: 'ESGU',
    },
    carbon: {
      // iShares 產品頁的 MSCI 持股加權碳強度(2026-09-18,涵蓋 99.73%),取代先前只涵蓋
      // 約 24% 持股(而且剛好是碳強度最低的科技股)的 4.34。
      intensity: 71.05,
      basis:     'revenue',
      tier:      'high',
      observed:  '2026-10-16',
      sourceUrl: 'https://www.ishares.com/us/products/286007/ishares-esg-aware-msci-usa-etf',
    },
    transition: {
      observed:  '2026-10-16',
      sourceUrl: 'https://www.ishares.com/us/products/286007/ishares-esg-aware-msci-usa-etf',
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
// Deriving from the deployment's chain map (CHAIN_MAP for the platform
// deployment; a dedicated tenant has no PepeToken, so nothing is added) means adding a new chain's PepeToken address never
// needs a second edit here, and registering it under every known chain (not
// just whichever one happens to be connected right now) keeps portfolio /
// dashboard lookups working when they read a position's raw asset address —
// which arrives checksummed from ethers, not lowercased — while chains
// vary in whether PepeToken is deployed at all (zero address = not
// deployed, skipped).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
for (const chain of Object.values(chainMap)) {
  if (!chain.PepeToken || chain.PepeToken === ZERO_ADDRESS) continue
  ASSET_META[chain.PepeToken] = {
    symbol:    'PEPE',
    ticker:    'PEPE',
    name:      'Pepe RWA Utility Token',
    category:  'crypto',
    regulated: false,
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
  label:       ASSET_META[id].ticker,    // backward compat
  requiresKYC: ASSET_META[id].regulated, // backward compat
}))

/** id → 畫面代號(ticker)。要查表用的鏈上 symbol 請讀 ASSET_META[id].symbol。 */
export const ASSET_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_META).map(([id, m]) => [id, m.ticker])
)

const TICKER_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.values(ASSET_META).map((m) => [m.symbol, m.ticker])
)

/**
 * 鏈上 symbol → 畫面代號(sETH → ETH)。手上只有 AssetSymbol 的畫面走這裡。
 * 不認得的原樣回傳:USDC、PEPE、已經是 ticker 的字串本來就是畫面代號。
 */
export function tickerOf(symbol: string): string {
  return TICKER_BY_SYMBOL[symbol] ?? symbol
}
