import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/feed.ts`。
 */
export const feed: Catalog['feed'] = {
  title: 'Feed',
  subtitle: 'What is happening on the platform right now. Every item comes from an on-chain transaction you can open and check.',
  scanWindow: 'Scanned blocks {from} to {to} (about {span})',
  scanWindowAll: 'Scanned blocks {from} to {to} (local chain, from the start)',
  incomplete: 'Some blocks could not be read, so this feed is incomplete: anything missing may still have happened.',
  loading: 'Reading on-chain events…',
  empty: 'No matching activity in this period.',
  refresh: 'Refresh',
  loadMore: 'Show more',
  pnlNote: 'Price PnL is the price-move profit or loss recorded in the event, before trading fees, borrow fees and funding — which is why a liquidated position can still show a positive figure.',

  expertOnly: {
    title: 'This page is only available in Expert Mode',
    body: 'The feed lists trading-desk events from the chain. Switch to Expert Mode to see it.',
    action: 'Switch to Expert Mode',
  },

  filter: {
    types: 'Type',
    trader: 'Trader',
    allTraders: 'All',
  },

  types: {
    strategy: 'Strategy change',
    bigOpen: 'Large open',
    bigClose: 'Large close',
    liquidation: 'Liquidation',
    follow: 'Copy trading',
    unfollow: 'Stopped copying',
    slash: 'Slash',
    retirement: 'Carbon retirement',
    resync: 'Auto-sync',
    autoSync: 'Sync settings',
  },

  sentence: {
    strategyFirst: 'published their first strategy: {legs}',
    strategyChanged: 'changed their strategy (version {version}): {changes}',
    strategyUnknown: 'published strategy version {version}',
    strategySame: 'republished version {version} with the same positions',
    added: 'added {asset} {side} {weight}%',
    removed: 'removed {asset}',
    reweighted: '{asset} {from}% → {to}%',
    flipped: '{asset} switched to {side}',
    leg: '{asset} {side} {weight}%',
    bigOpen: 'opened a {asset} {side} {leverage}× position, notional {notional}',
    bigClose: 'closed a {asset} {side} position (notional {notional}), price PnL {pnl}',
    liquidation: 'had a {asset} {side} position (notional {notional}) liquidated, price PnL {pnl}',
    liquidationUnknown: 'had a position liquidated, price PnL {pnl}',
    follow: '{count} started copy trading today, {margin} in total',
    followOn: '{count} started copy trading on {day}, {margin} in total',
    unfollow: '{count} stopped copying today',
    unfollowOn: '{count} stopped copying on {day}',
    slash: 'had {amount} of stake slashed',
    retirement: 'retired {tonnes} t of simulated carbon credits ({amount}), paid from the platform fee’s carbon share',
    long: 'long',
    short: 'short',
    separator: '; ',
    resync: '{count} copies moved to version {version}',
    autoSyncOn: '{count} copies switched auto-sync on {when}',
    autoSyncOff: '{count} copies switched auto-sync off {when}',
    today: 'today',
    onDay: 'on {day}',
  },

  item: {
    simulated: 'Simulated',
    platform: 'Platform',
    profile: 'Profile',
    copy: 'Copy',
    tx: 'Transaction',
  },

  profile: {
    title: 'Recent activity',
    viewAll: 'See the whole feed',
    empty: 'No activity from this trader in this period.',
  },

  sides: {
    title: 'Market long/short ratio',
    subtitle: 'For each asset in the strategy, the platform-wide share of open interest on each side (read directly from the exchange contract).',
    long: 'Long {pct}%',
    short: 'Short {pct}%',
    with: 'Same side as the market',
    against: 'Against the market',
    even: 'Evenly split',
    none: 'No open interest yet',
    missing: '{count} markets could not be read',
    yourSide: 'Strategy: {side}',
  },
};
