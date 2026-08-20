import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/landing.ts`。
 */
export const landing: Catalog['landing'] = {
  tagline: 'DeFi · SocialFi · GameFi · MemeFi 🐸',
  enterDashboard: '🐸 Enter Dashboard',
  viewTraders: 'View Traders',
  connectHint: 'Connect to browse every feature directly — no account required.',

  paperTrading: {
    title: 'What is Paper Trading?',
  },

  features: {
    heading: 'Core Features',

    perpetualsTitle: 'Synthetic CFD Perpetuals',
    perpetualsDesc:
      'Synthetic derivative perpetuals, fully transparent on-chain, with no centralized exchange required.',

    copyTitle: 'One-Click Copy Trading',
    copyDesc:
      'Copy top traders in one click — approve USDC once and positions open automatically, sized to your allocation.',

    esgTitle: 'ESG Scoring',
    esgDesc: 'Every trader carries an ESG score, so investing comes with more accountability and transparency.',

    vaultTitle: 'Insurance Vault',
    vaultDesc:
      'Provide liquidity to earn protocol fees, while it doubles as an insurance pool against extreme losses.',

    x402Title: 'x402 Paid Signals',
    x402Desc: 'Agents bring their own wallet and pay per call for trading signals, with revenue split 70/20/10 on-chain.',

    agentTitle: 'Agent-Native Trading',
    agentDesc:
      'A bounded session key delegation — once an AI agent pays, it can autonomously open limited on-chain positions.',
  },

  steps: {
    heading: 'How to Get Started',
    one: 'Install MetaMask and switch to the Base Sepolia testnet',
    two: 'Go to Exchange and click "Get 1000 USDC" for test funds',
    three: "Go to Marketplace and copy the Demo Alpha trader's strategy",
    four: '(Optional) Register as a trader on the Trader page and publish your strategy',
  },

  oracleDisclosure: 'Oracle prices are controlled by the deployer (admin) and updated live during the demo to show PnL changes',

  /** 首頁最上方的即時 KPI 條（HeroKpiStrip）。網路名稱、chainId 是技術識別碼，不譯。 */
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
      'On-chain perpetuals + an agent economy, built to rival Hyperliquid. 5x leverage synthetic/RWA perpetuals, social copy trading, market-making vaults, plus ',
    heroBold: 'x402 paid signals',
    heroAfter: ' — letting AI agents bring their own wallet, pay, and trade autonomously. Fully transparent on-chain.',

    paperBefore: 'This platform uses ',
    paperBold1: 'testnet tokens',
    paperMid:
      ' for simulated trading, letting users try RWA investing, social copy trading, and AI agent trading risk-free. ',
    paperBold2: 'All prices track real markets',
    paperAfter:
      ", but the funds are simulated assets and no real money is involved — equivalent to TradingView's Paper Trading mode.",
  },
};
