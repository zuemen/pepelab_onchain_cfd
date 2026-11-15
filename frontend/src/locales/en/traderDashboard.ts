import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/traderDashboard.ts`。
 */
export const traderDashboard: Catalog['traderDashboard'] = {
  connectWallet: 'Connect wallet to open your strategy sharer page.',
  viewOn: 'View on {explorer} ↗',

  profile: {
    repChip: '◆ {rep} rep',
    staked: '{amount} USDC performance deposit',
  },

  register: {
    title: 'Register as a Strategy Sharer',
    registeredChip: '✓ {name}',
    registeredNote: 'Registered as a public strategy sharer',
    placeholder: 'Display name (e.g. Steady Saver)',
    registering: '…',
    cta: 'Register',
    done: 'Registered as a strategy sharer ✓',
  },

  publish: {
    title: 'Publish Strategy',
    addAsset: '+ Add Asset',

    stakeRequiredTitle: 'Performance deposit required to publish',
    stakeRequiredBody:
      'You need to place a performance deposit of at least 100 USDC before publishing a strategy, so followers know you share the risk. You also cannot publish while a deposit withdrawal request is pending.',
    goToStake: 'Go to Performance Deposit →',
    stakeRequiredBodyNeutral:
      'Publishing a strategy requires a performance deposit of at least 100 USDC, so anyone using your strategy knows you share the risk.',

    empty: 'Click "+ Add Asset" to build your strategy.',

    column: {
      asset: 'Asset',
      direction: 'Direction',
      leverage: 'Multiple',
      weight: 'Weight %',
    },
    long: 'Expects rise ↑',
    short: 'Expects fall ↓',

    duplicateWarning: 'Each asset can only appear once per strategy. Remove the duplicate.',
    exceeds: 'exceeds',
    mustReach: 'must reach',
    weightTarget: '{state} 100%',
    autoFix: 'Auto-fix to 100%',

    issue: {
      tooFew: 'A strategy needs at least {min} assets (currently {got}).',
      exceedsMax: 'Row {row} weight {pct}% exceeds the 50% single-asset cap.',
      zeroWeight: 'Row {row} weight cannot be 0.',
      roundingAdjusted: 'A {bps} bps rounding difference was added to the largest weight so the total is 100.00%.',
    },

    publishing: 'Publishing…',
    cta: 'Publish Strategy',
    done: 'Strategy published ✓',

    registerFirst: 'Register as a strategy sharer first to publish.',

    /** #36：夾了連到 /stake 的 `<Link>`，拆成前後片段。 */
    stakeToUnlockBefore: 'Place a performance deposit of ≥ 100 USDC on the ',
    stakeToUnlockLink: 'Performance Deposit page',
    stakeToUnlockAfter: ' to unlock publishing.',
  },

  earnings: {
    title: 'Fee Earnings',
    refresh: '↺ Refresh',
    claimable: 'Claimable (copy investing + performance fees)',
    claiming: 'Claiming…',
    claimAll: 'Claim All',
    note: 'Earnings accrue when followers pay the 0.3% copy investing fee, or sell investments that followed you at a profit (10% performance fee). Your share is 70% of each fee.',
    claimed: 'Earnings claimed ✓',
    claimableNeutral: 'Claimable strategy sharer earnings',
    noteNeutral: 'Strategy sharer earnings accrue under public on-chain rules; your share is 70% of each fee.',
  },

  history: {
    title: 'Strategy History',
    refresh: '↺ Refresh',
    empty: 'No strategies published yet.',
    /** 摘要行：BTC L 3×  ·  ETH S 2× */
    summaryEntry: '{asset} {side}',
    long: 'Up',
    short: 'Down',

    column: {
      asset: 'Asset',
      side: 'Direction',
      leverage: 'Multiple',
      weight: 'Weight',
    },
    longLabel: 'Expects rise ↑',
    shortLabel: 'Expects fall ↓',
  },
};
