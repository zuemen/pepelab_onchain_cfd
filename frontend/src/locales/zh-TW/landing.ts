/**
 * 進站頁。
 *
 * 功能卡的標題與說明、四個上手步驟都是顯示字串，整份搬進來。
 *
 * #331 起主軸是 Web3 版 eToro（ADR-023）：跟單旗標開啟時，主視覺講「跟著透明的交易者
 * 投資」。旗標關閉的租戶（機構白標）沿用 `copyOff` 那一套代幣化資產的說法。
 */
export const landing = {
  tagline: '跟著透明的交易者投資 {brandMark}',
  /** logo 下面那一行。刻意不提永續——那是預設關閉的進階功能。 */
  brandLine: 'Web3 社交交易 · on Base',
  enterDashboard: '{brandMark} 進入 Dashboard',
  viewTraders: '查看交易者',
  connectHint: '連線後可直接瀏覽所有功能，無需註冊帳號',

  paperTrading: {
    title: '什麼是 Paper Trading？',
  },

  /** 順序由 src/lib/pepefi/landingFeatures.ts 決定。 */
  features: {
    heading: '核心功能',

    copyTitle: '社交交易',
    copyDesc: '先看交易者的鏈上部位、策略歷史與 ESG 評分，再決定要不要跟單。跟單開出的部位在你自己名下，只有你能取消。',

    /** 跟單旗標關閉的租戶，第一張卡換成這一張。 */
    rwaTitle: '代幣化 RWA',
    rwaDesc: '用 USDC 直接買賣代幣化的股、債、金、幣，鏈上鑄造與贖回，儲備率隨時看得到。',

    transparencyTitle: '鏈上透明',
    transparencyDesc: '每一筆部位、每一版策略、每一筆手續費分潤都記在鏈上；金庫的儲備率任何人都能自己算。',

    esgTitle: 'ESG 評分',
    esgDesc: '每位交易者都有 ESG 評分；標的的碳強度附上資料來源，碳分級直接反映在費用上。',

    gamefiTitle: 'GameFi：養成你的 Pepe',
    gamefiDesc: '用 PEPE 幫你的 Pepe 喝藥水、換造型、解鎖坐騎，跟著每日任務與成就一起成長。',

    perpetualsTitle: '進階：合成永續（選用）',
    perpetualsDesc: '要做多空對沖才會用到的合成永續，預設不開槓桿，全程透明上鏈。',
  },

  steps: {
    heading: '如何開始',
    one: '安裝 MetaMask，切換到 Base Sepolia testnet',
    two: '前往 Exchange，點擊「Get 1000 USDC」取得測試資金',
    three: '到「資產」頁買進 sGOLD、sBOND，回 Portfolio 看四類資產的配置與損益',
    four: '切到專家模式，到 Marketplace 看交易者的鏈上紀錄與 ESG 評分，挑一位跟單；或在 Trader 頁登記成為交易者',
  },

  /** 跟單旗標關閉時（機構租戶）替換掉的字串——不介紹一個看不到的功能。 */
  copyOff: {
    tagline: 'RWA · 代幣化資產 · Agent 原生 {brandMark}',
    brandLine: 'agent 原生代幣化 RWA · on Base',
    viewMarketplace: '瀏覽配置市集',
    stepFour: '（可選）到 Marketplace 瀏覽他人發布的資產配置，或在 Trader 頁登記並發布策略',
    heroBefore: '一個錢包，配置股、債、金、幣四大類代幣化資產。鏈上鑄造與贖回、配置市集、大盤對照，外加 ',
    heroBold: 'x402 付費訊號',
    heroAfter: '——讓 AI agent 自帶錢包、付費、自主下單。全程透明上鏈。',
    paperMid: '進行模擬交易，讓使用者無風險體驗 RWA 投資與 AI 代理交易。',
  },

  oracleDisclosure: 'Oracle 價格由部署者（admin）控制，Demo 期間會即時更新以展示 PnL 變化',

  /** 首頁徽章。網路名稱與 chainId 是技術識別碼，不譯。 */
  liveOn: '運行於 Base Sepolia 測試網 · 84532',
  /** 主視覺 logo 的替代文字；{name} 是租戶的品牌名稱。 */
  logoAlt: '{name} 標誌',

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
    heroBefore: '挑一位交易者，先看清對方的每一筆部位、每一版策略與 ESG 評分，再決定要不要跟單。',
    heroBold: '跟單開出的部位在你自己名下',
    heroAfter: '，只有你能取消；股、債、金、幣四大類代幣化資產，全程鏈上可查。',

    paperBefore: '本平台使用',
    paperBold1: '測試網代幣',
    paperMid: '進行模擬交易，讓使用者無風險體驗社交跟單、RWA 投資與 AI 代理交易。',
    paperBold2: '所有價格追蹤真實市場',
    paperAfter: '，但資金為模擬資產， 不涉及真實金錢 —— 等同 TradingView 的 Paper Trading 模式。',
  },
};
