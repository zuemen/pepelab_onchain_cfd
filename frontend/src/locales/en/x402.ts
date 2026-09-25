import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/x402.ts`。
 */
export const x402: Catalog['x402'] = {
  docs: {
    title: 'x402: let your AI assistant pay for trading data on its own',
    testnetChip: 'Testnet · no real money',
    lead: 'When your AI trading assistant needs data, there is no account to sign up for and no monthly subscription — each time it wants one piece, it pays a few cents from its own wallet (from $0.01) and gets the data on the spot.',

    benefits: {
      payPerUse: {
        title: 'Pay only for what you use',
        body: 'A trader signal costs $0.01 and a live market snapshot $0.005. No monthly fee, no minimum spend.',
      },
      autonomous: {
        title: 'Your assistant handles it',
        body: 'Paying, fetching the data and deciding whether to trade all happen automatically. When a signal is too weak, the assistant can choose not to trade and only spends the data fee.',
      },
      transparent: {
        title: 'Where the money goes is public',
        body: 'Of every payment, 70% goes to the trader who provided the signal, 20% to the platform and 10% to the insurance vault. The split is recorded on-chain for anyone to check.',
      },
    },

    how: {
      heading: 'How one purchase works',
      ask: { title: 'The assistant asks', body: 'Your assistant asks PepeLab for a piece of data, such as a trader’s next move.' },
      quote: { title: 'PepeLab quotes a price', body: 'The service replies: "This one is $0.01, payable in Circle USDC."' },
      pay: {
        title: 'It pays and gets the data',
        body: 'The assistant signs a payment from its own wallet and receives the data as soon as the payment is confirmed. It takes a few seconds and nobody has to click anything.',
      },
    },

    product: {
      heading: 'What you can buy',
      perCall: '/ call',
      signalsName: 'Trader signal',
      signals: 'Pick a trader and get their next move: direction, asset and confidence.',
      oracleName: 'Live market snapshot',
      oracle: 'An asset’s current index price, mark price and funding rate.',
    },

    split: {
      title: 'How revenue is split (live on-chain figures)',
      accrued: 'On-chain accrued revenue',
      calls: 'Purchases: {count}',
      callsUnknown: 'purchase count not tracked on-chain',
      traders: 'Traders',
      platform: 'Platform',
      vault: 'Insurance vault',
      /** 圖例是「名稱 + 百分比」，百分比是資料不是文字，所以只留名稱。 */
      share: '{label} {pct}%',
    },

    tryBuy: {
      title: 'Try it free first (no wallet needed)',
      description:
        'Click the button to see what a real, live signal looks like, for free. The trial pays nothing and moves no money; the revenue figures above come only from real paid purchases.',
      busy: 'Fetching…',
      cta: 'See a signal for free',
      resultCaption: 'The raw data your assistant would receive:',
      failed: 'The trial fetch failed',
      networkError: 'Could not reach the signal service. Please try again later.',
      settled: '70/20/10 settled on-chain · ',
      viewSettlement: 'View this split on BaseScan ↗',
    },

    start: {
      heading: 'How to get started',
      note: 'For now, step 3 needs a friend or developer who can run a script; enabling an assistant with one click inside the app is still being planned.',
      wallet: {
        title: 'Set up a test wallet',
        body: 'Install a wallet such as MetaMask, create a brand-new account and switch it to the Base Sepolia testnet. Don’t use a wallet that holds real assets.',
      },
      fund: {
        title: 'Get free test tokens',
        body: 'At Circle’s testnet faucet, choose Base Sepolia and claim Circle USDC to pay for data. Then claim a little ETH from any Base Sepolia faucet to cover on-chain fees (gas).',
        link: 'Open the Circle faucet ↗',
      },
      connect: {
        title: 'Hand the wallet to your assistant',
        body: 'A developer follows the example in the "For developers" section below to give this wallet to the assistant program. From then on, the assistant pays for data by itself.',
      },
      track: {
        title: 'Check spending any time',
        body: 'Every payment leaves a public record. Paste the wallet address into BaseScan to see each one your assistant made.',
      },
    },

    faq: {
      heading: 'Common questions',
      spend: {
        q: 'Could my assistant overspend?',
        a: 'It can only spend what is in that wallet. Put in just the amount you’re comfortable with — 1 Circle USDC already buys 100 signals.',
      },
      trade: {
        q: 'Will my assistant trade for me?',
        a: 'It can be set up to. Trades use your margin on the exchange and stay within limits you authorise in advance: a per-trade cap, a total budget, a leverage cap and an expiry date, all enforced by the contract. Anything beyond them is rejected.',
      },
      real: {
        q: 'Is this real money?',
        a: 'No. It runs on the Base Sepolia testnet, and test tokens from a faucet have no real value.',
      },
    },

    advanced: {
      summary: 'For developers: technical parameters and code examples',
      hint: 'Everyday users can skip this section.',
      fact: {
        baseUrl: 'Base URL',
        network: 'Network',
        asset: 'Asset',
        assetValue: 'Circle USDC {address} (6-dec, EIP-3009)',
        router: 'x402 router',
        pricing: 'Pricing',
        pricingValue: 'GET /signals/:trader → $0.01 · GET /oracle/:asset → $0.005',
      },
      step1: '1) Explore (free)',
      step2: '2) Pay to buy (x402-fetch + viem)',
      flow: 'Flow: GET → receive a 402 (with accepts: network/asset/payTo/price) → sign an EIP-3009 transferWithAuthorization with Circle USDC → resend with X-PAYMENT → 200 + signal + settlement tx.',
      networkErrorHint: 'If the free trial cannot connect, check that the API is deployed and VITE_SIGNAL_API_URL is set.',
    },

    footer:
      'Testnet demo environment (Base Sepolia); the settlement key is for demo purposes only and holds no real assets. The on-chain revenue-split figures are read live. Payments are settled by the public x402.org facilitator, which pays that gas; this project does not run its own facilitator.',
  },

  /** 首頁那張把人帶到文件頁的卡片。 */
  card: {
    title: '⚡ x402 Signal Marketplace',
    chip: 'pay-per-call',
    description:
      'Any agent holding Circle USDC on Base Sepolia can pay to buy signals ($0.01/$0.005), with revenue split 70/20/10 on-chain.',
    accrued: 'On-chain accrued: ${feeUsd} in revenue · ${traderShare} to traders (70%)',
    busy: 'Fetching…',
    tryBuy: 'Try free',
    docs: 'API Docs',
    settled: '✓ Settled on-chain:',
    viewSettlement: 'BaseScan settlement tx ↗',
    apiUnreachable: 'API not reachable (VITE_SIGNAL_API_URL?)',
  },
};
