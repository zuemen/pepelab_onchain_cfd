import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/nav.ts`。
 */
export const nav: Catalog['nav'] = {
  section: {
    pepelab: '{brand}',
    trader: 'Strategy sharer',
  },
  item: {
    portfolio: '🏠 Portfolio',
    pepe: '🐸 Pepe Growth Center',
    exchange: 'Funding & Swap',
    tokens: '🪙 Assets',
    terminal: 'Advanced investing tools',
    x402: 'x402 Signal API',
    marketplace: 'Strategy Marketplace',
    /** With copy trading off, /marketplace is the allocation marketplace; the sidebar must match the page title. */
    allocationMarketplace: 'Allocations',
    lab: 'Strategy Lab',
    feed: 'Feed',
    vault: 'Risk Reserve',
    history: 'History',
    whale: 'Whale Tracker',
    esg: 'ESG',
    rewards: 'Rewards 🎁',
    sessions: '🤖 AI Agent Allowances',
    agentMonitor: '📊 Agent Monitor',
    traderDashboard: 'Strategy Sharer Dashboard',
    stake: 'Performance Deposit',
  },
  account: {
    profile: 'My Strategy Sharer Profile',
    potions: 'Potion Shop',
    mounts: 'My Mounts',
    skins: 'Pepe Skins & Gacha',
    staking: 'Strategy sharer performance deposit',
    rewards: 'Rewards 🎁',
  },
};
