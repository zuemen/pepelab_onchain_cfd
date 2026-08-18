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
    displayNameLabel: 'Display Name (編輯暱稱)',
    saveName: 'Save Name (儲存變更)',
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
};
