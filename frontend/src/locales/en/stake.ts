import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/stake.ts`。搬移階段逐字複製原文。
 */
export const stake: Catalog['stake'] = {
  viewOn: 'View on {explorer} ↗',

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

  /** PEPE 收益農場。整區是展示用的試算，不是鏈上真的獎勵池。 */
  farm: {
    title: 'PEPE 收益農場',
    chip: '鏈上聯動實時挖礦',
    subtitle: '依 {token} 聲譽質押試算 PEPE 產出（展示用，尚未接上鏈上獎勵池）',
    aprLabel: '穩健收益率',
    pending: '待收割 PEPE 收益 (Pending)',
    walletBalance: '錢包鏈上 PEPE 餘額 (Wallet)',
    accruedFrom: '依質押的 {amount} {token} 累計（展示用）',
    notStaked: '⚠️ 您目前尚未質押 {token}',
    harvest: '🌾 收割（展示用 · 尚未啟用）',
    harvestDisabledHint: '尚未接上獎勵來源合約（PepeStaking 未部署），此為展示用累計',
    addToWallet: '🦊 加 Metamask',
    addedToWallet: '已將 PEPE 代幣合約成功加入您的 Metamask！ 🦊🐸',
    addToWalletFailed: '新增代幣失敗，請手動複製合約地址。',
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
};
