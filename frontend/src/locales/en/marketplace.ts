import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/marketplace.ts`。搬移階段逐字複製原文。
 */
export const marketplace: Catalog['marketplace'] = {
  title: '⭐ Star Trader Leaderboard',
  subtitle: 'Browse and copy on-chain verified strategies',

  esgFiltered: '已篩選',
  esgAll: '全部',
  esgButton: 'ESG {state}',

  sort: {
    reputation: 'Sort: Reputation',
    followers: 'Sort: Followers',
    volume: 'Sort: Volume (7d)',
    pnl: 'Sort: PnL (7d)',
    esg: 'Sort: ESG Score',
  },

  refreshAria: '重新整理市集資料',

  livePrices: 'Live Prices',
  loadFailed: 'Failed to load:',

  empty: {
    title: 'No traders yet',
    description:
      'Run SeedWhales to populate the leaderboard, or register a strategy on the Trader page.',
    cta: 'Become a Trader',
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
