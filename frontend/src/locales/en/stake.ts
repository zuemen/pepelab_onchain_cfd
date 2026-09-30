import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/stake.ts`。
 */
export const stake: Catalog['stake'] = {
  viewOn: 'View on {explorer} ↗',

  sections: {
    reputation: {
      title: 'Reputation Staking',
      subtitle:
        'Stake {token} for eligibility to publish strategies and join the copy-trading market — can be slashed if your strategy causes follower losses.',
    },
  },

  current: {
    title: 'Your Stake',
    refresh: '↺ Refresh',
    staked: 'Staked',
    totalSlashed: 'Total Slashed',
    reputation: 'Reputation Score',
    reputationValue: '{score} / 100',
    formula: 'Formula: stake × 100 ÷ (stake + totalSlashed × 5)',
    eligible: '✓ Eligible to publish strategies',
    notEligible: '✗ Need 100 {token} stake',
    minimum: 'Minimum stake: {amount} {token} · Skin-in-the-game for your followers',
  },

  add: {
    title: 'Stake {token}',
    description:
      'Staking puts your capital at risk — followers can trigger slashing if your strategy causes > 30% loss. In return, you earn credibility (reputation score) and can publish strategies.',
    placeholder: '100',
    staking: 'Staking…',
    cta: 'Approve + Stake',
    enterAmount: 'Enter a valid amount',
    done: 'Staked successfully ✓',
  },

  unstake: {
    title: 'Unstake (24 h cooldown)',
    pending: 'Pending unstake: {amount} {token}',
    ready: 'Cooldown elapsed — ready to execute.',
    availableAt: 'Available at: {when}',
    executing: 'Executing…',
    execute: 'Execute Unstake',
    cancelling: 'Cancelling…',
    cancel: 'Cancel',
    description: 'Request unstake — funds unlock after 24 h cooldown.',
    placeholder: '50',
    requesting: 'Requesting…',
    request: 'Request Unstake',
    enterAmount: 'Enter amount to unstake',
    requested: 'Unstake requested ✓ — wait 24 h then execute',
    executed: 'Unstake executed ✓',
    cancelled: 'Unstake cancelled ✓',
  },

  info: {
    title: 'How Trader Stake works',
    publish: 'Stake ≥ 100 {token} to publish strategies on the Marketplace.',
    slashing:
      'If a follower suffers > 30% loss, 50% of that loss amount (capped at 50% of your stake) is slashed and sent to them.',
    reputation:
      'Reputation = stake × 100 ÷ (stake + totalSlashed × 5) — degrades as you get slashed.',
    cooldown: 'Unstaking requires a 24-hour cooldown.',
    backToMarketplace: '← Back to Marketplace',
    traderDashboard: 'Trader Dashboard →',
  },

  copyOff: {
    subtitle:
      'Stake {token} to become eligible to publish strategies on the marketplace and build reputation; staked funds are at risk under the on-chain slashing rules.',
    minimum: 'Minimum stake: {amount} {token} · Skin in the game for anyone using your strategy',
    addDescription:
      'Staking puts your capital at risk — it can be deducted when the TraderStake contract’s slashing rules are triggered. In return, you earn credibility (reputation score) and can publish strategies.',
    slashing: 'Slashing is enforced by the TraderStake contract: at most 50% of your stake per event, paid to the affected party.',
  },
};
