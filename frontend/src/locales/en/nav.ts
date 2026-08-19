import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/nav.ts`。搬移階段逐字複製原文，所以這裡還帶著中文——那些字就是英文版
 * 的待辦，`locales.test.ts` 的 ratchet 在盯著它們的數量。
 */
export const nav: Catalog['nav'] = {
  section: {
    pepelab: 'PepeLab',
    trader: 'Trader',
  },
  item: {
    portfolio: '🏠 Portfolio',
    pepe: '🐸 Pepe 養成中心',
    exchange: 'Exchange',
    tokens: '🪙 代幣化資產',
    terminal: 'Pro Terminal',
    x402: 'x402 Signal API',
    marketplace: 'Marketplace',
    vault: 'Vault',
    history: 'History',
    whale: 'Whale Tracker',
    esg: 'ESG',
    rewards: 'Rewards 🎁',
    sessions: '🤖 Agent Sessions',
    agentMonitor: '📊 Agent Monitor',
    traderDashboard: 'Trader Dashboard',
    stake: 'Stake',
  },
  account: {
    profile: 'My Trader Profile',
    potions: 'Potion Shop',
    mounts: 'My Mounts',
    skins: 'Pepe Skins & Gacha',
    staking: 'Staking DeFi Yields',
    rewards: 'PepeLab Rewards 🎁',
  },
};
