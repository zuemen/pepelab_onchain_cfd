/**
 * 跨頁共用的字：錢包連線視窗、確認對話框、測試網徽章、版面外殼與等級名稱。
 *
 * 這些不屬於任何單一頁面，但每一頁都看得到，所以放在一起而不是散在各自的
 * feature 檔裡——否則「取消」會有七份，改一份的時候剩下六份不會跟著動。
 */
export const common = {
  /** 錢包連線視窗。 */
  wallet: {
    dialogTitle: '連接帳號 / Connect Wallet',

    /** 錢包按鈕本身與已連線後的選單。 */
    connectButton: '連接錢包',
    connecting: '連線中…',
    connectedTitle: '已連線錢包',
    switchAccount: '切換帳號',
    disconnect: '中斷連線',
    closeAria: '關閉錢包連線視窗',
    intro: '選擇您的登入通道以進入 {brand} 鏈上 RWA 平台。',

    metamaskTitle: 'MetaMask 錢包連線',
    metamaskDesc: '透過 MetaMask 瀏覽器擴充功能連線 (Base Sepolia)',
    installMetamask: '前往安裝 MetaMask 擴充功能 ↗',

    mockTitle: 'Pepe 簡報測試通道 (模擬 Web3)',
    mockDesc: '無須錢包即可一鍵進入系統、切換 Pepe 蛙頭像與測試跟單',

    /** useWallet 連線失敗的原因。 */
    error: {
      notDetected: '未偵測到 MetaMask，請先安裝瀏覽器擴充功能。',
      pending: 'MetaMask 有一個尚未處理的請求，請打開 MetaMask 並核准。',
      rejected: '連線已被拒絕，請在 MetaMask 中核准。',
      failed: '連線失敗',
    },

    /** 需要錢包的頁面在未連線時的提示。 */
    connectPrompt: {
      marketplace: '連接錢包以瀏覽市集。',
      stake: '連接錢包以管理你的質押。',
      sessions: '連接錢包以管理 agent session。',
    },
  },

  /** ⌘K 搜尋框。 */
  search: {
    placeholder: '搜尋功能…',
  },

  /** 確認對話框的預設按鈕文字，呼叫端可以各自覆寫。 */
  dialog: {
    cancel: '取消',
    confirm: '確認',
  },

  paperTrading: {
    tooltip:
      '本平台運行於測試網，所有資產與資金皆為模擬，不涉及真實金錢。等同 TradingView 的 Paper Trading 模式。',
    compactLabel: '模擬交易',
    label: 'PAPER TRADING · 測試網模擬交易',
  },

  /**
   * 版面外殼沿用自 Minimal UI 範本的元件：側邊欄開合、設定抽屜、搜尋無結果、404。
   * 原本在元件裡寫死英文，zh-TW 建置會整段露出英文。
   */
  shell: {
    logoAria: '回到首頁',
    openNavAria: '開啟導覽選單',
    expandSidebarAria: '展開側邊欄',
    collapseSidebarAria: '收合側邊欄',
    settingsAria: '顯示設定',
    backToTopAria: '回到頁首',
    accountAvatarAria: '帳戶頭像',
    accountButtonAria: '開啟帳戶選單',
    signOut: '登出',
    needHelp: '需要協助？',

    settings: {
      title: '顯示設定',
      resetAll: '全部重設',
      close: '關閉',
      mode: '深色模式',
      contrast: '高對比',
      rtl: '由右至左',
      compact: '緊湊版面',
      compactTooltip: '僅限主控台頁面，且螢幕寬度大於 1600px（xl）時才有效果',
      presets: '主題色',
      nav: '導覽列',
      navTooltip: '僅限主控台頁面',
      layout: '版面',
      color: '顏色',
      font: '字型',
      fontFamily: '字體',
      fontSize: '字級',
      fontSizeAria: '調整字級',
      fullscreen: '全螢幕',
      exitFullscreen: '離開全螢幕',
      system: '跟隨系統',
      navIntegrate: '融入',
      navApparent: '突顯',
    },

    search: {
      enterKeywords: '請輸入關鍵字',
      notFoundTitle: '找不到結果',
      /** 句中夾著使用者輸入的關鍵字（粗體），拆成前後兩段。 */
      notFoundBefore: '找不到符合',
      notFoundAfter: '的結果。',
      notFoundHint: '請檢查是否有錯字，或改用完整的詞再試一次。',
    },

    notFound: {
      title: '找不到這個頁面',
      body: '你要找的頁面不存在，可能是網址打錯了，請再確認一次。',
      home: '回到首頁',
    },
  },

  /**
   * 部位損益讀不出數字時的三種原因（終端機、投資組合、市場動態共用）。數字欄顯示「—」，
   * 原因放在旁邊或 tooltip——絕不補 0。見 lib/pepefi/positionPnl.ts。
   */
  pnlStatus: {
    unreadable: '讀取失敗',
    noPrice: '無有效價格',
    stale: '價格過期',
    unreadableHint: '這個部位的合約資料這次沒讀到（節點逾時或錯誤），不代表沒有損益。重新整理後再看。',
    noPriceHint: '預言機目前沒有這個標的的有效價格（價格為 0），合約無法估算平倉價值，所以不顯示損益。',
    staleHint: '預言機價格已超過合約允許的時間沒有更新；合約此時不接受平倉，所以不顯示損益。',
  },

  avatarPicker: {
    title: '選擇頭像',
  },

  layout: {
    skipToContent: '跳到主要內容',
    expertHint: '切換到專家模式看全部 {count} 個功能 →',
    simple: '簡單',
    expert: '專家',
    toExpertAria: '切換到專家模式',
    toSimpleAria: '切換到簡單模式',

    /** #36：網路不符的橫幅，句中夾了兩段 `<b>`。 */
    networkMismatch: {
      before: '目前連線於 ',
      mid: '。正式部署鏈是',
      primaryBefore: 'Base Sepolia（',
      primaryAfter: '）',
      after: ' —— 交易、agent session 與 x402 只在那裡。',
      sepoliaExtra: '　Sepolia 保留的是代幣化資產與金庫的對照展示。',
    },
  },

  /**
   * 合成資產揭露（資產頁、交易頁、首頁）。措辭刻意保守：這是給做盡職調查的機構看的，
   * 每一句都要能被法遵逐字檢視——不寫「安全」「保證」，也不淡化非足額抵押。
   */
  disclosure: {
    title: '重要揭露：測試網研究原型，非真實資產',
    summary: '本站所有資產、資金與交易皆為測試網模擬，不具任何真實價值。',
    prototype:
      '本站為部署於 Base Sepolia 測試網的研究原型，所有代幣、資金與交易皆為模擬，不涉及真實資產或金錢。',
    synthetic:
      '本站所有合成代幣——股票（如 sAAPL、sTSLA、sNVDA）、債券（sBOND）、黃金（sGOLD）、加密資產（sBTC、sETH）與 ETF（sICLN、sESGU）——皆為 AssetVault 發行的合成曝險，且非足額抵押：僅以預言機價格追蹤標的，平台並未持有任何標的資產，也沒有一比一的準備；持有人不具股東、債權人或基金受益人權利（包括表決權、股利或利息請求權），亦無對任何發行人或實物的求償權，贖回取決於 AssetVault 的流動性。',
    noAdvice: '本站內容僅供技術展示與研究，不構成投資建議、要約或招攬。',
    /** 白標租戶有設定營運機構時才顯示（src/tenant）。 */
    operatedBy: '本站由{operator}營運。',
    expand: '展開',
    collapse: '收合',
  },

  /** 白標租戶相關的共用字串（src/tenant）。 */
  tenant: {
    /** 資產不在租戶白名單：不能新開部位／買進，既有持倉照常出場。 */
    assetNotEnabled: '本平台未開放此資產的新交易；已持有的部位仍可賣出或平倉。',
    /** 租戶未授權永續：直接打網址進終端機時，下單面板的說明。 */
    perpetualsNotAuthorized: '本平台未開放永續部位的新交易；既有部位仍可在「部位」頁籤平倉。',
    footer: {
      support: '客服',
      legal: '法律資訊',
    },
  },

  /** 錢包在錯的鏈上時的切鏈按鈕（lib/pepefi/switchChain.ts）。 */
  switchChain: {
    cta: '切換到 Base Sepolia',
    switching: '切換中…',
    rejected: '已在錢包中取消切換。',
    failed: '錢包無法切換網路，請在錢包中手動切到 Base Sepolia（chainId 84532）。',
  },

  /** 商業版旗標關閉時，直接打網址看到的頁面（見 lib/pepefi/featureFlags.ts）。 */
  featureDisabled: {
    title: '此功能未啟用',
    body: '這個部署沒有開啟此功能。如需使用，請聯繫平台營運方。',
    backHome: '回到首頁',
  },

  account: {
    displayNameLabel: '編輯暱稱',
    saveName: '儲存變更',
    closeAria: '關閉帳戶選單',
    notConnected: '尚未連接錢包',
    nicknamePlaceholder: '輸入暱稱…',
  },

  /**
   * 交易者等級。名稱刻意是「英文 中文」的雙語形式，逐字保留——英文那一半是
   * 排行榜與合約事件裡用的名字，中文那一半是給讀者的。
   */
  /** 交易者等級徽章前面的小字（TraderRankBadge）。 */
  rankPrefix: '等級',

  tier: {
    diamond: 'Diamond 鑽石',
    gold: 'Gold 黃金',
    silver: 'Silver 白銀',
    bronze: 'Bronze 青銅',
  },

  /**
   * x402 結算用的 Circle 官方 USDC。**永遠帶著發行方名字。**
   *
   * 平台保證金現在畫面上就叫「USDC」（見 ADR-0002 規則 1），和這顆真錢撞名，
   * 唯一分得開的東西就是 `Circle` 這個字。少了它，使用者會以為水龍頭領的測試幣
   * 可以拿來付 x402。
   */
  x402StableLabel: 'Circle USDC',
};
