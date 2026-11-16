import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/lab.ts`。
 */
export const lab: Catalog['lab'] = {
  title: 'Strategy Lab',
  subtitle: 'Try an investing approach on real historical prices: see whether it makes money, how deep it can fall, and where it could land over the next 90 days.',
  steps: { pick: 'Pick a strategy', tune: 'Tune it', read: 'Read the result' },
  disclosure:
    'Backtests and forecasts do not indicate future performance. Backtests use real historical daily closes, fill at the close, and charge the same fees as this platform: buying and selling fees by carbon tier, an hourly borrow fee on the borrowed part when an investment is amplified, and automatic settlement when a loss exceeds what the amount invested can absorb. Funding costs and slippage are not simulated. The forecast is a simulation based on historical volatility, not a predictive model.',
  range: 'Backtest {from} to {to} · capital {capital} USDC',

  loading: 'Loading…',
  indexMissing: 'Could not read the Strategy Lab data.',
  resultMissing: 'Could not read this result; figures show as "—".',

  expertOnly: {
    title: 'This page is only available in Expert Mode',
    body: 'The Strategy Lab compares investing approaches with professional performance metrics. Switch to Expert Mode to use it.',
    action: 'Switch to Expert Mode',
  },

  picker: {
    strategy: 'Pick a strategy',
    params: 'Tune it',
    asset: 'Pick an asset',
    basket: 'Pick a basket',
    single: 'One at a time (single asset)',
    portfolio: 'Portfolio (basket)',
  },

  strategies: {
    dca: { name: 'Dollar-cost averaging', tagline: 'Buy on a schedule, no timing', description: 'Buys every fixed number of days, splitting the capital evenly across the whole period.' },
    martingale: {
      name: 'Martingale',
      tagline: 'Add more on every drop, exit on the bounce',
      description: 'Each round starts by buying {base}% of the capital; every further drop adds a buy a multiple of the last one; once the round reaches its take-profit, everything is sold and a new round starts.',
    },
    grid: { name: 'Grid', tagline: 'Buy low, sell high, harvest the swings', description: 'Sets levels below the starting price; buys a level when the price reaches it and sells it one level up. Each level holds at most one buy at a time.' },
    momentum: { name: 'Momentum', tagline: 'Ride what rose the most', description: 'Periodically rotates into the 3 assets that rose the most over the lookback, bought in equal weights.' },
    mean_reversion: { name: 'Mean reversion', tagline: 'Pick up what fell the most', description: 'Periodically rotates into the 3 assets that fell the most over the lookback, betting on a rebound.' },
    trend: { name: 'Moving-average trend', tagline: 'Price up above the average, price down below', description: 'Holds every asset: bets on a rise above its moving average and on a fall below it (earning when the price drops).' },
  },

  params: {
    every_days: 'Frequency',
    leverage: 'Amplification',
    multiplier: 'Add-on multiple',
    drop_pct: 'Add-on step (drop)',
    take_profit_pct: 'Take-profit',
    spacing_pct: 'Grid spacing',
    levels: 'Levels',
    lookback: 'Lookback',
    window: 'Moving average',
  },
  values: {
    days: 'Every {n} days',
    span: '{n} days',
    times: '{n}×',
    pct: '{n}%',
    levels: '{n} levels',
  },

  baskets: {
    low_carbon: 'Low-carbon four',
    equities: 'Tech equities five',
    macro: 'Macro four',
    crypto_mix: 'Crypto and growth four',
  },

  fees: {
    single: 'Charged: {fee}% to buy and again to sell ({tier} carbon tier), plus a {borrow}% hourly borrow fee on the borrowed part of an amplified investment.',
    portfolio: 'Charged: each asset’s buying and selling fees by carbon tier, plus the hourly borrow fee on the borrowed part of an amplified investment. On each rebalance everything is sold before the new buys.',
    leverageCapped: '{asset}’s carbon tier caps amplification at {max}×, so this result uses {max}×.',
    portfolioLeverage: 'Each asset’s amplification is capped by its carbon tier.',
  },
  tiers: { low: 'low', mid: 'mid', high: 'high' },

  summary: {
    title: 'Backtest result',
    sentence: 'Starting {from} with {capital} USDC, running "{strategy}" on {target} would have reached, by {to},',
    benchmark: 'Buy-and-hold over the same period: {final} USDC ({pct})',
    beat: 'Beat buy-and-hold by {pts} points',
    lose: 'Trailed buy-and-hold by {pts} points',
    tie: 'Matched buy-and-hold',
    maxDrawdown: 'Max drawdown',
    riskScore: 'Risk score',
    trades: 'Buys and sells',
    lossProb: 'Chance of a loss in {days} days',
  },
  tabs: {
    backtest: 'Backtest: past equity',
    forecast: 'Forecast: next {days} days',
  },
  details: {
    metrics: 'All metrics (vs buy-and-hold)',
    trades: 'Every buy and sell ({count})',
  },
  next: {
    title: 'Want to invest this way?',
    marketplace: 'See the strategy sharer leaderboard',
    share: 'Copy a link to these settings',
    copied: 'Link copied — anyone who opens it sees the same result',
  },

  metrics: {
    title: 'Performance',
    strategy: 'Strategy',
    benchmark: 'Buy and hold',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    winRate: 'Win rate',
    trades: 'Buys and sells',
    riskScore: 'Risk score',
    winRateNote: 'Win rate counts investments already sold only',
  },

  chart: {
    title: 'Backtest equity with buys and sells',
    strategy: 'Strategy',
    benchmark: 'Buy and hold',
    open: 'Buy',
    close: 'Sell',
    liquidated: 'Automatic settlement',
    note: 'Buy and hold puts all the capital, unamplified, into the same target on day one (equally weighted for a basket) and never buys or sells again.',
  },

  trades: {
    title: 'Every buy and sell',
    count: '{count} in total',
    date: 'Date',
    asset: 'Asset',
    action: 'Action',
    side: 'Direction',
    long: 'Price up',
    short: 'Price down',
    price: 'Price',
    margin: 'Amount invested',
    pnl: 'Net profit / loss',
    empty: 'These parameters made no buys or sells during the backtest.',
  },

  forecast: {
    title: 'Equity range over the next {days} days',
    p5: 'Pessimistic (5th percentile)',
    p50: 'Median',
    p95: 'Optimistic (95th percentile)',
    outer: '5th–95th percentile',
    inner: '25th–75th percentile',
    lossProb: 'Chance of ending at a loss',
    halfLossProb: 'Chance of losing more than half',
    method:
      'Method: starting from the {from} close with fresh capital of {capital} USDC, the backtest period’s daily returns are drawn at random in {block}-day blocks and joined into {paths} price paths of {days} days (every asset draws the same days), and the strategy runs once on each path with the same rules. This is a simulation based on historical volatility, not a predictive model: it does not predict direction, and it never produces a daily move larger than history has seen.',
  },

  similar: {
    title: 'Simulated strategy sharers with a similar approach',
    body: 'These simulated strategy sharers use the same rule; their profiles show their full performance.',
    view: 'View profile',
  },

  noOrder: {
    title: 'Why you cannot invest from here',
    body: 'This is an analysis tool; it does not buy or sell for you. The only thing the public automated rules can carry out on your behalf is a portfolio a strategy sharer has published.',
    copy: 'To invest along with a strategy sharer’s portfolio, use copy investing from the strategy sharer leaderboard.',
    single: 'One-at-a-time strategies (dollar-cost averaging, martingale, grid) would need an AI agent to carry out each buy and sell for you. That is not offered yet, and no simulated strategy sharer uses them.',
  },
};
