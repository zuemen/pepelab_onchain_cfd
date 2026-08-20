import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/x402.ts`。
 */
export const x402: Catalog['x402'] = {
  docs: {
    title: 'x402 Signal API',
    audienceChip: 'Developers / Agents',
    commerceChip: 'agent-native commerce',

    /** #36：開頭這句夾了兩段 `<b>`，拆成 bold 前後的三個片段。 */
    introBold1: 'Built for developers / AI agents',
    introMid: ', this is a pay-per-call trading signal API. ',
    introBold2: 'The endpoint itself is the product',
    introAfter:
      ' — any agent / CLI holding Circle USDC on Base Sepolia can pay to buy directly, with revenue split 70/20/10 on-chain via FeeRouter.',

    fact: {
      baseUrl: 'Base URL',
      network: 'Network',
      asset: 'Asset',
      assetValue: 'Circle USDC {address} (6-dec, EIP-3009)',
      router: 'x402 router',
      pricing: 'Pricing',
      pricingValue: 'GET /signals/:trader → $0.01 · GET /oracle/:asset → $0.005',
    },

    product: {
      heading: 'Endpoints = Products',
      perCall: '/ call',
      signals: "A specified trader's next move (direction / asset / confidence).",
      oracle: 'A live oracle snapshot for a single asset (index / mark / funding).',
    },

    split: {
      title: 'Live 70/20/10 Revenue Split',
      accrued: 'On-chain accrued revenue',
      calls: 'Calls: {count}',
      traders: 'Traders',
      platform: 'Platform',
      vault: 'Vault',
      /** 圖例是「名稱 + 百分比」，百分比是資料不是文字，所以只留名稱。 */
      share: '{label} {pct}%',
    },

    tryBuy: {
      title: 'Try It Live (no wallet needed)',
      description:
        "Click to have the server's demo wallet cover a $0.01 payment and run the 70/20/10 split on-chain, returning a real settlement tx. (A real external agent brings its own wallet instead — see the example below.)",
      busy: 'Buying… (broadcasting, a few seconds)',
      cta: 'Try buying a signal ($0.01)',
      failed: 'demo buy failed',
      networkError: 'network error — is the API deployed / VITE_SIGNAL_API_URL set?',
      settled: '70/20/10 settled on-chain · ',
      viewSettlement: 'View settlement tx on BaseScan ↗',
    },

    external: {
      divider: 'External agents bring their own wallet',
      step1: '1) Explore (free)',
      step2: '2) Pay to buy (x402-fetch + viem)',
      flow:
        'Flow: GET → receive a 402 (with accepts: network/asset/payTo/price) → sign an EIP-3009 transferWithAuthorization with Circle USDC → resend with X-PAYMENT → 200 + signal + settlement tx.',
    },

    footer:
      'Testnet demo environment (Base Sepolia); the settlement key is for demo purposes only and holds no real assets. The on-chain revenue-split figures are read live.',
  },

  /** 首頁那張把人帶到文件頁的卡片。 */
  card: {
    title: '⚡ x402 Signal Marketplace',
    chip: 'pay-per-call',
    description:
      'Any agent holding Circle USDC on Base Sepolia can pay to buy signals ($0.01/$0.005), with revenue split 70/20/10 on-chain.',
    accrued: 'On-chain accrued: ${feeUsd} in revenue · ${traderShare} to traders (70%)',
    busy: 'Buying…',
    tryBuy: 'Try buying ($0.01)',
    docs: 'API Docs',
    settled: '✓ Settled on-chain:',
    viewSettlement: 'BaseScan settlement tx ↗',
    apiUnreachable: 'API not reachable (VITE_SIGNAL_API_URL?)',
  },
};
