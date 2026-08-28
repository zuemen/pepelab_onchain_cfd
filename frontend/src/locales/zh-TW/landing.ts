/**
 * 進站頁。
 *
 * 六張功能卡的標題與說明、四個上手步驟都是顯示字串，整份搬進來。
 */
export const landing = {
  tagline: 'RWA · 代幣化資產 · 社交跟單 🐸',
  enterDashboard: '🐸 進入 Dashboard',
  viewTraders: '查看交易者',
  connectHint: '連線後可直接瀏覽所有功能，無需註冊帳號',

  paperTrading: {
    title: '什麼是 Paper Trading？',
  },

  features: {
    heading: '核心功能',

    rwaTitle: '代幣化 RWA 現貨',
    rwaDesc: '用 USDC 直接買賣代幣化的股、債、金、幣，鏈上鑄造與贖回，儲備率隨時看得到。',

    perpetualsTitle: '進階：合成永續（選用）',
    perpetualsDesc: '要做多空對沖才會用到的合成永續，預設不開槓桿，全程透明上鏈。',

    copyTitle: '一鍵跟單交易',
    copyDesc: '一鍵跟單頂尖交易者，授權 USDC 後自動按比例開倉。',

    esgTitle: 'ESG 評分',
    esgDesc: '每位交易者皆有 ESG 評分，讓投資更有責任感與透明度。',

    vaultTitle: '保險金庫',
    vaultDesc: '提供流動性賺取協議費用，同時作為極端損失的保險池。',

    x402Title: 'x402 付費訊號',
    x402Desc: 'Agent 自帶錢包、按次付費購買交易訊號，收入 70/20/10 上鏈分潤。',

    agentTitle: 'Agent 原生交易',
    agentDesc: 'session key 有界委派，AI agent 付費後可自主在鏈上開受限部位。',
  },

  steps: {
    heading: '如何開始',
    one: '安裝 MetaMask，切換到 Base Sepolia testnet',
    two: '前往 Exchange，點擊「Get 1000 USDC」取得測試資金',
    three: '到「資產」頁買進 sGOLD、sBOND，回 Portfolio 看四類資產的配置與損益',
    four: '（可選）到 Marketplace 跟單，或在 Trader 頁登記成為交易者',
  },

  oracleDisclosure: 'Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化',

  /** 首頁最上方的即時 KPI 條（HeroKpiStrip）。網路名稱、chainId 是技術識別碼，不譯。 */
  heroKpi: {
    x402Revenue: 'x402 收入',
    agentCallsPaid: 'Agent 已付費呼叫',
    openInterest: '未平倉量',
    network: '網路',
    connectHint: '連接錢包 ↗',
  },

  /** #36：主視覺介紹與 Paper Trading 說明，各自拆成 `<b>` 前後的片段。 */
  markup: {
    heroBefore: '一個錢包，配置股、債、金、幣四大類代幣化資產。鏈上鑄造與贖回、社交跟單、大盤對照，外加 ',
    heroBold: 'x402 付費訊號',
    heroAfter: '——讓 AI agent 自帶錢包、付費、自主下單。全程透明上鏈。',

    paperBefore: '本平台使用',
    paperBold1: '測試網代幣',
    paperMid: '進行模擬交易，讓使用者無風險體驗 RWA 投資、 社交跟單與 AI 代理交易。',
    paperBold2: '所有價格追蹤真實市場',
    paperAfter: '，但資金為模擬資產， 不涉及真實金錢 —— 等同 TradingView 的 Paper Trading 模式。',
  },
};
