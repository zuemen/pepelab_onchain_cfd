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

  /**
   * 平台特色：每張卡是「痛點 → 我們的做法」，要解決的問題與功能在同一張卡講完。
   * 順序由 src/lib/pepefi/landingFeatures.ts 決定。
   */
  features: {
    heading: '平台特色',
    painLabel: '痛點',
    solutionLabel: '我們的做法',

    social: {
      title: '社交交易：每一步都在鏈上',
      pain: '跟單平台自己公布交易者的績效，虧損紀錄可以刪掉或藏起來，跟隨者無從查證；交易者賠了錢也不用負責；跟單的錢還得先交給平台託管，平台出事就拿不回來。',
      solution: '交易者的每一筆部位、每一版策略都記在鏈上，排行榜的數字可以回頭驗證。交易者要先質押才能被跟單，跟隨者取消跟單時若虧損超過門檻，交易者的質押會被罰沒。跟單預設複製交易者當下那一版策略，對方改版會標示「策略已更新」；也可以在鏈上開啟自動同步（ADR-024，需跟單合約已升級），之後任何人都能、也只能把你的部位調成交易者鏈上最新版，不能選資產、方向或槓桿。AI agent 也能替你準備跟單與同步的待簽交易，簽不簽由你的錢包決定。跟單開出的部位在你自己名下，一鍵取消就全部平倉。',
    },

    assets: {
      title: '整合四大資產',
      pain: '股票、債券、黃金、加密貨幣分散在券商、銀行、交易所，要開好幾個帳戶、看好幾個 App；海外股債還有最低金額與開戶門檻，很難一眼看出整體配置。',
      solution: '一個錢包就能小額買進 Apple、Tesla、NVIDIA 等股票、債券、黃金、BTC、ETH 與 ESG ETF 共 11 種代幣化資產。投資組合頁依股、債、金、幣四類列出配置與損益，並從你目前最早一筆持倉那天起，對照 S&P 500、黃金、BTC 的表現。這些是追蹤價格的合成曝險，不代表持有真實股票或債券。',
    },

    transparency: {
      title: '鏈上透明',
      pain: '平台說自己有準備金、說收入怎麼分、說虧損由誰吸收，使用者都只能相信；出事之前，沒有人能自己驗證。',
      solution: '金庫的儲備率由鏈上的持有與應付數字算出，任何人都能自己算；低於下限時只停止新鑄造，不停止贖回。x402 等收入依 70／20／10 由合約自動分潤，清算罰金進保險金庫，損失吸收順序公開可查。鏈上動態牆即時列出平台上的交易。營運方還保有哪些權限，下方「你的資產在哪裡」直接列出。',
    },

    esg: {
      title: 'ESG 不漂綠',
      pain: '各家 ESG 評分標準不同、看不到資料來源，貼上「綠色」標籤就算數；評分高低也不影響任何實際成本。',
      solution: '我們用有單位、有出處的碳強度定價（例如每百萬美元營收的排放量）。每一筆見證都記下是誰、何時、讀了哪份資料，而且會過期。多家見證說法不一致時，畫面直接顯示分歧，不取平均掩蓋。碳分級直接決定費用與槓桿上限，越高碳越貴；沒有資料的標的一律以最保守的級距計價。',
    },

    gamefi: {
      title: 'GameFi：養成你的 Pepe',
      pain: '投資介面冷冰冰，新手不知道從哪裡開始，也很難持續回來。',
      solution: '每位使用者都有一隻會進化的 Pepe。用 PEPE 幣喝藥水累積經驗、抽造型、在對應等級解鎖坐騎，買造型花掉的 PEPE 幣會直接銷毀。每日任務帶你一步步熟悉平台，成就記錄分散配置、低碳投資這些好習慣。',
    },

    agent: {
      title: 'Agent 原生：x402 與 agent session',
      pain: '想讓 AI 幫忙交易，就得交出私鑰或交易所 API key，AI 能動用的金額沒有上限；AI 要買資料，還得替它註冊帳號、綁信用卡、按月訂閱。',
      solution: '用 agent session 授權 AI 代你下單，額度寫在鏈上：每筆金額、總預算、槓桿上限、可交易的資產與到期日，你隨時可以撤銷，AI 也碰不到你的私鑰。AI 用 x402 按次付 USDC 取得交易訊號，不用帳號，收入同樣在鏈上分潤。內建 10 個 MCP 工具：8 個唯讀，讓 LLM agent 查交易者績效、部位與 session，也能替你準備好未簽名的交易、交給你自己的錢包簽；另外 2 個在 session 額度內下單，送出前一律跳出確認，由你本人按下。',
    },

    perpetuals: {
      title: '進階：合成永續（選用）',
      pain: '想做多空對沖，又怕一進場就碰到高槓桿。',
      solution: '合成永續預設不開槓桿，全程透明上鏈。',
    },
  },

  steps: {
    heading: '如何開始',
    one: '安裝 MetaMask，切換到 Base Sepolia testnet',
    two: '前往 Exchange，點擊「Get 1000 USDC」取得測試資金',
    three: '到「資產」頁買進 XAU、BGRN，回 Portfolio 看四類資產的配置與損益',
    four: '切到專家模式，到 Marketplace 看交易者的鏈上紀錄與碳分級組成，挑一位跟單；或在 Trader 頁登記成為交易者',
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
    heroBefore: '挑一位交易者，先看清對方的每一筆部位、每一版策略與碳分級組成，再決定要不要跟單。',
    heroBold: '跟單開出的部位在你自己名下',
    heroAfter: '，只有你能取消；股、債、金、幣四大類代幣化資產，全程鏈上可查。',

    paperBefore: '本平台使用',
    paperBold1: '測試網代幣',
    paperMid: '進行模擬交易，讓使用者無風險體驗社交跟單、RWA 投資與 AI 代理交易。',
    paperBold2: '所有價格追蹤真實市場',
    paperAfter: '，但資金為模擬資產， 不涉及真實金錢 —— 等同 TradingView 的 Paper Trading 模式。',
  },
};
