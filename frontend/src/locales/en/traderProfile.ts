import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/traderProfile.ts`。搬移階段逐字複製原文。
 */
export const traderProfile: Catalog['traderProfile'] = {
  invalidAddress: 'Invalid address.',
  connectWallet: 'Connect wallet to view trader profiles.',
  breadcrumbMarketplace: 'Marketplace',

  header: {
    unknownName: 'Unknown',
    repChip: '◆ {rep} rep',
    /** 粗體數字由元件自己渲染，這裡只是後面接的單複數字尾。 */
    followerSingular: 'follower',
    followerPlural: 'followers',
    registered: 'Registered',
    staked: '◆ Staked',
    notStaked: '✗ Not staked',
    noStrategy: 'No Strategy to Copy 🔒',
    copyThisTrader: 'Copy This Trader →',
  },

  stats: {
    staked: 'Staked',
    followers: 'Followers',
    copiers: 'copiers',
    earnings: 'Earnings',
    strategies: 'Strategies',
    versions: 'versions',
  },

  strategy: {
    title: 'Latest Strategy',
    empty: 'No strategy published yet.',
    /** 分配標籤：↑ sBTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  history: {
    titleOne: 'Strategy History ({count} version)',
    titleMany: 'Strategy History ({count} versions)',
    /** 摘要行：sBTC L 3× · sETH S 2× */
    summaryEntry: '{asset} {side} {leverage}×',
    long: 'L',
    short: 'S',

    column: {
      asset: 'Asset',
      esg: 'ESG',
      side: 'Side',
      leverage: 'Lev',
      weight: 'Weight',
    },
    longLabel: 'Long ↑',
    shortLabel: 'Short ↓',
  },

  followers: {
    titleFirst: 'Followers (first {count})',
  },

  slashHistory: {
    titleOne: 'Slash History ({count} event)',
    titleMany: 'Slash History ({count} events)',
  },

  actions: {
    backToMarketplace: '← Back to Marketplace',
    whaleTracker: '🐋 Whale Tracker',
  },
};
