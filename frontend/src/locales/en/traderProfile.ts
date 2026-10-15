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
    showAll: 'Show all {count} versions',
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
    loading: 'Loading slash history…',
    titleOne: 'Slash History ({count} event)',
    titleMany: 'Slash History ({count} events)',
    readFailedTitle: 'Could not read slash history',
    readFailedBody: "The on-chain Slashed events could not be read, so this page cannot tell whether this trader has ever been slashed. Please refresh later.",
    totalFromContract: 'Cumulative slashed amount recorded by the contract: {amount} USDC',
    outsideWindow: 'No Slashed events in the last {span}, but the contract records a cumulative {amount} USDC slashed — it happened before the scan window.',
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
    readError: "Could not read this address's on-chain history. The RPC node may be rate-limiting.",
    scanIncomplete: '{count} block range(s) could not be read — the timeline may be incomplete. Please refresh.',
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
      readFailedTitle: 'Read failed',
      readFailedBody: 'On-chain events could not be read (or were only partly read) — an empty timeline here does not mean there was no activity. Please refresh.',
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

  hero: {
    performanceTitle: 'Track record',
    range: '{from} to {to}',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    winRate: 'Win rate',
    winRateSub: '{count} closed',
    esgCorrelation: 'Correlation with sustainable assets',
    esgCorrelationSub: 'Daily returns vs sESGU',
    avgHold: 'Average hold',
    avgHoldValue: '{days} days',
    equityTitle: 'Equity',
    equityNote: 'Equity = free margin + each position valued at the day\'s price. Borrow fees and funding not yet realised on open positions are left out until the position closes.',
    monthlyTitle: 'Monthly returns',
    exposureTitle: 'Current strategy exposure',
    tradesTitle: 'Positions',
    tradesNote: 'PnL is net: the amount returned on close, less margin and the opening fee. The figure in brackets is the price move before fees and funding.',
    colAsset: 'Asset',
    colSide: 'Side',
    colMargin: 'Margin',
    colOpen: 'Open',
    colClose: 'Close',
    colPnl: 'PnL',
    colProof: 'Transactions',
    long: 'Long',
    short: 'Short',
    stillOpen: 'Open',
    liquidated: 'Liquidated',
    openTx: 'Open transaction',
    closeTx: 'Close transaction',
    publishTx: 'Publish transaction',
    proofLoading: 'Reading from chain…',
    proofFailed: 'This transaction could not be read. After the chain restarts, historical transactions may not be on the node.',
    proofBlock: 'Block {block}',
    proofTime: 'Time {time}',
    proofStatus: 'Status {status}',
    proofSuccess: 'success',
    proofReverted: 'reverted',
    proofLogs: '{count} events',
    riskTitle: 'Risk and trading statistics',
    riskScore: 'Risk score',
    riskScoreScale: '1 lowest, 10 highest',
    riskScoreNote: 'The risk score looks at every daily return over the past year. Sort them from worst to best: the loss on the day at the 5% mark is the one-day 95% value at risk (VaR) — roughly one day in twenty loses more than that.',
    riskScoreBands: 'Each threshold the VaR exceeds adds one level; the thresholds are shown under each box above. They are this platform\'s own, after eToro\'s practice of grading 1–10 on VaR, but not eToro\'s formula. Traders with fewer than 30 days of data are not scored.',
    riskScoreReference: 'For comparison, the platform\'s assets over the past year (2025-10 to 2026-10), without leverage: the green bond ETF (sBOND) is about level 2, the ESG US large-cap ETF (sESGU) about 4, AAPL/GOOGL/MSFT, gold and the clean-energy ETF (sICLN) about 6, BTC and NVDA about 7, TSLA and ETH about 8. Levels 9 and 10 usually take leverage.',
    worstDay: 'Worst day',
    worstWeek: 'Worst week',
    drawdown1y: 'Max drawdown, past year',
    profitableWeeks: 'Profitable weeks',
    tradesPerWeek: 'Trades per week',
    activeSince: 'Trading since',
    topAssets: 'Most traded assets',
    topAssetValue: '{asset} {share}%',
    followersTitle: 'Followers',
  },
};
