import { ASSET_IDS } from 'src/contracts/addresses'

import type { EsgRating } from './esgRatings'

// issue #383：第三方 ESG 評級，2026-10-29 逐筆在原始頁面上手動查詢後填入，不是爬蟲抓的。
// 只放評級機構自己公布的值；平台不換算、不平均、不補分數。要更新就重查一次原始頁面，
// 連同評級日與查詢日一起改。產業名稱是評級機構自己的分類，照原文保留。
//
// 這次沒放進來的來源與原因（寫在這裡，免得下次又重查一輪）：
// - MSCI 公司評級：ESG Ratings & Climate Search Tool 已改成只給 MSCI ONE 客戶。基金評級還在
//   iShares 產品頁上，所以 MSCI 只有 ETF 有值（股票標為「未公開」，見 esgRatings.ts）。
// - Sustainalytics 自己的網站已不公開個別公司評級，但 Morningstar（母公司）的個股與基金
//   Sustainability 頁仍公開，這裡的 Sustainalytics 欄都讀自 morningstar.com。
// - Bloomberg、WRDS：學校的學術授權，不能放上公開網站。
// - CDP：網站條款限定分數只能內部、非商業使用。
// - CCData × CCRI 2024-02 版：原報告頁已 404，查不到第一手的值，只用 2023-07 版。
//
// 條款：S&P Global、MSCI（經 iShares 頁面）、Morningstar 都寫明未經同意不得轉載；LSEG 寫明
// 非商業用途經書面同意可以公開。團隊在 #383 決定以學術、非商業專題的身分照樣附出處顯示，
// 風險由團隊承擔，並向 LSEG 申請書面同意。

const RETRIEVED = '2026-10-29'

const ishares = (path: string) => `https://www.ishares.com/us/products/${path}`
const mstarStock = (t: string) => `https://www.morningstar.com/stocks/xnas/${t}/sustainability`
const mstarFund = (t: string) => `https://www.morningstar.com/etfs/xnas/${t}/sustainability`
const lsegFinder = (name: string) =>
  `https://www.lseg.com/en/data-analytics/sustainable-finance/sustainability-ratings-and-data?esg=${encodeURIComponent(name)}`
const spGlobal = (cid: number) => `https://www.spglobal.com/sustainable1/en/scores/results?cid=${cid}`

