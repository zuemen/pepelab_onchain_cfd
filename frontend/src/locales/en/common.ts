import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/common.ts`。
 */
export const common: Catalog['common'] = {
  /** 錢包連線視窗。 */
  wallet: {
    dialogTitle: 'Connect Wallet',

    connectButton: 'Connect Wallet',
    connecting: 'Connecting…',
    connectedTitle: 'Connected Wallet',
    switchAccount: 'Switch Account',
    disconnect: 'Disconnect',
    closeAria: 'Close wallet connection dialog',
    intro: 'Choose your sign-in channel to enter the {brand} on-chain RWA platform.',

    metamaskTitle: 'Connect with MetaMask',
    metamaskDesc: 'Connect via the MetaMask browser extension (Base Sepolia)',
    installMetamask: 'Install the MetaMask extension ↗',

    mockTitle: 'Pepe Guest Channel (no wallet)',
    mockDesc: 'No wallet needed — jump straight in, switch Pepe avatars, and try copy investing',

    error: {
      notDetected: 'MetaMask not detected — please install the extension.',
      pending: 'MetaMask has a pending request — open MetaMask and approve it.',
      rejected: 'Connection rejected — please approve in MetaMask.',
      failed: 'Connection failed',
    },

    connectPrompt: {
      marketplace: 'Connect wallet to browse the marketplace.',
      stake: 'Connect wallet to manage your performance deposit.',
      sessions: 'Connect wallet to manage AI agent allowances.',
      feed: 'Connect wallet to see the on-chain feed.',
    },
  },

  search: {
    placeholder: 'Search…',
  },

  /** 確認對話框的預設按鈕文字，呼叫端可以各自覆寫。 */
  dialog: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    expandList: 'Show all {count}',
    close: 'Close',
  },

  paperTrading: {
    tooltip:
      "This platform runs on a testnet — every asset and balance is simulated, no real money involved. Equivalent to TradingView's Paper Trading mode.",
    compactLabel: 'SIMULATED',
    label: 'SIMULATED · Simulated testnet investing',
  },

  shell: {
    logoAria: 'Go to home page',
    openNavAria: 'Open navigation menu',
    expandSidebarAria: 'Expand sidebar',
    collapseSidebarAria: 'Collapse sidebar',
    settingsAria: 'Settings button',
    backToTopAria: 'Back to top',
    accountAvatarAria: 'Account avatar',
    accountButtonAria: 'Account button',
    signOut: 'Logout',
    errorTitle: 'Something went wrong',
    errorBody: 'Please refresh the page. If that does not help, go back to the home page.',
    errorReload: 'Refresh',
    errorHome: 'Home',

    settings: {
      title: 'Settings',
      resetAll: 'Reset all',
      close: 'Close',
      mode: 'Mode',
      contrast: 'Contrast',
      rtl: 'Right to left',
      compact: 'Compact',
      compactTooltip: 'Dashboard only and available at large resolutions > 1600px (xl)',
      presets: 'Presets',
      nav: 'Nav',
      navTooltip: 'Dashboard only',
      layout: 'Layout',
      color: 'Color',
      font: 'Font',
      fontFamily: 'Family',
      fontSize: 'Size',
      fontSizeAria: 'Change font size',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Exit',
      system: 'System',
      navIntegrate: 'Integrate',
      navApparent: 'Apparent',
    },

    search: {
      enterKeywords: 'Please enter keywords',
      notFoundTitle: 'Not found',
      notFoundBefore: 'No results found for',
      notFoundAfter: '.',
      notFoundHint: 'Try checking for typos or using complete words.',
    },

    notFound: {
      title: 'Sorry, page not found!',
      body: 'Sorry, we couldn’t find the page you’re looking for. Perhaps you’ve mistyped the URL? Be sure to check your spelling.',
      home: 'Go to home',
    },
  },

  pnlStatus: {
    unreadable: 'read failed',
    noPrice: 'no valid price',
    stale: 'price stale',
    unreadableHint: 'This investment’s on-chain data could not be read this time (node timeout or error). It does not mean there is no PnL — refresh to try again.',
    noPriceHint: 'The price source has no valid price for this asset right now (price is 0), so its sale value cannot be estimated and no PnL is shown.',
    staleHint: 'The price source is older than the on-chain program allows; selling is not possible right now, so no PnL is shown.',
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
    /** 頂部列的「中 / EN」按鈕群組（issue #396）。按鈕上的字是各語言自己的名稱，在 catalogs.ts。 */
    localeSwitchAria: 'Switch language',

    /** #36：網路不符的橫幅，句中夾了兩段 `<b>`。 */
    networkMismatch: {
      before: 'Currently connected to ',
      mid: '. The chain this app is deployed on is ',
      primaryBefore: 'Base Sepolia (',
      primaryAfter: ')',
      after: ' — buying and selling, AI agent allowances, and x402 only work there.',
      sepoliaExtra: ' Sepolia is kept around as a comparison showcase for tokenized assets and the vault.',
    },
  },

  disclosure: {
    title: 'Important disclosure: testnet research prototype — no real assets',
    summary: 'Every asset, balance and buy/sell record on this site is simulated on a testnet and has no real-world value.',
    prototype:
      'This site is a research prototype deployed on the Base Sepolia testnet. All tokens, funds and buy/sell records are simulated; no real assets or money are involved.',
    synthetic:
      'Every synthetic token on this site — equities (e.g. AAPL, TSLA, NVDA), bonds (BGRN), gold (XAU), crypto (BTC, ETH) and ETFs (ICLN, ESGU) — is an under-collateralized synthetic exposure issued by the AssetVault. Each only tracks the price of its underlying, using a price source; the platform holds none of the underlying assets and keeps no one-to-one reserve. Holders have no shareholder, creditor or fund-holder rights (including voting, dividend or coupon rights) and no claim against any issuer or physical asset; redemption depends on the liquidity of the AssetVault.',
    noAdvice: 'Nothing on this site constitutes investment advice, an offer, or a solicitation.',
    operatedBy: 'This site is operated by {operator}.',
    expand: 'Expand',
    collapse: 'Collapse',
  },

  tenant: {
    assetNotEnabled:
      'This platform does not offer buying this asset; what you already hold can still be sold.',
    perpetualsNotAuthorized:
      'This platform does not offer new buys of this kind of advanced investment; what you already hold can still be sold from your holdings list.',
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
  rankPrefix: 'Reputation',
  rankTooltip: 'From the performance deposit and deduction record: deposit ÷ (deposit + deducted amount × 5) × 100, so a strategy sharer never penalized scores 100. Currently {tier} tier. Not a measure of performance.',
  rankUnknown: '—',

  tier: {
    diamond: 'Diamond',
    gold: 'Gold',
    silver: 'Silver',
    bronze: 'Bronze',
  },

  /** x402 結算用的 Circle 官方 USDC。發行方名字是和平台模擬幣唯一的區別，不可省略。 */
  x402StableLabel: 'Circle USDC',
};
