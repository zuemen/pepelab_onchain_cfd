import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/traderDashboard.ts`。
 */
export const traderDashboard: Catalog['traderDashboard'] = {
  connectWallet: 'Connect wallet to access Trader Dashboard.',
  viewOn: 'View on {explorer} ↗',

  profile: {
    repChip: '◆ {rep} rep',
    staked: '{amount} USDC staked',
  },

  register: {
    title: 'Register Trader',
    registeredChip: '✓ {name}',
    registeredNote: 'Registered as public trader',
    placeholder: 'Display name (e.g. AlphaTrader)',
    registering: '…',
    cta: 'Register',
    done: 'Registered as trader ✓',
  },

  publish: {
    title: 'Publish Strategy',
    addAsset: '+ Add Asset',

    stakeRequiredTitle: 'Stake required to publish',
    stakeRequiredBody:
      'You need to stake at least 100 USDC before publishing a strategy. This gives followers confidence that you have skin-in-the-game.',
    goToStake: 'Go to Trader Stake →',
    stakeRequiredBodyNeutral:
      'Publishing a strategy requires a trader reputation stake of at least 100 USDC, so anyone using your strategy knows you have skin in the game.',

    empty: 'Click "+ Add Asset" to build your strategy.',

    column: {
      asset: 'Asset',
      direction: 'Direction',
      leverage: 'Leverage',
      weight: 'Weight %',
    },
    long: 'Long ↑',
    short: 'Short ↓',

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

    registerFirst: 'Register as a trader first to publish.',

    /** #36：夾了連到 /stake 的 `<Link>`，拆成前後片段。 */
    stakeToUnlockBefore: 'Stake ≥ 100 USDC on the ',
    stakeToUnlockLink: 'Stake page',
    stakeToUnlockAfter: ' to unlock publishing.',
  },

  earnings: {
    title: 'Fee Earnings',
    refresh: '↺ Refresh',
    claimable: 'Claimable (copy + perf fees)',
    claiming: 'Claiming…',
    claimAll: 'Claim All',
    note: 'Earnings accrue when followers pay the 0.3% copy fee or close copied positions in profit (10% performance fee). Your share is 70% of each fee.',
    claimed: 'Earnings claimed ✓',
    claimableNeutral: 'Claimable trader earnings',
    noteNeutral: 'Trader earnings accrue in the FeeRouter under on-chain rules; your share is 70% of each fee.',
  },

  history: {
    title: 'Strategy History',
    refresh: '↺ Refresh',
    empty: 'No strategies published yet.',
    /** 摘要行：sBTC L 3×  ·  sETH S 2× */
    summaryEntry: '{asset} {side} {leverage}×',
    long: 'L',
    short: 'S',

    column: {
      asset: 'Asset',
      side: 'Side',
      leverage: 'Leverage',
      weight: 'Weight',
    },
    longLabel: 'Long ↑',
    shortLabel: 'Short ↓',
  },
};
