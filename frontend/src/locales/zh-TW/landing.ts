/**
 * 進站頁。
 *
 * 六張功能卡的標題與說明、四個上手步驟都是顯示字串，整份搬進來。
 * 主視覺那段介紹與 Paper Trading 的說明各自在句中夾了 `<b>`，留給 #36。
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
};
