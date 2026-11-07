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
    heading: 'Why PepeFi',
    painLabel: 'The problem',
    solutionLabel: 'What we do',

    social: {
      title: 'Social Trading: Every Move On-Chain',
      pain: "Copy-trading platforms publish traders' track records themselves, so losing trades can be deleted or hidden and followers have no way to check. Traders face no consequences for losing, and your money has to sit with the platform first — if the platform fails, it is gone.",
      solution:
        'Every position and every strategy version a trader makes is recorded on-chain, so the leaderboard can be checked. Traders must stake before anyone can copy them, and when a follower stops copying with a loss past the threshold, part of the trader\'s stake is slashed. A new version is marked "Strategy updated", and you can also switch on auto-sync. Positions opened by copy trading are in your own name, and stopping copying closes them all in one click.',
    },

    assets: {
      title: 'Four Asset Classes, One Wallet',
      pain: 'Equities, bonds, gold and crypto are spread across brokers, banks and exchanges — several accounts and several apps, plus minimums and account requirements for overseas markets. Seeing your whole allocation at once is hard.',
      solution:
        'From one wallet, buy small amounts of 11 tokenized assets: equities such as Apple, Tesla and NVIDIA, bonds, gold, BTC, ETH and ESG ETFs. Portfolio groups your allocation and value into equities, bonds, gold and crypto, next to the S&P 500, US Treasuries, gold and BTC; spot holdings have no on-chain cost basis, so profit and loss is not calculated. These are synthetic, price-tracking tokens, not real shares or bonds.',
    },

    transparency: {
      title: 'On-Chain Transparency',
      pain: 'Platforms say they hold reserves, say how revenue is split, and say who absorbs losses — users can only take their word for it, and nobody can check until something breaks.',
      solution:
        "The vault's reserve ratio is computed from on-chain holdings and liabilities, so anyone can work it out. x402 and other revenue is split 70/20/10 by the contract, and the loss-absorption order is public. The operator's remaining powers are listed right below, under Where Your Assets Are.",
    },

    esg: {
      title: 'ESG Without Greenwashing',
      pain: 'ESG ratings use different standards from provider to provider, sources are hidden, and a "green" label is all it takes — and a score changes nothing about what you actually pay.',
      solution:
        'We price on carbon intensity with a unit and a source (for example, emissions per $1M of revenue). Every attestation records who made it, when, and which document they read, and it expires. When attestors disagree, the screen shows the disagreement instead of averaging it away. The carbon tier sets fees and leverage caps — higher carbon costs more — and an asset with no data is priced at the most conservative tier.',
    },

    gamefi: {
      title: 'GameFi: Raise Your Pepe',
      pain: 'Investing apps feel cold: newcomers do not know where to start, and there is little reason to keep coming back.',
      solution:
        'Every user gets a Pepe that evolves. Spend PEPE coins on potions for XP and on skin draws, and unlock mounts as you reach set levels. PEPE spent on skins is burned. Daily quests walk you through the platform step by step, and achievements mark good habits such as diversifying and investing low-carbon.',
    },

    agent: {
      title: 'Agent-Native: x402 and Agent Sessions',
      pain: 'Letting an AI trade for you means handing over a private key or an exchange API key, with no cap on what it can spend. Buying data for an AI means registering an account, adding a credit card and paying a monthly subscription.',
      solution:
        'An agent session lets an AI trade for you within limits written on-chain: per-trade amount, total budget, leverage cap, allowed assets and an expiry. You can revoke it at any time, and the AI never gets your main wallet\'s private key. AIs pay USDC per call for trading signals with x402 — no account needed — and the revenue is split on-chain too.',
    },

    perpetuals: {
      title: 'Advanced: Synthetic Perpetuals (optional)',
      pain: 'You want to hedge long against short without stumbling into high leverage.',
      solution: 'Synthetic perpetuals with leverage off by default, settled transparently on-chain.',
    },
  },

  steps: {
    heading: 'How to Get Started',
    one: 'Install MetaMask, switch to the Base Sepolia testnet, and claim a little test ETH from a public faucet for gas',
    two: 'On the Exchange page, click "Claim USDC" for test funds',
    three: 'Go to Assets, buy XAU and BGRN, then check Portfolio for the allocation and value across all four classes',
    four: "Check traders' on-chain records and carbon tier mix on Marketplace, and copy one — or register as a trader on the Trader page",
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
    paperMid: ' for simulated trading, so users can try RWA investing and AI agent trading without spending real money. ',
  },

  oracleDisclosure: 'Prices reference real markets and are written on-chain by the operator (oracle); during market closures they stay at the last price',

  /** 首頁最上方的即時 KPI 條（HeroKpiStrip）。網路名稱、chainId 是技術識別碼，不譯。 */
  liveOn: 'Running on the Base Sepolia testnet · 84532',
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
      'Pick a trader and see every position, every strategy version and its carbon tier mix before you decide to copy. ',
    heroBold: 'Positions opened by copy trading are in your own name',
    heroAfter:
      ', and only you can stop copying. Tokenized equities, bonds, gold and crypto — every step checkable on-chain. This is a testnet demo: most traders listed are simulated accounts run by programs, not real people.',

    paperBefore: 'This platform uses ',
    paperBold1: 'testnet tokens',
    paperMid:
      ' for simulated trading, letting users try social copy trading, RWA investing, and AI agent trading without spending real money. ',
    paperBold2: 'Prices reference real markets',
    paperAfter:
      ", and the operator writes them on-chain. The funds are simulated assets and no real money is involved, much like Paper Trading.",
  },
};
