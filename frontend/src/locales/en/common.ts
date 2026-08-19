import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/common.ts`。搬移階段逐字複製原文。
 */
export const common: Catalog['common'] = {
  /** 錢包連線視窗。 */
  wallet: {
    dialogTitle: '連接帳號 / Connect Wallet',
    closeAria: '關閉錢包連線視窗',
    intro: '選擇您的登入通道以進入 PepeLab 鏈上衍生品系統。',

    metamaskTitle: 'MetaMask 錢包連線',
    metamaskDesc: '透過 MetaMask 瀏覽器擴充功能連線 (Base Sepolia)',
    installMetamask: '前往安裝 MetaMask 擴充功能 ↗',

    mockTitle: 'Pepe 簡報測試通道 (模擬 Web3)',
    mockDesc: '無須錢包即可一鍵進入系統、切換 Pepe 蛙頭像與測試跟單',
  },

  /** 確認對話框的預設按鈕文字，呼叫端可以各自覆寫。 */
  dialog: {
    cancel: '取消',
    confirm: '確認',
  },

  paperTrading: {
    tooltip:
      '本平台運行於測試網，所有資產與資金皆為模擬，不涉及真實金錢。等同 TradingView 的 Paper Trading 模式。',
    compactLabel: 'PAPER TRADING',
    label: 'PAPER TRADING · 測試網模擬交易',
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
      sepoliaExtra: '　Sepolia 保留的是代幣化資產與 V2 金庫展示。',
    },
  },

  account: {
    displayNameLabel: 'Display Name',
    saveName: 'Save Name',
  },

  /**
   * 交易者等級。名稱刻意是「英文 中文」的雙語形式，逐字保留——英文那一半是
   * 排行榜與合約事件裡用的名字，中文那一半是給讀者的。
   */
  tier: {
    diamond: 'Diamond 鑽石',
    gold: 'Gold 黃金',
    silver: 'Silver 白銀',
    bronze: 'Bronze 青銅',
  },

  /** x402 結算用的官方 USDC，和平台自己的模擬穩定幣要分得開。 */
  x402StableLabel: '官方 USDC',

  /**
   * 通知鈴鐺的固定示範內容。每則拆成 `{text, bold?}` 片段陣列而不是 HTML 字串——
   * `notification-item.tsx` 曾經用 `dangerouslySetInnerHTML` 直接塞 `<p><strong>…`，
   * 那等於把標記存進資料而不是畫面結構，#26 不允許。片段陣列讓組件自己決定怎麼
   * 排版，catalog 只放純文字。
   *
   * #38：`GigaPepe 🦾`、`Elon Frog 🚀`、`@Jaydon Frankie` 這類虛構使用者代稱不翻譯——
   * 它們是特定帳號的識別名，性質上與 ADR-0002 的協定/產品專有名詞同一類（翻譯
   * 使用者自己取的名字等於改名，不是在地化），不是漏翻。
   */
  notification: {
    friendRequestBold: 'GigaPepe 🦾',
    friendRequestAfter: ' sent you a copy-trade follow request!',

    pairedBold1: 'Elon Frog 🚀',
    pairedMid: ' paired with you! You both earned ',
    pairedBold2: '200 PEPE',
    pairedAfter: ' copy rewards! 🤝',

    potionBefore: '🧪 Your ',
    potionBold: 'Golden Elixir',
    potionAfter: ' purchase was successful! (-300 PEPE)',

    skinBefore: '👑 穿戴變更成功！您已換上最新的 ',
    skinBold: 'Astronaut Suit',
    skinAfter: ' 華麗衣裝！',

    whaleAlertBefore: '💰 ',
    whaleAlertBold1: 'Whale Alert',
    whaleAlertMid: ': A copy whale just locked ',
    whaleAlertBold2: '$50,000 USDC',
    whaleAlertAfter: ' to follow your strategy!',

    checkinBefore: '📅 ',
    checkinBold1: '每日簽到提醒',
    checkinMid: '：您今天還沒簽到喔！點擊去領取今日 ',
    checkinBold2: '+50 PEPE',
    checkinAfter: ' 激勵！',

    tierUpBefore: '📈 您的交易量突破等級閾值，成功解鎖 ',
    tierUpBold: 'Gold 🥇',
    tierUpAfter: ' 等級，並獲得一次性獎勵 10,000 PEPE！',

    miningBefore: '⛏️ 您開倉的槓桿交易頭寸已累積可申領 ',
    miningBold: '4,200 PEPE',
    miningAfter: ' 交易挖礦獎勵！',

    vaultRebalancedBefore: '🛡️ ',
    vaultRebalancedBold: 'Insurance Vault',
    vaultRebalancedAfter: ' has fully rebalanced! Platform risk index is extremely low & SAFU.',

    /** 專案協作卡片示範用的固定內容（非 PepeFi 特有，沿用範本情境）。 */
    projectFeedbackBold: '@Jaydon Frankie',
    projectFeedbackAfter: ' feedback by asking questions or just leave a note of appreciation.',
  },
};
