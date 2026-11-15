import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/marketplace.ts`。
 */
export const marketplace: Catalog['marketplace'] = {
  title: '⭐ Star Strategy Sharer Leaderboard',
  subtitle: 'Browse strategies published on-chain and pick one for copy investing',
  networkError: 'Network error — check wallet',

  /** See `../zh-TW/marketplace.ts`. */
  hiddenTrader: {
    title: 'This strategy sharer has been withdrawn',
    body: 'This simulated strategy sharer is no longer listed (its strategy basis is no longer used, or it duplicates a more active strategy sharer with the same name). Its on-chain record is not deleted and can still be found in a block explorer; any related investments in your name stay in your portfolio and you can sell them yourself.',
    back: 'Back to the strategy sharer leaderboard',
  },


  sort: {
    score: 'Sort: Score',
    reputation: 'Sort: Reputation',
    followers: 'Sort: Followers',
    volume: 'Sort: Amount invested (7d)',
    pnl: 'Sort: P&L (7d)',
    stake: 'Sort: Performance deposit',
  },

  refreshAria: 'Refresh marketplace data',

  search: {
    placeholder: 'Search name or address…',
    noResults: 'No strategy sharers match "{query}"',
  },

  table: {
    provisional: 'provisional',
    rank: '#',
    trader: 'Strategy sharer',
    score: 'Score',
    reputation: 'Reputation',
    strategy: 'Strategy',
    winRate: 'Win Rate',
    actions: 'Actions',
    insufficientSample: 'Small sample',
    unranked: 'Not enough data to be ranked ({rule})',
    unrankedRuleHistory: 'investing for less than {days} days',
    unrankedRuleTrades: 'fewer than {count} sales',

    tips: {
      rank: 'Only strategy sharers with enough data get a rank (not ranked: {rule}); the rest are listed at the bottom with "—". The top three are on the podium above.',
      score: 'A 0–100 composite: return (40) + win rate (25) + performance deposit (20) + reputation (15), minus up to 20 if penalised. Return and win rate cover the last {days} days. Click a score for the breakdown.',
      strategy: 'The strategy version the strategy sharer has published now: assets, direction (↑ expects rise, ↓ expects fall) and weights. Copy investing follows exactly this version.',
      totalReturn: 'Change in equity over the whole period ({from} to {to}): final equity ÷ starting capital − 1. Equity includes investments still held, valued at each day\'s price.',
      maxDrawdown: 'The largest fall in equity from a previous high during the period. -20% means it once lost a fifth from its peak. Closer to 0 is steadier.',
      sharpe: 'Risk-adjusted return: the average daily return ÷ the standard deviation of daily returns, scaled to a year by √365. Higher means more return for the same volatility; above 1 is generally considered good, and a negative value means the period lost money on average.',
      volume: 'Total amount of new investments bought in the last {days} days (USDC).',
      pnl: 'Realised profit and loss of investments sold in the last {days} days (USDC). Investments still held are not included.',
      winRate: 'Share of investments sold in the last {days} days that made money; the number in brackets is how many were sold. Fewer than 5 is marked "Small sample" and is indicative only.',
      followers: 'People currently copy investing with this strategy sharer, each counted once. Those who have stopped following are not included.',
      stake: 'The performance deposit (USDC) the strategy sharer has placed in the on-chain program. When a follower loses 30% or more, half of that loss is taken as a penalty (at most half the deposit); ⚠ means the strategy sharer has been penalised.',
    },
  },

  scoreBreakdown: {
    returnLabel: 'Return',
    winRateLabel: 'Win Rate',
    slashLabel: 'Penalty deduction',
    totalLabel: 'Total',
    totalValue: '{total} / 100',
    insufficientNote: 'Fewer than 5 sales — win rate is indicative only',
  },

  podium: {
    hiddenIncomplete: 'Some block ranges could not be read, so the 7-day metrics are incomplete; the podium is withheld until a refresh succeeds.',
    heading: '🏆 Top 3 by Current Sort',
    noneQualified: 'No strategy sharer qualifies for a rank yet (not ranked: {rule}), so there are no podium finishers — they\'re still in the table below.',
  },

  loadFailed: 'Failed to load:',
  tradersReadFailed: {
    title: 'Read failed',
    description: 'The strategy sharer list could not be read from the chain — an empty list here does not mean there are no strategy sharers. Please refresh later.',
  },
  scanIncomplete: '{count}/{total} block ranges could not be read; amounts invested and P&L below may be understated.',

  scanProgress: 'Scanning on-chain records... {done}/{total}',

  empty: {
    title: 'No strategy sharers with a published strategy on this chain yet',
    description:
      'The leaderboard is computed live from on-chain records. Currently connected to {chain}, scanning the last {blocks} blocks (~{window}). If you expected to see strategy sharers, check your wallet is on the right chain.',
    unknownChain: 'Unknown network (chainId {chainId})',
    cta: 'Become a Strategy Sharer',
    secondaryCta: 'View x402 Docs',
  },

  card: {
    starTrader: '⭐ Star Strategy Sharer',
    starHint: 'High reputation and many followers. This does not mean good performance.',
    noName: '—',
    noStrategy: 'No strategy',
    /** 策略籌碼：↑BTC 50% 3× */
    allocChip: '{side}{asset} {weight}%',

    volLabel: 'Invested 7d',
    pnlLabel: 'P&L 7d',
    followersLabel: 'Followers',
    legacyFollowers: 'incl. {count} legacy',
    legacyFollowersTip: '{count} of these followers use the previous on-chain program: investments stay in the follower’s own account, but they do not auto-sync and no longer count towards penalty scoring when they stop following.',
    stakeLabel: 'Performance deposit',

    slashed: '⚠ {amount} USDC penalised',

    copy: 'Copy invest →',
    noStrategyButton: 'No Strategy',
  },

  /** 頁尾統計。單複數各自是完整的一句話，不是拼接出來的。 */
  footer: {
    countOne: '{count} strategy sharer',
    countMany: '{count} strategy sharers',
    followersTotal: '{count} total followers',
    starTraderOne: '{count} star strategy sharer',
    starTraderMany: '{count} star strategy sharers',
    volumeWindow: 'Amount invested + P&L from last ~{blocks} blocks (~{window})',
    windowHours: '{hours}h',
    windowDays: '{days}d',
  },

  hero: {
    simulatedTag: 'Simulated',
    disclosure:
      'Simulated strategy sharers: strategy sharers marked Simulated are operated by a program following published rules. Their performance is a replay of real historical prices on a local chain, not the record of a real person. Every buy and sell is an on-chain record; cumulative return, drawdown and the other statistics are computed off-chain from those on-chain records.',
    disclosureCompressed:
      'Simulated strategy sharers: strategy sharers marked Simulated are operated by a program following published rules. Their performance is a replay of real historical prices, not the record of a real person. Every buy and sell is an on-chain record; cumulative return, drawdown and the other statistics are computed off-chain from those on-chain records. Replayed on Base Sepolia in compressed time: borrow fees and funding are not counted, and the on-chain timestamps are the day of the replay. KYC is approved as soon as it is submitted.',
    range: 'Performance from {from} to {to}; amount invested, P&L and win rate cover the last 30 days',
    volLabel: 'Invested 30d',
    pnlLabel: 'P&L 30d',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    sortReturn: 'Sort: Total return',
    sortDrawdown: 'Sort: Max drawdown',
    sortSharpe: 'Sort: Sharpe',
    podiumReturn: 'Return 30d',
    sortVolume: 'Sort: Amount invested (30d)',
    sortPnl: 'Sort: P&L (30d)',
  },
};
