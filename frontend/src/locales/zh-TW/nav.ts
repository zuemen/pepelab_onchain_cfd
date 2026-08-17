/**
 * 側邊欄、手機選單、搜尋列與帳戶選單的項目名稱。
 *
 * emoji 留在字串裡，不另外抽成欄位：nav 元件把 `title` 當成一段文字渲染，抽出來就得
 * 給每個項目加一個欄位並改元件。留在 catalog 值裡的另一個好處是譯者看得到它、能決定
 * 英文版要不要保留——emoji 在不同語言的觀感並不一致。
 */
export const nav = {
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
    profile: 'My Trader Profile (個人首頁)',
    potions: 'Potion Shop (魔法藥水商店)',
    mounts: 'My Mounts (尊貴坐騎)',
    skins: 'Pepe Skins & Gacha (🎰 造型盲盒與商城)',
    staking: 'Staking DeFi Yields (跟單質押)',
    rewards: 'PepeLab Rewards 🎁 (每日激勵)',
  },
};
