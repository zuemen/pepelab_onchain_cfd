/**
 * 進站頁。
 *
 * 六張功能卡的標題與說明、四個上手步驟都是顯示字串，整份搬進來。
 */
export const landing = {
  tagline: 'DeFi · SocialFi · GameFi · MemeFi 🐸',
  enterDashboard: '🐸 進入 Dashboard',
  viewTraders: 'View Traders',
  connectHint: '連線後可直接瀏覽所有功能，無需註冊帳號',

  paperTrading: {
    title: '什麼是 Paper Trading？',
  },

  features: {
    heading: '核心功能',

    perpetualsTitle: 'Synthetic CFD Perpetuals',
    perpetualsDesc: '合成衍生品永續合約，全程透明上鏈，無需中心化交易所。',

    copyTitle: 'One-Click Copy Trading',
    copyDesc: '一鍵跟單頂尖交易者，授權 USDC 後自動按比例開倉。',

    esgTitle: 'ESG Scoring',
    esgDesc: '每位交易者皆有 ESG 評分，讓投資更有責任感與透明度。',

    vaultTitle: 'Insurance Vault',
    vaultDesc: '提供流動性賺取協議費用，同時作為極端損失的保險池。',

    x402Title: 'x402 Paid Signals',
    x402Desc: 'Agent 自帶錢包、按次付費購買交易訊號，收入 70/20/10 上鏈分潤。',

    agentTitle: 'Agent-Native Trading',
    agentDesc: 'session key 有界委派，AI agent 付費後可自主在鏈上開受限部位。',
  },

  steps: {
    heading: '如何開始',
    one: '安裝 MetaMask，切換到 Base Sepolia testnet',
    two: '前往 Exchange，點擊「Get 1000 USDC」取得測試資金',
    three: '到 Marketplace 複製 Demo Alpha 交易者策略',
    four: '（可選）在 Trader 頁面登記成為交易者並公開策略',
  },

  oracleDisclosure: 'Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化',

  /** #36：主視覺介紹與 Paper Trading 說明，各自拆成 `<b>` 前後的片段。 */
  markup: {
    heroBefore: '對標 Hyperliquid 的鏈上永續 + agent 經濟。5x 槓桿合成/RWA 永續、社交跟單、 做市金庫，外加 ',
    heroBold: 'x402 付費訊號',
    heroAfter: '——讓 AI agent 自帶錢包、付費、自主下單。全程透明上鏈。',

    paperBefore: '本平台使用',
    paperBold1: '測試網代幣',
    paperMid: '進行模擬交易，讓使用者無風險體驗 RWA 投資、 社交跟單與 AI 代理交易。',
    paperBold2: '所有價格追蹤真實市場',
    paperAfter: '，但資金為模擬資產， 不涉及真實金錢 —— 等同 TradingView 的 Paper Trading 模式。',
  },
};
