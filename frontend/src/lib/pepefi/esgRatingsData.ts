import { ASSET_IDS } from 'src/contracts/addresses'

import type { EsgRating } from './esgRatings'

// issue #383：第三方 ESG 評級，2026-10-29 逐筆在原始頁面上手動查詢後填入，不是爬蟲抓的。
// 只放評級機構自己公布的值；平台不換算、不平均、不補分數。要更新就重查一次原始頁面，
// 連同評級日與查詢日一起改。
//
// 這次沒放進來的來源與原因（寫在這裡，免得下次又重查一輪）：
// - Sustainalytics：sustainalytics.com 的公司評級頁與 Yahoo Finance 的 Sustainability 分頁
//   都已導回產品頁，2026-10-29 查不到任何公開的個別公司評級。
// - MSCI 公司評級：ESG Ratings & Climate Search Tool 已改成只給 MSCI ONE 客戶。基金評級還
//   在 iShares 產品頁上，所以 MSCI 只有 ETF 有值（股票標為「未公開」，見 esgRatings.ts）。
// - CDP：網站條款限定分數只能內部、非商業使用。
// - CCData × CCRI 2024-02 版：原報告頁已 404，查不到第一手的值，只用 2023-07 版。
//
// S&P Global 與 MSCI（經 iShares 頁面）的條款都寫明未經同意不得轉載；團隊在 #383 決定以
// 學術、非商業專題的身分照樣顯示並附出處，風險由團隊承擔。

const RETRIEVED = '2026-10-29'

export const ESG_RATINGS: readonly EsgRating[] = [
  // MSCI ESG Fund Rating（AAA–CCC），讀自 iShares 產品頁的 Sustainability Characteristics。
  {
    asset: ASSET_IDS.sICLN, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-23', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.ishares.com/us/products/239738/ishares-global-clean-energy-etf',
  },
  {
    asset: ASSET_IDS.sESGU, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-16', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.ishares.com/us/products/286007/ishares-esg-aware-msci-usa-etf',
  },
  {
    asset: ASSET_IDS.sBOND, provider: 'msci', rating: 'A',
    ratedOn: '2026-10-23', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.ishares.com/us/products/305296/ishares-usd-green-bond-etf',
  },

  // S&P Global ESG Score（0–100，只能跟同產業比）。ratedOn 是頁面上的 Last Updated。
  {
    asset: ASSET_IDS.sAAPL, provider: 'spGlobal', rating: '32',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.spglobal.com/sustainable1/en/scores/results?cid=4004205',
    spGlobal: { underReview: true, csaRespondent: false },
  },
  {
    asset: ASSET_IDS.sNVDA, provider: 'spGlobal', rating: '61',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.spglobal.com/sustainable1/en/scores/results?cid=4094286',
    spGlobal: { underReview: false, csaRespondent: true },
  },
  {
    asset: ASSET_IDS.sMSFT, provider: 'spGlobal', rating: '46',
    ratedOn: '2026-09-22', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.spglobal.com/sustainable1/en/scores/results?cid=4004214',
    spGlobal: { underReview: false, csaRespondent: true },
  },
  {
    asset: ASSET_IDS.sGOOGL, provider: 'spGlobal', rating: '30',
    ratedOn: '2026-10-16', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.spglobal.com/sustainable1/en/scores/results?cid=4633618',
    spGlobal: { underReview: true, csaRespondent: false },
  },
  {
    asset: ASSET_IDS.sTSLA, provider: 'spGlobal', rating: '26',
    ratedOn: '2026-10-01', retrievedOn: RETRIEVED,
    sourceUrl: 'https://www.spglobal.com/sustainable1/en/scores/results?cid=4574287',
    spGlobal: { underReview: false, csaRespondent: false },
  },

  // CCData × CCRI Digital Asset ESG Benchmark（AA–E），2023-07-13 第一版。ETH 的 AA 寫在報告頁
  // 的 Key Takeaways；BTC 的 B 報告頁沒寫，出自同日 CoinDesk 的報導。
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
