import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/stake.ts`。
 */
export const stake: Catalog['stake'] = {
  viewOn: 'View on {explorer} ↗',

  sections: {
    reputation: {
      title: 'Performance Deposit',
      subtitle:
        'Put up {token} as a performance deposit to become eligible to publish strategies that others can follow through copy investing — part of it can be deducted if your strategy causes follower losses.',
    },
  },

  current: {
    title: 'Your Performance Deposit',
    refresh: '↺ Refresh',
    staked: 'Deposited',
    totalSlashed: 'Total Deducted',
    reputation: 'Reputation Score',
    reputationValue: '{score} / 100',
    formula: 'Formula: deposit × 100 ÷ (deposit + total deducted × 5)',
    eligible: '✓ Eligible to publish strategies',
    notEligible: '✗ Need a 100 {token} deposit',
    notEligibleUnstaking: '✗ Deposit withdrawal requested, so you cannot publish for now. Cancel the request to regain eligibility.',
    minimum: 'Minimum deposit: {amount} {token} · Shows your followers you share the risk',
  },

  add: {
    title: 'Deposit {token}',
    description:
      'The deposit is at risk — part of it can be deducted if your strategy causes followers a loss of more than 30%. In return, you earn credibility (reputation score) and can publish strategies.',
    placeholder: '100',
    staking: 'Depositing…',
    cta: 'Approve + Deposit',
    enterAmount: 'Enter a valid amount',
    belowMinimum: 'Your total deposit must be at least {amount} {token}. Raise the amount.',
    done: 'Deposit added ✓',
  },

  unstake: {
    title: 'Withdraw deposit (24 h waiting period)',
    pending: 'Pending withdrawal: {amount} {token}',
    ready: 'Waiting period over — ready to execute.',
    availableAt: 'Available at: {when}',
    executing: 'Executing…',
    execute: 'Withdraw Deposit',
    cancelling: 'Cancelling…',
    cancel: 'Cancel',
    description: 'Request a deposit withdrawal — funds unlock after a 24 h waiting period.',
    placeholder: '50',
    requesting: 'Requesting…',
    request: 'Request Withdrawal',
    enterAmount: 'Enter the amount to withdraw',
    requested: 'Withdrawal requested ✓ — wait 24 h then execute',
    executed: 'Deposit withdrawn ✓',
    cancelled: 'Withdrawal cancelled ✓',
  },

  info: {
    title: 'How the strategy sharer deposit works',
    publish: 'Deposit ≥ 100 {token} to publish strategies on the Strategy Marketplace.',
    slashing:
      "When a follower stops following, if that copy investment's loss from price moves reaches 30% (before fees), 50% of that loss (capped at 50% of your deposit) is deducted. The deducted amount goes into the platform reserve, not to the follower.",
    reputation:
      'Reputation = deposit × 100 ÷ (deposit + total deducted × 5) — drops whenever a deduction happens.',
    cooldown: 'Withdrawing the deposit requires a 24-hour waiting period.',
    backToMarketplace: '← Back to Strategy Marketplace',
    traderDashboard: 'Strategy Sharer Page →',
  },

  copyOff: {
    subtitle:
      'Put up {token} as a performance deposit to become eligible to publish strategies on the marketplace and build reputation; the deposit is at risk under the public on-chain deduction rules.',
    minimum: 'Minimum deposit: {amount} {token} · Shows anyone using your strategy that you share the risk',
    addDescription:
      'The deposit is at risk — part of it can be deducted when the public on-chain deduction rules are triggered. In return, you earn credibility (reputation score) and can publish strategies.',
    slashing: 'Deductions are carried out automatically by a public on-chain program: at most 50% of your deposit per event, held in the platform reserve rather than paid directly to any user.',
  },
};
