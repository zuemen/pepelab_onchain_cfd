import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/traderProfile.ts`。
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

  /**
   * TraderActivity：目前未平倉部位表 + 動態時間軸，兩張卡都在這裡。
   *
   * side 徽章仍是 `sideLabel()` 回傳的裸英文 LONG/SHORT——那是 `lib/pepefi/whale.ts`
   * 的已知缺口，WhaleFeed / LargestOpenPositions 兩個已搬過的手足元件也是同樣處理
   * 方式，這裡跟著一致，不單獨修。
   *
   * markUnreadTitle / pnlUnreadTitle / missingOne / missingMany / estimatedTime /
   * txAria 直接複用 `whale.largest` 與 `whale.feed` 裡已經存在、逐字相同的句子，
   * 不在這裡另造一份。
   */
  activity: {
    openPositions: {
      title: 'Current Open Positions',
      subtitle: 'read live from the exchange · includes positions older than the scan window',
      empty: 'No open positions.',
      columnSimple: { market: 'Market', side: 'Side', notional: 'Notional', pnl: 'PnL' },
      columnExpert: {
        market: 'Market',
        side: 'Side',
        entry: 'Entry',
        mark: 'Mark',
        margin: 'Margin',
        notional: 'Notional',
        pnl: 'PnL',
      },
    },

    timeline: {
      title: 'Activity Timeline',
      scanning: 'Scanning {done}/{total}',
      noRange: '—',
      emptyTitle: 'No activity found',
      emptyRange: 'No events in blocks {range}.',
      emptyNone: 'Nothing to show yet.',
      column: { when: 'When', event: 'Event', detail: 'Detail', tx: 'Tx' },

      kind: {
        opened: 'Opened',
        closed: 'Closed',
        liquidated: 'Liquidated',
        following: 'Following',
        followedBy: 'Followed by',
        staked: 'Staked',
        slashed: 'Slashed',
      },

      /** 每種事件在「詳情」欄的句子。side 徽章與地址是獨立 JSX，前後才是這裡的字串。 */
      detail: {
        openedTail: '{asset} {leverage}× @ {price} · margin {margin}',
        closedTail: ' · received {received}',
        liquidatedBefore: 'Liquidated at ',
        liquidatedBy: ' by ',
        followingBefore: 'Started copying ',
        followingAfter: ' · margin {margin}',
        followedByAfter: ' started copying this trader · margin {margin}',
        stakedBefore: 'Staked ',
        slashedBefore: 'Slashed ',
      },
    },
  },
};
