import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/landing.ts`。
 */
export const landing: Catalog['landing'] = {
  tagline: 'Invest alongside transparent traders {brandMark}',
  brandLine: 'Web3 social trading · on Base',
  enterDashboard: '{brandMark} Enter Dashboard',
  viewTraders: 'View Traders',
  connectHint: 'Connect to browse every feature directly — no account required.',

  paperTrading: {
    title: 'What is Paper Trading?',
  },

  features: {
    heading: 'Core Features',

    copyTitle: 'Social Trading',
    copyDesc:
      "Check a trader's on-chain positions, strategy history and ESG score before you decide to copy. Positions opened by copy trading are in your own name, and only you can stop copying.",

    rwaTitle: 'Tokenized RWA',
    rwaDesc:
      'Buy and sell tokenized equities, bonds, gold, and crypto with USDC — minted and redeemed on-chain, with the reserve ratio always visible.',

    transparencyTitle: 'On-Chain Transparency',
    transparencyDesc:
      'Every position, every strategy version and every fee split is recorded on-chain, and anyone can compute the vault’s reserve ratio themselves.',

    esgTitle: 'ESG Scoring',
    esgDesc:
      "Every trader carries an ESG score; each asset's carbon intensity comes with its source, and the carbon tier feeds straight into fees.",

    gamefiTitle: 'GameFi: Raise Your Pepe',
    gamefiDesc:
      'Spend PEPE on potions, skins and mounts for your Pepe, and grow it through daily quests and achievements.',

    perpetualsTitle: 'Advanced: Synthetic Perpetuals (optional)',
    perpetualsDesc:
      'Synthetic perpetuals for anyone who wants to hedge long against short. Leverage is off by default, and everything settles transparently on-chain.',
  },

  steps: {
    heading: 'How to Get Started',
    one: 'Install MetaMask and switch to the Base Sepolia testnet',
    two: 'Go to Exchange and click "Get 1000 USDC" for test funds',
    three: 'Go to Assets, buy sGOLD and sBOND, then check Portfolio for the allocation and PnL across all four classes',
    four: "Switch to Expert Mode, check traders' on-chain records and ESG scores on Marketplace, and copy one — or register as a trader on the Trader page",
  },

  copyOff: {
    tagline: 'RWA · Tokenized Assets · Agent-Native {brandMark}',
    brandLine: 'agent-native tokenized RWA · on Base',
    viewMarketplace: 'Browse Marketplace',
    stepFour: '(Optional) Browse published allocations on Marketplace, or register and publish a strategy on the Trader page',
    heroBefore:
      'One wallet, four asset classes: tokenized equities, bonds, gold, and crypto. On-chain mint and redeem, an allocation marketplace, benchmark comparison, plus ',
    heroBold: 'x402 paid signals',
    heroAfter: ' — letting AI agents bring their own wallet, pay, and trade autonomously. Fully transparent on-chain.',
    paperMid: ' for simulated trading, so users can try RWA investing and AI agent trading without risk. ',
  },

  oracleDisclosure: 'Oracle prices are controlled by the deployer (admin) and updated live during the demo to show PnL changes',

  /** 首頁最上方的即時 KPI 條（HeroKpiStrip）。網路名稱、chainId 是技術識別碼，不譯。 */
  liveOn: 'Live on Base Sepolia · 84532',
  logoAlt: '{name} logo',

  heroKpi: {
    x402Revenue: 'x402 Revenue',
    agentCallsPaid: 'Agent Calls Paid',
    openInterest: 'Open Interest',
    network: 'Network',
    connectHint: 'connect ↗',
  },

  /** #36：主視覺介紹與 Paper Trading 說明，各自拆成 `<b>` 前後的片段。 */
  markup: {
    heroBefore:
      'Pick a trader and see every position, every strategy version and their ESG score before you decide to copy. ',
    heroBold: 'Positions opened by copy trading are in your own name',
    heroAfter:
      ', and only you can stop copying. Tokenized equities, bonds, gold and crypto — every step checkable on-chain.',

    paperBefore: 'This platform uses ',
    paperBold1: 'testnet tokens',
    paperMid:
      ' for simulated trading, letting users try social copy trading, RWA investing, and AI agent trading risk-free. ',
    paperBold2: 'All prices track real markets',
    paperAfter:
      ", but the funds are simulated assets and no real money is involved — equivalent to TradingView's Paper Trading mode.",
  },
};
