import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/marketplace.ts`。
 */
export const marketplace: Catalog['marketplace'] = {
  title: '⭐ Star Trader Leaderboard',
  subtitle: 'Browse and copy on-chain verified strategies',
  networkError: 'Network error — check wallet',

  esgFiltered: 'Filtered',
  esgAll: 'All',
  esgButton: 'ESG {state}',
  /** #333: filter traders by SDG (a strategy holding an asset mapped positively to the goal). */
  sdgFilter: {
    /** "Team judgement" stays visible on the filter: the mapping is not a third-party rating (CONTEXT.md, SDG Mapping). */
    label: 'SDG (team judgement)',
    all: 'All goals',
    option: 'SDG {goal} · {name}',
  },

  sort: {
    score: 'Sort: TraderScore',
    reputation: 'Sort: Reputation',
    followers: 'Sort: Followers',
    volume: 'Sort: Volume (7d)',
    pnl: 'Sort: PnL (7d)',
    stake: 'Sort: Stake',
    esg: 'Sort: ESG Score',
  },

  refreshAria: 'Refresh marketplace data',

  search: {
    placeholder: 'Search name or address…',
    noResults: 'No traders match "{query}"',
  },

  table: {
    provisional: 'provisional',
    rank: '#',
    trader: 'Trader',
    score: 'TraderScore',
    reputation: 'Reputation',
    strategy: 'Strategy',
    winRate: 'Win Rate',
    esg: 'ESG',
    actions: 'Actions',
    insufficientSample: 'Small sample',
    unranked: 'Not enough data to be ranked ({rule})',
    unrankedRuleHistory: 'trading for less than {days} days',
    unrankedRuleTrades: 'fewer than {count} closed trades',

    tips: {
      rank: 'Only traders with enough data get a rank (not ranked: {rule}); the rest are listed at the bottom with "—". The top three are on the podium above.',
      score: 'A 0–100 composite: return (40) + win rate (25) + stake (20) + reputation (15), minus up to 20 if slashed. Return and win rate cover the last {days} days. Click a score for the breakdown.',
      strategy: 'The strategy version the trader has published now: assets, direction (↑ long, ↓ short), weights and leverage. Copying takes exactly this version.',
      totalReturn: 'Change in equity over the whole period ({from} to {to}): final equity ÷ starting capital − 1. Equity includes open positions valued at each day\'s price.',
      maxDrawdown: 'The largest fall in equity from a previous high during the period. -20% means it once lost a fifth from its peak. Closer to 0 is steadier.',
      sharpe: 'Risk-adjusted return: the average daily return ÷ the standard deviation of daily returns, scaled to a year by √365. Higher means more return for the same volatility; above 1 is generally considered good, and a negative value means the period lost money on average.',
      volume: 'Notional value of positions opened in the last {days} days (margin × leverage, USDC).',
      pnl: 'Realised profit and loss of positions closed in the last {days} days (USDC). Open positions are not included.',
      winRate: 'Share of positions closed in the last {days} days that made money; the number in brackets is how many closed. Fewer than 5 is marked "Small sample" and is indicative only.',
      followers: 'People currently copying this trader, each counted once. Those who have unfollowed are not included.',
      stake: 'USDC the trader has staked in the TraderStake contract. When a copier loses 30% or more, half of that loss is slashed (at most half the stake); ⚠ means the trader has been slashed.',
      esg: 'Weight-averaged ESG composite (0–100) of the assets in the current strategy. Use the "ESG" button above to show only traders at 60 or more.',
    },
  },

  scoreBreakdown: {
    returnLabel: 'Return',
    winRateLabel: 'Win Rate',
    slashLabel: 'Slash Penalty',
    totalLabel: 'Total',
    totalValue: '{total} / 100',
    insufficientNote: 'Fewer than 5 closed trades — win rate is indicative only',
  },

  podium: {
    hiddenIncomplete: 'Some block ranges could not be read, so the 7-day metrics are incomplete; the podium is withheld until a refresh succeeds.',
    heading: '🏆 Top 3 by Current Sort',
    noneQualified: 'No trader qualifies for a rank yet (not ranked: {rule}), so there are no podium finishers — they\'re still in the table below.',
  },

  loadFailed: 'Failed to load:',
  tradersReadFailed: {
    title: 'Read failed',
    description: 'The trader list could not be read from the chain — an empty list here does not mean there are no traders. Please refresh later.',
  },
  scanIncomplete: '{count}/{total} block ranges could not be read; volume and PnL below may be understated.',

  scanProgress: 'Scanning on-chain events... {done}/{total}',

  empty: {
    title: 'No traders with a published strategy on this chain yet',
    description:
      'The leaderboard is computed live from on-chain events. Currently connected to {chain}, scanning the last {blocks} blocks (~{window}). If you expected to see traders, check your wallet is on the right chain.',
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
    volumeWindow: 'Volume + PnL from last ~{blocks} blocks (~{window})',
    windowHours: '{hours}h',
    windowDays: '{days}d',
  },

  hero: {
    disclosure:
      'Simulated traders: the traders below are operated by a program following published rules. Their performance is a replay of real historical prices on a local chain, not the record of a real person. Every open and close is an on-chain transaction; cumulative return, drawdown and the other statistics are computed off-chain from those on-chain events.',
    range: 'Performance from {from} to {to}; volume, PnL and win rate cover the last 30 days',
    volLabel: 'Vol 30d',
    pnlLabel: 'PnL 30d',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    sortReturn: 'Sort: Total return',
    sortDrawdown: 'Sort: Max drawdown',
    sortSharpe: 'Sort: Sharpe',
    podiumReturn: 'Return 30d',
    sortVolume: 'Sort: Volume (30d)',
    sortPnl: 'Sort: PnL (30d)',
  },
};
