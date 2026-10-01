import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/common.ts`。
 */
export const common: Catalog['common'] = {
  /** 錢包連線視窗。 */
  wallet: {
    dialogTitle: 'Connect Wallet',
    closeAria: 'Close wallet connection dialog',
    intro: 'Choose your sign-in channel to enter the {brand} on-chain RWA platform.',

    metamaskTitle: 'Connect with MetaMask',
    metamaskDesc: 'Connect via the MetaMask browser extension (Base Sepolia)',
    installMetamask: 'Install the MetaMask extension ↗',

    mockTitle: 'Pepe Demo Channel (Mock Web3)',
    mockDesc: 'No wallet needed — jump straight in, switch Pepe avatars, and try copy trading',

    error: {
      notDetected: 'MetaMask not detected — please install the extension.',
      pending: 'MetaMask has a pending request — open MetaMask and approve it.',
      rejected: 'Connection rejected — please approve in MetaMask.',
      failed: 'Connection failed',
    },

    connectPrompt: {
      marketplace: 'Connect wallet to browse the marketplace.',
      stake: 'Connect wallet to manage your stake.',
      sessions: 'Connect wallet to manage agent sessions.',
    },
  },

  search: {
    placeholder: 'Search…',
  },

  /** 確認對話框的預設按鈕文字，呼叫端可以各自覆寫。 */
  dialog: {
    cancel: 'Cancel',
    confirm: 'Confirm',
  },

  paperTrading: {
    tooltip:
      "This platform runs on a testnet — every asset and balance is simulated, no real money involved. Equivalent to TradingView's Paper Trading mode.",
    compactLabel: 'PAPER TRADING',
    label: 'PAPER TRADING · Simulated testnet trading',
  },

  avatarPicker: {
    title: 'Choose an avatar',
  },

  layout: {
    skipToContent: 'Skip to main content',
    expertHint: 'Switch to Expert Mode to see all {count} features →',
    simple: 'Simple',
    expert: 'Expert',
    toExpertAria: 'Switch to Expert Mode',
    toSimpleAria: 'Switch to Simple Mode',

    /** #36：網路不符的橫幅，句中夾了兩段 `<b>`。 */
    networkMismatch: {
      before: 'Currently connected to ',
      mid: '. The chain this app is deployed on is ',
      primaryBefore: 'Base Sepolia (',
      primaryAfter: ')',
      after: ' — trading, agent sessions, and x402 only work there.',
      sepoliaExtra: ' Sepolia is kept around as a comparison showcase for tokenized assets and the vault.',
    },
  },

  disclosure: {
    title: 'Important disclosure: testnet research prototype — no real assets',
    summary: 'Every asset, balance and trade on this site is simulated on a testnet and has no real-world value.',
    prototype:
      'This site is a research prototype deployed on the Base Sepolia testnet. All tokens, funds and trades are simulated; no real assets or money are involved.',
    synthetic:
      'Every synthetic token on this site — equities (e.g. sAAPL, sTSLA, sNVDA), bonds (sBOND), gold (sGOLD), crypto (sBTC, sETH) and ETFs (sICLN, sESGU) — is an under-collateralized synthetic exposure issued by the AssetVault. Each tracks its underlying through an oracle price only; the platform holds none of the underlying assets and keeps no one-to-one reserve. Holders have no shareholder, creditor or fund-holder rights (including voting, dividend or coupon rights) and no claim against any issuer or physical asset; redemption depends on the liquidity of the AssetVault.',
    noAdvice: 'Nothing on this site constitutes investment advice, an offer, or a solicitation.',
    operatedBy: 'This site is operated by {operator}.',
    expand: 'Expand',
    collapse: 'Collapse',
  },

  tenant: {
    assetNotEnabled:
      'This platform does not offer new trades in this asset; existing holdings can still be sold or closed.',
    perpetualsNotAuthorized:
      'This platform does not offer new perpetual positions; existing positions can still be closed from the Positions tab.',
    footer: {
      support: 'Support',
      legal: 'Legal',
    },
  },

  switchChain: {
    cta: 'Switch to Base Sepolia',
    switching: 'Switching…',
    rejected: 'The switch was cancelled in your wallet.',
    failed: 'Your wallet could not switch networks. Switch to Base Sepolia (chainId 84532) manually in your wallet.',
  },

  featureDisabled: {
    title: 'This feature is not enabled',
    body: 'This deployment does not have this feature turned on. Contact the platform operator if you need it.',
    backHome: 'Back to home',
  },

  account: {
    displayNameLabel: 'Display Name',
    saveName: 'Save Name',
    closeAria: 'Close account menu',
    notConnected: 'Wallet not connected',
    nicknamePlaceholder: 'Enter nickname…',
  },

  /**
   * 交易者等級。zh-TW 是「英文 中文」的雙語形式——英文那一半是排行榜與合約事件裡用
   * 的名字，中文那一半是給讀者的說明。en 版讀者已經看得懂那個英文名字本身，不需要
   * 再翻出第二份說明，所以就是單一個字。
   */
  tier: {
    diamond: 'Diamond',
    gold: 'Gold',
    silver: 'Silver',
    bronze: 'Bronze',
  },

  /** x402 結算用的 Circle 官方 USDC。發行方名字是和平台模擬幣唯一的區別，不可省略。 */
  x402StableLabel: 'Circle USDC',
};
