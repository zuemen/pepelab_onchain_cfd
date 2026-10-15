import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/lab.ts`。
 */
export const lab: Catalog['lab'] = {
  title: 'Strategy Lab',
  subtitle: 'Pick a strategy, a set of parameters and a target to see how it would have done on real historical prices, and the range it could land in over the next 90 days.',
  disclosure:
    'Backtests and forecasts do not indicate future performance. Backtests use real historical daily closes, fill at the close, and charge the same fees as this platform: opening and closing fees by carbon tier, an hourly borrow fee on the leveraged part, and liquidation below maintenance margin. Funding rates and slippage are not simulated. The forecast is a simulation based on historical volatility, not a predictive model.',
  range: 'Backtest {from} to {to} · capital {capital} USDC',

  loading: 'Loading…',
  indexMissing: 'Could not read the Strategy Lab data.',
  resultMissing: 'Could not read this result; figures show as "—".',

  expertOnly: {
    title: 'This page is only available in Expert Mode',
    body: 'The Strategy Lab compares trading approaches with trading-desk metrics. Switch to Expert Mode to use it.',
    action: 'Switch to Expert Mode',
  },

  picker: {
    strategy: 'Strategy',
    params: 'Parameters',
    asset: 'Asset',
    basket: 'Basket',
    single: 'Per-trade (single asset)',
    portfolio: 'Portfolio (basket)',
  },

  strategies: {
    dca: { name: 'Dollar-cost averaging', description: 'Buys every fixed number of days, splitting the capital evenly across the whole period.' },
    martingale: {
      name: 'Martingale',
      description: 'Each round opens with {base}% of the capital; every further drop adds a position a multiple of the last one; once the round reaches its take-profit, everything is closed and a new round starts.',
    },
    grid: { name: 'Grid', description: 'Sets levels below the starting price; buys a level when the price reaches it and sells it one level up. Each level holds at most one position.' },
    momentum: { name: 'Momentum', description: 'Periodically rotates into the 3 assets that rose the most over the lookback, long and equally weighted.' },
    mean_reversion: { name: 'Mean reversion', description: 'Periodically rotates into the 3 assets that fell the most over the lookback, betting on a rebound.' },
    trend: { name: 'Moving-average trend', description: 'Holds every asset: long above its moving average, short below it.' },
  },

  params: {
    every_days: 'Frequency',
    leverage: 'Leverage',
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
    low_carbon: 'Low-carbon five',
    equities: 'Tech equities five',
    macro: 'Macro four',
    crypto_mix: 'Crypto and growth four',
  },

  fees: {
    single: 'Charged: {fee}% to open and again to close ({tier} carbon tier), plus a {borrow}% hourly borrow fee on the leveraged part.',
    portfolio: 'Charged: each asset’s opening and closing fees by carbon tier, plus the hourly borrow fee on the leveraged part. On each rebalance everything is closed before the new positions open.',
    leverageCapped: '{asset}’s carbon tier caps leverage at {max}×, so this result uses {max}×.',
    portfolioLeverage: 'Each asset’s leverage is capped by its carbon tier.',
  },
  tiers: { low: 'low', mid: 'mid', high: 'high' },

  metrics: {
    title: 'Performance',
    strategy: 'Strategy',
    benchmark: 'Buy and hold',
    totalReturn: 'Total return',
    maxDrawdown: 'Max drawdown',
    sharpe: 'Sharpe',
    winRate: 'Win rate',
    trades: 'Trades',
    riskScore: 'Risk score',
    winRateNote: 'Win rate counts closed positions only',
  },

  chart: {
    title: 'Backtest equity and trades',
    strategy: 'Strategy',
    benchmark: 'Buy and hold',
    open: 'Open',
    close: 'Close',
    liquidated: 'Liquidation',
    note: 'Buy and hold puts all the capital into the same target at 1× on day one (equally weighted for a basket) and never trades again.',
  },

  trades: {
    title: 'Every trade',
    count: '{count} in total',
    date: 'Date',
    asset: 'Asset',
    action: 'Action',
    side: 'Side',
    long: 'Long',
    short: 'Short',
    price: 'Price',
    margin: 'Margin',
    pnl: 'Net PnL',
    empty: 'These parameters made no trades during the backtest.',
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
    title: 'Simulated traders with a similar approach',
    body: 'These simulated traders follow the same rule on the local chain; their profiles show their full performance.',
    view: 'View profile',
  },

  noOrder: {
    title: 'Why you cannot trade from here',
    body: 'This is an analysis tool; it does not trade for you. The only thing the contracts can execute on your behalf is a portfolio a trader has published.',
    copy: 'To trade along with a trader’s portfolio, use copy trading from the trader leaderboard.',
    single: 'Per-trade strategies (dollar-cost averaging, martingale, grid) would need an agent to execute each trade for you. That is not offered yet, and no simulated trader uses them.',
  },
};
