import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/feed.ts`。
 */
export const feed: Catalog['feed'] = {
  title: 'Feed',
  subtitle: 'What is happening on the platform right now. Every item comes from an on-chain record you can open and check.',
  scanWindow: 'Scanned blocks {from} to {to} (about {span})',
  scanWindowAll: 'Scanned blocks {from} to {to} (local chain, from the start)',
  incomplete: 'Some blocks could not be read, so this feed is incomplete: anything missing may still have happened.',
  loading: 'Reading on-chain events…',
  empty: 'No matching activity in this period.',
  refresh: 'Refresh',
  loadMore: 'Show more',
  pnlNote: 'Price gain/loss is the price-move profit or loss recorded in the event, before fees, borrow fees and funding — which is why an investment that was settled automatically can still show a positive figure.',

  expertOnly: {
    title: 'This page is only available in Expert Mode',
    body: 'The feed lists on-chain events from strategy sharers and investors. Switch to Expert Mode to see it.',
    action: 'Switch to Expert Mode',
  },

  filter: {
    types: 'Type',
    trader: 'Strategy sharer',
    allTraders: 'All',
  },

  types: {
    strategy: 'Strategy change',
    bigOpen: 'Large investment',
    bigClose: 'Large investment ended',
    liquidation: 'Automatic settlement',
    follow: 'Copy investing',
    unfollow: 'Stop following',
    slash: 'Deduction',
    retirement: 'Carbon retirement',
    resync: 'Auto-sync',
    autoSync: 'Sync settings',
  },

  sentence: {
    strategyFirst: 'published their first strategy: {legs}',
    strategyChanged: 'changed their strategy (version {version}): {changes}',
    strategyUnknown: 'published strategy version {version}',
    strategySame: 'republished version {version} with the same holdings',
    added: 'added {asset} {side} {weight}%',
    removed: 'removed {asset}',
    reweighted: '{asset} {from}% → {to}%',
    flipped: '{asset} switched to {side}',
    leg: '{asset} {side} {weight}%',
    bigOpen: 'made a new {asset} investment ({side}), total {notional}',
    bigClose: 'ended a {asset} investment ({side}, total {notional}), price gain/loss {pnl}',
    liquidation: 'had a {asset} investment ({side}, total {notional}) settled automatically, price gain/loss {pnl}',
    liquidationUnknown: 'had an investment settled automatically, price gain/loss {pnl}',
    follow: '{count} started copy investing today, {margin} in total',
    followOn: '{count} started copy investing on {day}, {margin} in total',
    unfollow: '{count} stopped following today',
    unfollowOn: '{count} stopped following on {day}',
    slash: 'had {amount} deducted from their performance deposit',
    retirement: 'retired {tonnes} t of platform-minted carbon credits ({amount}), paid from the platform fee’s carbon share',
    long: 'rise',
    short: 'fall',
    separator: '; ',
    resync: '{count} copy investing holding(s) synced to version {version}',
    autoSyncOn: '{count} follower(s) turned on auto-sync {when}',
    autoSyncOff: '{count} follower(s) turned off auto-sync {when}',
    today: 'today',
    onDay: 'on {day}',
  },

  item: {
    simulated: 'Simulated',
    platform: 'Platform',
    profile: 'Profile',
    copy: 'Copy investing',
    tx: 'On-chain record',
  },

  profile: {
    title: 'Recent activity',
    viewAll: 'See the whole feed',
    empty: 'No activity from this strategy sharer in this period.',
  },

  sides: {
    title: 'Market rise/fall split',
    subtitle: 'For each asset in the strategy, the platform-wide share of investments expecting a rise or a fall (read directly from the on-chain program).',
    long: 'Rise {pct}%',
    short: 'Fall {pct}%',
    with: 'Same view as the market',
    against: 'Opposite view to the market',
    even: 'Evenly split',
    none: 'No investments yet',
    missing: '{count} markets could not be read',
    yourSide: 'Strategy: {side}',
  },
};
