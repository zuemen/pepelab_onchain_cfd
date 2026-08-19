import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/rewards.ts`。搬移階段逐字複製原文。
 */
export const rewards: Catalog['rewards'] = {
  connectWallet: 'Connect wallet to view your rewards.',
  connectTitle: '🎁 Rewards',

  title: '🎁 PepeLab Rewards',
  subtitle: 'Trade, follow, and check-in daily to earn PEPE.',

  /** 合約沒部署在這條鏈上時，四個領取動作共用的同一句話。 */
  offline: 'PEPE 獎勵系統尚未部署在此網路，暫時無法領取',

  tier: {
    bronze: 'Bronze 🥉',
    silver: 'Silver 🥈',
    gold: 'Gold 🥇',
    diamond: 'Diamond 💎',
  },

  mining: {
    title: 'Trade Mining',
    description: '每筆開倉可領一次。獎勵 = 名義價值 × 0.5%，封頂 5,000 PEPE。',
    empty: 'No open positions found.',
    position: 'Position #{id}',
    detail: 'Notional: ${notional}',
    estReward: 'Est reward: {reward}',
    claimed: 'Claimed',
    claim: 'Claim',
    done: 'Trade mining claimed! 🎉',
  },

  tierSection: {
    title: 'Tier Upgrade',
    description: '累積交易量達標即可領取一次性 tier 獎勵。',
    cumulative: 'Cumulative notional: ${amount}',
    reward: '{amount} PEPE',
    required: '${amount} required',
    claimed: 'Claimed',
    claim: 'Claim',
    locked: 'Locked',
    done: '{tier} reward claimed! 🏆',
  },

  copy: {
    title: 'Copy Reward',
    description: '跟單成功後，跟單者與被跟單者各領 200 PEPE（每對一次）。',
    empty: 'No active copy trades found.',
    claimed: 'Claimed',
    claim: '200 PEPE',
    done: 'Copy reward claimed! 200 PEPE each 🐸',
  },

  checkIn: {
    title: 'Daily Check-in',
    description: '每日簽到領 50 PEPE，連續簽到每天 +10 PEPE，7 天封頂 110 PEPE。',
    streak: '🔥 {days} day streak',
    todayReward: '今日獎勵: {reward} PEPE',
    /** 按鈕的兩種狀態各自是完整的一句話，不是「簽到 +」加金額。 */
    alreadyCheckedIn: '✓ 今天已簽到',
    checkIn: '🐸 簽到 +{reward} PEPE',
    comeBack: '明天再來！明日獎勵: {reward} PEPE',
    done: 'Checked in! 🐸',
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** PEPE 餘額與空投領取卡（PepeTokenCard，從舊版首頁搬到這一頁）。 */
  pepeToken: {
    label: '🐸 PEPE Token',
    subtitle: 'Pepe RWA Token · claim the airdrop once your KYC is approved',
    addToWallet: 'Add to wallet',
    reloadAria: 'Reload PEPE balance',
    notAvailable: 'PEPE is not available on this network (contracts not deployed here).',

    balance: 'Balance',
    airdrop: 'Airdrop',
    claimed: '✓ Claimed',
    poolEmpty: 'Pool empty',
    claiming: 'Claiming…',
    claim: 'Claim {amount} PEPE',
    kycTooltip: 'Requires an approved KYC application (submitting is not the same as being approved)',
    kycRequired: 'Requires approved KYC — submitting an application is not the same as being approved',

    notDeployed: 'PepeToken is not deployed on this network.',
  },
};