export const ESG_RATINGS: readonly EsgRating[] = [
  // ── MSCI ESG Fund Rating（AAA–CCC），讀自 iShares 產品頁的 Sustainability Characteristics。
  {
    asset: ASSET_IDS.sICLN, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-23', retrievedOn: RETRIEVED, sourceUrl: ishares('239738/ishares-global-clean-energy-etf'),
    detail: { kind: 'msciFund', qualityScore: 7.1, peerPercentile: 53.82, peerCount: 249, waci: 273.17, impliedTemperatureRise: '> 1.5° - 2.0° C', coveragePct: 87.91 },
  },
  {
    asset: ASSET_IDS.sESGU, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-16', retrievedOn: RETRIEVED, sourceUrl: ishares('286007/ishares-esg-aware-msci-usa-etf'),
    detail: { kind: 'msciFund', qualityScore: 7.0, peerPercentile: 93.77, peerCount: 3918, waci: 68.48, impliedTemperatureRise: '> 2.5° - 3.0° C', coveragePct: 99.97 },
  },
  {
    asset: ASSET_IDS.sBOND, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-23', retrievedOn: RETRIEVED, sourceUrl: ishares('305296/ishares-usd-green-bond-etf'),
    detail: { kind: 'msciFund', qualityScore: 6.8, peerPercentile: 77.64, peerCount: 492, waci: 723.06, impliedTemperatureRise: '> 3.0° C', coveragePct: 94.46 },
  },

  // ── Morningstar Sustainalytics ESG Risk Rating（0–100，越低越好，五個風險等級）。
  //    爭議等級畫在圖片裡，數字是對照頁面截圖讀的。
  {
    asset: ASSET_IDS.sAAPL, provider: 'sustainalytics', rating: '16.63',
    ratedOn: '2026-10-28', retrievedOn: RETRIEVED, sourceUrl: mstarStock('aapl'),
    detail: { kind: 'sustainalyticsCompany', category: 'low', controversyLevel: 3, controversyAsOf: '2026-10-08', controversyAreas: ['customer'], topIssues: ['humanCapital', 'businessEthics', 'dataPrivacy'] },
  },
  {
    asset: ASSET_IDS.sNVDA, provider: 'sustainalytics', rating: '14.01',
    ratedOn: '2026-10-28', retrievedOn: RETRIEVED, sourceUrl: mstarStock('nvda'),
    detail: { kind: 'sustainalyticsCompany', category: 'low', controversyLevel: 2, controversyAsOf: '2026-10-08', controversyAreas: ['customer', 'societyCommunity'], topIssues: ['productGovernance', 'humanCapital', 'businessEthics'] },
  },
  {
    asset: ASSET_IDS.sMSFT, provider: 'sustainalytics', rating: '16.52',
    ratedOn: '2026-10-28', retrievedOn: RETRIEVED, sourceUrl: mstarStock('msft'),
    detail: { kind: 'sustainalyticsCompany', category: 'low', controversyLevel: 2, controversyAsOf: '2026-10-08', controversyAreas: ['operations', 'businessEthics', 'employee', 'customer', 'societyCommunity'], topIssues: ['humanCapital', 'dataPrivacy', 'businessEthics'] },
  },
  {
    asset: ASSET_IDS.sGOOGL, provider: 'sustainalytics', rating: '20.91',
    ratedOn: '2026-10-28', retrievedOn: RETRIEVED, sourceUrl: mstarStock('googl'),
    detail: { kind: 'sustainalyticsCompany', category: 'medium', controversyLevel: 4, controversyAsOf: '2026-10-08', controversyAreas: ['customer'], topIssues: ['businessEthics', 'humanCapital', 'dataPrivacy'] },
  },
  {
    asset: ASSET_IDS.sTSLA, provider: 'sustainalytics', rating: '19.04',
    ratedOn: '2026-10-27', retrievedOn: RETRIEVED, sourceUrl: mstarStock('tsla'),
    detail: { kind: 'sustainalyticsCompany', category: 'low', controversyLevel: 3, controversyAsOf: '2026-10-08', controversyAreas: ['employee'], topIssues: ['productGovernance', 'humanCapital', 'carbonProducts'] },
  },

  // ── Morningstar 投資組合 ESG 風險評級（地球數 1–5），以 Sustainalytics 的公司評分為基礎。
  //    頁面標示投資組合與評分都是 2026-08-31。
  {
    asset: ASSET_IDS.sICLN, provider: 'sustainalytics', rating: '4/5',
    ratedOn: '2026-08-31', retrievedOn: RETRIEVED, sourceUrl: mstarFund('icln'),
    detail: { kind: 'morningstarFund', globes: 4, corporateRiskScore: 24.44, corporateRiskScoreHistorical: 24.0, aumCoveragePct: 95.53 },
  },
  {
    asset: ASSET_IDS.sESGU, provider: 'sustainalytics', rating: '4/5',
    ratedOn: '2026-08-31', retrievedOn: RETRIEVED, sourceUrl: mstarFund('esgu'),
    detail: { kind: 'morningstarFund', globes: 4, corporateRiskScore: 18.02, corporateRiskScoreHistorical: 18.11, aumCoveragePct: 99.13 },
  },
  {
    asset: ASSET_IDS.sBOND, provider: 'sustainalytics', rating: '3/5',
    ratedOn: '2026-08-31', retrievedOn: RETRIEVED, sourceUrl: mstarFund('bgrn'),
    detail: { kind: 'morningstarFund', globes: 3, corporateRiskScore: 20.26, corporateRiskScoreHistorical: 19.74, aumCoveragePct: 67.98 },
  },

  // ── LSEG ESG Score（2026 年版，0–5，越高越好），讀自 LSEG 官網的 ESG Scores Finder。
  //    頁面沒有評級日，只標「依公司自行揭露的某年度資料」。
  {
    asset: ASSET_IDS.sAAPL, provider: 'lseg', rating: '3.4',
    ratedOn: null, retrievedOn: RETRIEVED, sourceUrl: lsegFinder('Apple Inc.'),
    detail: {
      kind: 'lseg', fiscalYear: 2025, pillars: { e: 3.5, s: 2.3, g: 4.5 },
      themes: { climateTransition: 5, energyResourceUse: 3, biodiversity: 3, waterUse: 4, wastePollution: 3, labourRelations: 3, healthSafety: 1, humanRightsCommunity: 4, boardManagement: 5, shareholderRights: 5, conductAntiCorruption: 3, taxTransparency: 3 },
      industry: 'Computers, Phones & Household Electronics', rank: 22, rankOf: 117,
    },
  },
  {
    asset: ASSET_IDS.sNVDA, provider: 'lseg', rating: '3.4',
    ratedOn: null, retrievedOn: RETRIEVED, sourceUrl: lsegFinder('NVIDIA Corporation'),
    detail: {
      kind: 'lseg', fiscalYear: 2026, pillars: { e: 2.7, s: 3.7, g: 3.6 },
      themes: { climateTransition: 4, energyResourceUse: 3, biodiversity: 0, waterUse: 3, wastePollution: 2, labourRelations: 3, healthSafety: 4, humanRightsCommunity: 5, boardManagement: 3, shareholderRights: 4, conductAntiCorruption: 2, taxTransparency: 5 },
      industry: 'Semiconductors & Semiconductor Equipment', rank: 46, rankOf: 266,
    },
  },
  {
    asset: ASSET_IDS.sMSFT, provider: 'lseg', rating: '3.1',
    ratedOn: null, retrievedOn: RETRIEVED, sourceUrl: lsegFinder('Microsoft Corporation'),
    detail: {
      kind: 'lseg', fiscalYear: 2025, pillars: { e: 3.0, s: 2.8, g: 3.2 },
      themes: { climateTransition: 3, energyResourceUse: 3, biodiversity: 3, waterUse: 5, wastePollution: 2, labourRelations: 2, healthSafety: 1, humanRightsCommunity: 5, boardManagement: 3, shareholderRights: 5, conductAntiCorruption: 2, taxTransparency: 3 },
      industry: 'Software & IT Services', rank: 80, rankOf: 799,
    },
  },
  {
    asset: ASSET_IDS.sGOOGL, provider: 'lseg', rating: '3.0',
    ratedOn: null, retrievedOn: RETRIEVED, sourceUrl: lsegFinder('Alphabet Inc.'),
    detail: {
      kind: 'lseg', fiscalYear: 2025, pillars: { e: 3.8, s: 1.3, g: 3.5 },
      themes: { climateTransition: 4, energyResourceUse: 3, biodiversity: 3, waterUse: 4, wastePollution: 2, labourRelations: 1, healthSafety: 1, humanRightsCommunity: 2, boardManagement: 5, shareholderRights: 3, conductAntiCorruption: 3, taxTransparency: 3 },
      industry: 'Software & IT Services', rank: 97, rankOf: 799,
    },
  },
  {
    asset: ASSET_IDS.sTSLA, provider: 'lseg', rating: '3.0',
    ratedOn: null, retrievedOn: RETRIEVED, sourceUrl: lsegFinder('Tesla Inc'),
    detail: {
      kind: 'lseg', fiscalYear: 2024, pillars: { e: 2.4, s: 3.3, g: 3.4 },
      themes: { climateTransition: 2, energyResourceUse: 3, biodiversity: 2, waterUse: 3, wastePollution: 2, labourRelations: 3, healthSafety: 3, humanRightsCommunity: 5, boardManagement: 5, shareholderRights: 2, conductAntiCorruption: 3, taxTransparency: 3 },
      industry: 'Automobiles & Auto Parts', rank: 95, rankOf: 296,
    },
  },

  // ── S&P Global ESG Score（0–100，只能跟同產業比）。ratedOn 是頁面上的 Last Updated。
  {
    asset: ASSET_IDS.sAAPL, provider: 'spGlobal', rating: '32',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED, sourceUrl: spGlobal(4004205),
    detail: { kind: 'spGlobal', underReview: true, csaRespondent: false, csaScore: 28, industry: 'Computers & Peripherals and Office Electronics' },
  },
  {
    asset: ASSET_IDS.sNVDA, provider: 'spGlobal', rating: '61',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED, sourceUrl: spGlobal(4094286),
    detail: { kind: 'spGlobal', underReview: false, csaRespondent: true, csaScore: 60, industry: 'Semiconductors & Semiconductor Equipment' },
  },
  {
    asset: ASSET_IDS.sMSFT, provider: 'spGlobal', rating: '46',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED, sourceUrl: spGlobal(4004214),
    detail: { kind: 'spGlobal', underReview: false, csaRespondent: true, csaScore: 43, industry: 'Software' },
  },
  {
    asset: ASSET_IDS.sGOOGL, provider: 'spGlobal', rating: '30',
    ratedOn: '2026-10-16', retrievedOn: RETRIEVED, sourceUrl: spGlobal(4633618),
    detail: { kind: 'spGlobal', underReview: true, csaRespondent: false, csaScore: 27, industry: 'Interactive Media, Services & Home Entertainment' },
  },
  {
    asset: ASSET_IDS.sTSLA, provider: 'spGlobal', rating: '26',
    ratedOn: '2026-10-01', retrievedOn: RETRIEVED, sourceUrl: spGlobal(4574287),
    detail: { kind: 'spGlobal', underReview: false, csaRespondent: false, csaScore: 24, industry: 'Automobiles' },
  },

  // ── CCData × CCRI Digital Asset ESG Benchmark（AA–E），2023-07-13 第一版。ETH 的 AA 寫在報告頁
  //    的 Key Takeaways；BTC 的 B 報告頁沒寫，出自同日 CoinDesk 的報導。
  {
    asset: ASSET_IDS.sETH, provider: 'ccdata', rating: 'AA',
    ratedOn: '2023-07-13', retrievedOn: RETRIEVED,
    sourceUrl: 'https://data.coindesk.com/reports/esg-report-july-2023',
  },
  {
    asset: ASSET_IDS.sBTC, provider: 'ccdata', rating: 'B',
    ratedOn: '2023-07-13', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.coindesk.com/markets/2023/07/13/ethereum-tops-new-crypto-esg-ranking-bitcoin-slammed-for-heavy-energy-usage',
  },
]
