import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/landing.ts`。
 */
export const landing: Catalog['landing'] = {
  tagline: 'Invest alongside transparent strategy sharers {brandMark}',
  brandLine: 'A digital-asset platform that helps everyday people invest · on Base',
  enterDashboard: '{brandMark} Enter Dashboard',
  viewTraders: 'View Strategy Sharers',
  connectHint: 'Connect to browse every feature directly — no account required.',

  paperTrading: {
    title: 'How do prices and funds work?',
  },

  features: {
    heading: 'Why PepeFi',
    painLabel: 'The problem',
    solutionLabel: 'What we do',

    social: {
      title: 'Social Investing: Every Move On-Chain',
      pain: "Copy investing platforms publish track records themselves, so losing investments can be deleted or hidden and followers have no way to check. People sharing strategies face no consequences for losing, and your money has to sit with the platform first — if the platform fails, it is gone.",
      solution:
        'Every investment and every strategy version a strategy sharer makes is recorded on-chain, so the leaderboard can be checked. Strategy sharers must place a performance deposit before anyone can follow them, and when a follower stops following with a loss past the threshold, part of the strategy sharer\'s deposit is taken as a penalty. A new version is marked "Strategy updated", and you can also switch on auto-sync. Assets bought through copy investing are in your own name, and stopping following sells them all in one click.',
    },

    assets: {
      title: 'Four Asset Classes, One Wallet',
      pain: 'Equities, bonds, gold and crypto are spread across brokers, banks and exchanges — several accounts and several apps, plus minimums and account requirements for overseas markets. Seeing your whole allocation at once is hard.',
      solution:
        'From one wallet, buy small amounts of 11 tokenized assets: equities such as Apple, Tesla and NVIDIA, bonds, gold, BTC, ETH and ESG ETFs. Portfolio groups your allocation and value into equities, bonds, gold and crypto, next to the S&P 500, US Treasuries, gold and BTC; these holdings have no on-chain cost basis, so profit and loss is not calculated. These tokens only track prices; they are not real shares or bonds.',
    },

    transparency: {
      title: 'On-Chain Transparency',
      pain: 'Platforms say they hold reserves, say how revenue is split, and say who absorbs losses — users can only take their word for it, and nobody can check until something breaks.',
      solution:
        "The vault's reserve ratio is computed from on-chain holdings and liabilities, so anyone can work it out. x402 and other revenue is split 70/20/10 by public on-chain rules, and the loss-absorption order is public. The operator's remaining powers are listed right below, under Where Your Assets Are.",
    },

    esg: {
      title: 'ESG Without Greenwashing',
      pain: 'ESG ratings use different standards from provider to provider, sources are hidden, and a "green" label is all it takes — and a score changes nothing about what you actually pay.',
      solution:
        'We price on carbon intensity with a unit and a source (for example, emissions per $1M of revenue). Every attestation records who made it, when, and which document they read, and it expires. When attestors disagree, the screen shows the disagreement instead of averaging it away. The carbon tier sets fees — higher carbon costs more — and an asset with no data is priced at the most conservative tier.',
    },

    gamefi: {
      title: 'GameFi: Raise Your Pepe',
      pain: 'Investing apps feel cold: newcomers do not know where to start, and there is little reason to keep coming back.',
      solution:
        'Every user gets a Pepe that evolves. Spend PEPE coins on potions for XP and on skin draws, and unlock mounts as you reach set levels. PEPE spent on skins is burned. Daily quests walk you through the platform step by step, and achievements mark good habits such as diversifying and investing low-carbon.',
    },

    agent: {
      title: 'Agent-Native: x402 and AI Agent Allowances',
      pain: 'Letting an AI invest for you means handing over a private key or a platform API key, with no cap on what it can spend. Buying data for an AI means registering an account, adding a credit card and paying a monthly subscription.',
      solution:
        'An AI agent allowance lets an AI buy and sell for you within limits written on-chain: per-order amount, total budget, allowed assets and an expiry. You can revoke it at any time, and the AI never gets your main wallet\'s private key. AIs pay USDC per call for investing signals with x402 — no account needed — and the revenue is split on-chain too.',
    },

    perpetuals: {
      title: 'Advanced features (optional)',
      pain: 'You want to prepare for both rises and falls without taking on too much risk from the start.',
      solution: 'Advanced features are off by default and stay fully transparent on-chain when switched on.',
    },
  },

  steps: {
    heading: 'How to Get Started',
    one: 'Install MetaMask, switch to Base Sepolia, and claim a little ETH from a public faucet for gas',
    two: 'On the Exchange page, click "Claim USDC" to get USDC',
    three: 'Go to Assets, buy XAU and BGRN, then check Portfolio for the allocation and value across all four classes',
    four: "Check strategy sharers' on-chain records and carbon tier mix on the Strategy Marketplace and follow one with copy investing — or register as a strategy sharer on your strategy sharer page",
  },

  copyOff: {
    tagline: 'RWA · Tokenized Assets · Agent-Native {brandMark}',
    brandLine: 'agent-native tokenized RWA · on Base',
    viewMarketplace: 'Browse Marketplace',
    stepFour: '(Optional) Browse published allocations on Allocations, or register and publish a strategy on your strategy sharer page',
    heroBefore:
      'One wallet, four asset classes: tokenized equities, bonds, gold, and crypto. On-chain mint and redeem, an allocation marketplace, benchmark comparison, plus ',
    heroBold: 'x402 paid signals',
    heroAfter: ' — letting AI agents bring their own wallet, pay, and buy and sell on their own within the allowance you set. Fully transparent on-chain.',
    paperMid: ' to settle RWA investing and AI agent investing. ',
  },

  oracleDisclosure: 'Prices reference real markets and are written on-chain by the operator\'s price source program; during market closures they stay at the last price',

  /** 首頁最上方的即時 KPI 條（HeroKpiStrip）。網路名稱、chainId 是技術識別碼，不譯。 */
  liveOn: 'Running on Base Sepolia · 84532',
  logoAlt: '{name} logo',

  heroKpi: {
    x402Revenue: 'x402 Revenue',
    agentCallsPaid: 'Agent Calls Paid',
    openInterest: 'Total Currently Invested',
    network: 'Network',
    connectHint: 'connect ↗',
  },

  /** #36：主視覺介紹與 Paper Trading 說明，各自拆成 `<b>` 前後的片段。 */
  markup: {
    heroBefore:
      'Pick a strategy sharer and see every investment, every strategy version and its carbon tier mix before you decide on copy investing. ',
    heroBold: 'Assets bought through copy investing are in your own name',
    heroAfter:
      ', and only you can stop following. Tokenized equities, bonds, gold and crypto — every step checkable on-chain. Most strategy sharers listed are simulated accounts run by programs, not real people.',

    paperBefore: 'This platform uses ',
    paperBold1: 'on-chain tokens',
    paperMid:
      ' to settle copy investing, RWA investing, and AI agent investing. ',
    paperBold2: 'Prices reference real markets',
    paperAfter:
      ', and the operator\'s price source program writes them on-chain.',
  },
};
