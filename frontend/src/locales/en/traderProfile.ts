import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/traderProfile.ts`。
 */
export const traderProfile: Catalog['traderProfile'] = {
  invalidAddress: 'Invalid address.',
  connectWallet: 'Connect wallet to view strategy sharer profiles.',
  breadcrumbMarketplace: 'Strategy Marketplace',

  header: {
    unknownName: 'Unknown',
    repChip: '◆ {rep} rep',
    /** 粗體數字由元件自己渲染，這裡只是後面接的單複數字尾。 */
    followerSingular: 'follower',
    followerPlural: 'followers',
    registered: 'Registered',
    staked: '◆ Performance deposit paid',
    notStaked: '✗ Performance deposit below the minimum',
    noStrategy: 'No strategy to follow yet 🔒',
    copyThisTrader: 'Follow this strategy sharer →',
  },

  stats: {
    staked: 'Performance deposit',
    followers: 'Followers',
    copiers: 'people copy investing',
    legacyCopiers: 'people copy investing (incl. {count} on the previous on-chain program)',
    earnings: 'Earnings',
    strategies: 'Strategies',
    versions: 'versions',
  },

  strategy: {
    title: 'Latest Strategy',
    empty: 'No strategy published yet.',
    /** 分配標籤：↑ BTC 50% · 3× */
    chip: '{side} {asset} {weight}%',
  },

  history: {
    titleOne: 'Strategy History ({count} version)',
    titleMany: 'Strategy History ({count} versions)',
    /** 摘要行：BTC L 3× · ETH S 2× */
    summaryEntry: '{asset} {side}',
    long: 'Up',
    short: 'Down',

    column: {
      asset: 'Asset',
      carbonTier: 'Carbon tier',
      side: 'Side',
      leverage: 'Multiple',
      weight: 'Weight',
    },
    longLabel: 'Expects rise ↑',
    shortLabel: 'Expects fall ↓',
  },

  followers: {
    titleFirst: 'Followers (first {count})',
  },

  slashHistory: {
    loading: 'Loading penalty history…',
    titleOne: 'Penalty History ({count} record)',
    titleMany: 'Penalty History ({count} records)',
    readFailedTitle: 'Could not read penalty history',
    readFailedBody: "The on-chain penalty records could not be read, so this page cannot tell whether this strategy sharer has ever been penalised. Please refresh later.",
    totalFromContract: 'Total penalties recorded by the on-chain program: {amount} USDC',
    outsideWindow: 'No penalty records in the last {span}, but the on-chain program records {amount} USDC in total penalties — they happened before the scanned range.',
    emptyInWindow: 'No penalty records in the last {span}.',
  },

  deferred: {
    body: 'This section scans on-chain records range by range, which takes a while. Load it when you need it.',
    load: 'Load',
    activityTitle: 'Current Holdings and Activity Timeline',
    slashTitle: 'Penalty History',
  },

  actions: {
    backToMarketplace: '← Back to Strategy Marketplace',
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
      title: 'Current Holdings',
      subtitle: 'read live from the chain · includes holdings older than the scanned range',
      empty: 'No current holdings.',
      readFailed: 'Could not read current holdings. Refresh in a moment. This does not mean there are none.',
      columnSimple: { market: 'Asset', side: 'Direction', notional: 'Current value', pnl: 'P&L' },
      columnExpert: {
        market: 'Asset',
        side: 'Direction',
        entry: 'Buy price',
        mark: 'Current price',
        margin: 'Amount invested',
        notional: 'Current value',
        pnl: 'P&L',
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
      column: { when: 'When', event: 'Event', detail: 'Detail', tx: 'On-chain record' },

      kind: {
        opened: 'Bought',
        closed: 'Sold',
        liquidated: 'Automatically settled',
        following: 'Copy investing',
        followedBy: 'Followed by',
        staked: 'Paid performance deposit',
        slashed: 'Penalised',
      },

      /** 每種事件在「詳情」欄的句子。side 徽章與地址是獨立 JSX，前後才是這裡的字串。 */
      detail: {
        openedTail: '{asset} @ {price} · amount invested {margin}',
        closedTail: ' · received {received}',
        liquidatedBefore: 'Automatically settled, P&L ',
        liquidatedBy: ' by ',
        followingBefore: 'Started copy investing with ',
        followingAfter: ' · amount invested {margin}',
        followedByAfter: ' started copy investing with this strategy sharer · amount invested {margin}',
        stakedBefore: 'Paid performance deposit ',
        slashedBefore: 'Penalised ',
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
    winRateSub: '{count} sold',
    esgCorrelation: 'Correlation with ESG assets',
    esgCorrelationSub: 'Daily returns vs ESGU',
    avgHold: 'Average hold',
    avgHoldValue: '{days} days',
    equityTitle: 'Equity',
    equityNote: 'Equity = available cash + each investment valued at the day\'s price. Holding costs not yet settled on investments still held are left out until they are sold.',
    monthlyTitle: 'Monthly returns',
    exposureTitle: 'Current strategy holdings',
    tradesTitle: 'Investment record',
    tradesNote: 'P&L is net: the amount returned on selling, less the amount invested and the buying fee. The figure in brackets is the price move before fees.',
    colAsset: 'Asset',
    colSide: 'Side',
    colMargin: 'Amount invested',
    colOpen: 'Bought',
    colClose: 'Sold',
    colPnl: 'P&L',
    colProof: 'On-chain records',
    long: 'Expects rise',
    short: 'Expects fall',
    stillOpen: 'Still held',
    liquidated: 'Automatically settled',
    openTx: 'Buy record',
    closeTx: 'Sell record',
    publishTx: 'Publish record',
    proofLoading: 'Reading from chain…',
    proofFailed: 'This record could not be read. After the chain restarts, historical records may not be on the node.',
    proofBlock: 'Block {block}',
    proofTime: 'Time {time}',
    proofStatus: 'Status {status}',
    proofSuccess: 'success',
    proofReverted: 'reverted',
    proofLogs: '{count} events',
    simDate: 'Simulated {date}',
    chainTime: 'On-chain {time}',
    tradesNoteCompressed: 'Dates are simulated dates; the on-chain time is the day of the replay on Base Sepolia. Click a record ID to check it on BaseScan.',
    riskTitle: 'Risk and investing statistics',
    riskScore: 'Risk score',
    riskScoreScale: '1 lowest, 10 highest',
    riskScoreNote: 'The risk score looks at every daily return over the past year. Sort them from worst to best: the loss on the day at the 5% mark is the one-day 95% value at risk (VaR) — roughly one day in twenty loses more than that.',
    riskScoreBands: 'Each threshold the VaR exceeds adds one level; the thresholds are shown under each box above. They are this platform\'s own, after eToro\'s practice of grading 1–10 on VaR, but not eToro\'s formula. Strategy sharers with fewer than 30 days of data are not scored.',
    riskScoreReference: 'For comparison, the platform\'s assets over the past year (2025-10 to 2026-10): the green bond ETF (BGRN) is about level 2, the ESG US large-cap ETF (ESGU) about 4, AAPL/GOOGL/MSFT, gold and the clean-energy ETF (sICLN) about 6, BTC and NVDA about 7, TSLA and ETH about 8.',
    worstDay: 'Worst day',
    worstWeek: 'Worst week',
    drawdown1y: 'Max drawdown, past year',
    profitableWeeks: 'Profitable weeks',
    tradesPerWeek: 'Buys and sells per week',
    activeSince: 'Investing since',
    topAssets: 'Most invested assets',
    topAssetValue: '{asset} {share}%',
    followersTitle: 'Followers',
  },
};
