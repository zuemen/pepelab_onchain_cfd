import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/rewards.ts`。
 */
export const rewards: Catalog['rewards'] = {
  connectWallet: 'Connect wallet to view your rewards.',
  connectTitle: '🎁 Rewards',

  title: '🎁 {brand} Rewards',
  subtitle: 'Invest and use copy investing to earn PEPE (the platform game token). Daily check-ins add achievement points.',

  /** 合約沒部署在這條鏈上時，四個領取動作共用的同一句話。 */
  offline:
    "The PEPE rewards system isn't deployed on this network — claiming is temporarily unavailable.",

  /** 見 `../zh-TW/rewards.ts`。 */
  offlineTitle: 'Investing rewards, tiers, copy investing rewards and check-in are not on this network',
  offlineBody:
    "Those four on-chain programs aren't on this chain, so there is nothing to claim and no progress to read — the zeros below mean \"could not read\", not \"you have none\". Switch to a network that runs them. The PEPE token and airdrop above are a separate on-chain program and are unaffected.",

  status: {
    loading: 'Reading…',
    claimable: '{n} to claim',
    allClaimed: 'All claimed',
    none: 'Nothing to claim yet',
    offline: 'Paused on this network',
  },

  tier: {
    bronze: 'Bronze 🥉',
    silver: 'Silver 🥈',
    gold: 'Gold 🥇',
    diamond: 'Diamond 💎',
  },

  mining: {
    title: 'Investing Reward',
    // Owner-tunable on PepeIncentives, read from the chain (incentiveParams.ts); descriptionGeneric when unreadable.
    description:
      'Claimable once per purchase. Reward = holding value × {pct}%, capped at {cap} PEPE.',
    descriptionGeneric: 'Claimable once per purchase; the reward scales with the holding value.',
    empty: 'No current investments found.',
    position: 'Investment #{id}',
    detail: 'Holding value: ${notional}',
    estReward: 'Est reward: {reward}',
    claimed: 'Claimed',
    claim: 'Claim',
    done: 'Investing reward claimed! 🎉',
  },

  tierSection: {
    title: 'Tier Upgrade',
    description: 'Claim a one-time tier reward once the value of your current holdings hits the threshold. Selling lowers this number.',
    cumulative: 'Current holding value: ${amount}',
    reward: '{amount} PEPE',
    required: '${amount} required',
    claimed: 'Claimed',
    claim: 'Claim',
    locked: 'Locked',
    done: '{tier} reward claimed! 🏆',
  },

  copy: {
    title: 'Copy Investing Reward',
    description:
      'Once you start copy investing, both the follower and the strategy sharer each get {amount} PEPE (once per pair).',
    descriptionGeneric: 'Once you start copy investing, both the follower and the strategy sharer get a one-time PEPE reward.',
    empty: 'No active copy investing found.',
    claimed: 'Claimed',
    claim: '{amount} PEPE',
    claimGeneric: 'Claim',
    done: 'Copy investing reward claimed! 🐸',
  },

  checkIn: {
    title: 'Daily Check-in',
    description:
      'Check in daily for 50 PEPE; each consecutive day adds +10 PEPE, capped at 110 PEPE after 7 days.',
    streak: '🔥 {days} day streak',
    /** 見 `../zh-TW/rewards.ts`。 */
    todayReward: 'Claimable today: {reward} PEPE',
    /** 按鈕的兩種狀態各自是完整的一句話，不是「簽到 +」加金額。 */
    alreadyCheckedIn: '✓ Checked in today',
    checkIn: '🐸 Check in +{reward} PEPE',
    comeBack: 'Come back tomorrow! Claimable then: {reward} PEPE',
    done: 'Checked in! 🐸',

    /** 見 `../zh-TW/rewards.ts`。 */
    points: {
      description:
        'Each daily check-in records 50 achievement points; each consecutive day adds +10, capped at 110 after 7 days. Points are kept in the on-chain program and cannot be transferred. They are not PEPE.',
      todayReward: 'Recorded today: {reward} achievement points',
      checkIn: '🐸 Check in +{reward} achievement points',
      comeBack: 'Come back tomorrow! Recorded then: {reward} achievement points',
      balance: '{points} achievement points so far',
    },

    /** 見 `../zh-TW/rewards.ts`。 */
    unknown: {
      description:
        'Check in daily; consecutive days count for more each time. Confirming with the on-chain program what a check-in records.',
      todayReward: 'Today: +{reward}',
      checkIn: '🐸 Check in +{reward}',
      comeBack: 'Come back tomorrow!',
    },
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** PEPE 餘額與空投領取卡（PepeTokenCard，從舊版首頁搬到這一頁）。 */
  pepeToken: {
    label: '🐸 PEPE Token',
    subtitle: 'Platform game token · claim the airdrop once KYC is done',
    addToWallet: 'Add to wallet',
    reloadAria: 'Reload PEPE balance',
    notAvailable: 'PEPE is not available on this network (on-chain programs not deployed here).',

    balance: 'Balance',
    airdrop: 'Airdrop',
    claimed: '✓ Claimed',
    poolEmpty: 'Pool empty',
    claiming: 'Claiming…',
    claim: 'Claim {amount} PEPE',
    kycTooltip:
      'KYC must be completed first',
    kycRequired:
      'KYC must be completed first. Submit it from the KYC card on the Portfolio page.',

    notDeployed: 'PepeToken is not deployed on this network.',
  },
};
