import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/esg.ts`。
 */
export const esg: Catalog['esg'] = {
  title: '🌱 ESG Asset Explorer',
  subtitle: 'Environmental · Social · Governance — 11 synthetic assets, on-chain registry',

  connectWallet: 'Connect wallet to load live ESG scores from the on-chain ESGRegistry.',
  wrongNetwork:
    'ESGRegistry is only deployed on Ethereum Sepolia. Connect to Ethereum Sepolia to see live on-chain scores.',
  loadFailed: 'Failed to load ESG data — refresh the page.',

  methodology: {
    title: 'A · ESG Scoring Methodology',
    ratingTable: 'Seven-Tier Rating Table',
  },

  /** 三個維度的名稱，以及各自的檢查項目。 */
  dimension: {
    environmental: 'Environmental',
    environmentalItems: [
      'Carbon footprint & energy mix',
      'Physical climate risk',
      'Land / water use impact',
      'Waste & emission management',
    ],

    social: 'Social',
    socialItems: [
      'Labour practices & worker safety',
      'Community & stakeholder impact',
      'Data privacy & security',
      'Supply chain responsibility',
    ],

    governance: 'Governance',
    governanceItems: [
      'Board independence & diversity',
      'Executive accountability',
      'Disclosure & transparency',
      'Shareholder rights protection',
    ],
  },

  /** 七級評級。代號留在元件裡，這裡是它的名稱與一句話說明。 */
  rating: {
    aaa: 'ESG Champion',
    aaaDesc: 'Best-in-class across all three dimensions',
    aa: 'ESG Leader',
    aaDesc: 'Strong, consistent performance across E, S, and G',
    a: 'ESG Aware',
    aDesc: 'Above-average; room for improvement in one dimension',
    bbb: 'Satisfactory',
    bbbDesc: 'Meets baseline standards; notable gaps remain',
    bb: 'Developing',
    bbDesc: 'Below average; improvement initiatives underway',
    b: 'Below Standard',
    bDesc: 'Significant ESG risks not yet adequately managed',
    ccc: 'High Risk',
    cccDesc: 'Material ESG concerns with limited mitigation evidence',

    /** 門檻那一格：有下限就寫下限，最後一級寫上限。 */
    atLeast: '≥ {min}',
    below30: '< 30',
  },

  ranking: {
    title: 'B · 11-Asset ESG Ranking (composite, high to low)',
    rank: '#{n}',
    outOf: '/ 100',
  },

  radar: {
    title: 'C · E/S/G Radar Chart',
    noData: 'No data — connect wallet on Ethereum Sepolia',
    composite: 'Composite',
    hint: 'Click any asset card on the left to update the radar',
  },

  /** 每個標的一句話的評分理由。 */
  rationale: {
    sBTC: 'Proof-of-work energy intensity dominates an otherwise permissionless, decentralized governance model.',
    sETH: 'The PoS Merge cut energy use 99.95%; transparent on-chain governance and an inclusive developer culture lift all dimensions.',
    sAAPL:
      'Carbon-neutrality supply chain commitment and strong board independence; minor labour concerns in manufacturing cap the S score.',
    sTSLA:
      'EV mission drives E above industry average; CEO governance controversy and workforce-relations incidents weigh on S and G.',
    sGOLD:
      'Mining causes significant land disruption and CO₂; adoption of Responsible Mining standards remains uneven across producers.',
    sBOND:
      'US Treasuries carry no direct environmental impact and are backed by top-tier sovereign governance and social-stability mandates.',
    sNVDA:
      'Data-center GPU power demand is high, offset by an AI-efficiency roadmap; semiconductor-industry governance standards are above average.',
    sMSFT:
      'Carbon-negative pledge, 100 % renewable electricity target, and robust board governance deliver near-champion ESG performance.',
    sGOOGL:
      "World's largest corporate renewable-energy buyer (E↑); antitrust investigations and data-privacy controversies moderately restrain S and G.",
    sICLN:
      'Tracks global clean-energy producers; near-perfect E score; land use and grid-stability considerations create nuanced social exposure.',
    sESGU:
      'Broad MSCI USA ESG-screened index delivers top-quartile performance across all three dimensions with strong sector diversification.',
  },
};
