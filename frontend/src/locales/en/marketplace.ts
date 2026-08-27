import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/marketplace.ts`。
 */
export const marketplace: Catalog['marketplace'] = {
  title: '⭐ Star Trader Leaderboard',
  subtitle: 'Browse and copy on-chain verified strategies',

  esgFiltered: 'Filtered',
  esgAll: 'All',
  esgButton: 'ESG {state}',

  sort: {
    reputation: 'Sort: Reputation',
    followers: 'Sort: Followers',
    volume: 'Sort: Volume (7d)',
    pnl: 'Sort: PnL (7d)',
    esg: 'Sort: ESG Score',
  },

  refreshAria: 'Refresh marketplace data',

  livePrices: 'Live Prices',
  loadFailed: 'Failed to load:',

  empty: {
    title: 'No traders with a published strategy on this chain yet',
    description:
      'The leaderboard is computed live from on-chain events. Currently connected to {chain}, scanning the last {blocks} blocks. If you expected to see traders, check your wallet is on the right chain.',
    unknownChain: 'Unknown network (chainId {chainId})',
    cta: 'Become a Trader',
    secondaryCta: 'View x402 Docs',
  },

  card: {
    starTrader: '⭐ Star Trader',
    verifiedOnChain: 'Verified On-Chain',
    noName: '—',
    noStrategy: 'No strategy',
    /** 策略籌碼：↑sBTC 50% 3× */
    allocChip: '{side}{asset} {weight}% {leverage}×',

    volLabel: 'Vol 7d',
    pnlLabel: 'PnL 7d',
    followersLabel: 'Followers',
    stakeLabel: 'Stake',

    slashed: '⚠ {amount} USDC slashed',

    profile: 'Profile',
    copy: 'Copy →',
    noStrategyButton: 'No Strategy',
  },

  /** 頁尾統計。單複數各自是完整的一句話，不是拼接出來的。 */
  footer: {
    countOne: '{count} trader',
    countMany: '{count} traders',
    followersTotal: '{count} total followers',
    starTraderOne: '{count} star trader',
    starTraderMany: '{count} star traders',
    volumeWindow: 'Volume + PnL from last ~{blocks} blocks (~7d)',
  },

  rawData: {
    summary: 'Raw strategy data',
    noStrategy: 'no strategy',
  },
};
