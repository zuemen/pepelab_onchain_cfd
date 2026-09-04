import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/terminal.ts`。
 */
export const terminal: Catalog['terminal'] = {
  connectWallet: 'Connect wallet to open the terminal.',

  header: {
    tagline: 'agent-native perps · base sepolia',
    status: 'on-chain · live',
  },

  /** 行情列。每個 Stat 的 hint 都是滑鼠提示，`\n\n` 是段落分隔。 */
  stats: {
    perpSuffix: '-PERP',
    displayPrice: 'display price',

    index: 'Index (oracle · settles here)',
    indexHint:
      'The on-chain oracle price — also what you actually trade at.\n\nOpening, closing, and liquidation all settle at this price, independent of the display price and candlestick chart above — those are external market references. The oracle is written on-chain periodically by the keeper, so it lags the market a little.',

    mark: 'Mark (OI premium)',
    markHint:
      'The index price adjusted by a premium for long/short imbalance.\n\nWhen longs significantly outweigh shorts, mark trades above index, and vice versa. This makes PnL and liquidation reflect the risk of "everyone leaning the same way," not just the raw oracle price.',

    funding: 'Funding',
    fundingHint:
      'A periodic payment between longs and shorts that pulls the price back toward the index.\n\nPositive = longs pay shorts (longs are crowded); negative is the reverse. While you hold a position, this rate accrues as a cost or a gain.',

    carbon: 'Carbon tier · fee · max leverage',
    carbonHint:
      "Which carbon-intensity band this asset falls in, and the trading fee and leverage ceiling that follow from it.\n\nThe rule is fixed in the CarbonTiers contract, not a settable parameter: the higher the carbon, the more it costs to hold here and the less leverage it can carry. Unrated (no unexpired attestation) always falls to the most conservative tier — top fee, 1x.",
    carbonValue: '{tier} · {fee} bps · ≤{lev}×',

    openInterest: 'Open interest L/S',
    openInterestHint:
      'The notional value of this asset\'s open long / short positions on-chain right now.\n\nThe bigger the gap between the two, the more one-sided the market is, and the funding rate grows with it. A "—" means the on-chain read failed, not that there are no positions.',

    vaultBacking: 'Vault backing',
    vaultBackingHint:
      "The Insurance Vault's current size — the backstop that absorbs losses beyond a liquidated position's margin in extreme markets.\n\n$0 means the vault is deployed but nobody has funded it yet, so the platform has no extra solvency buffer right now. That's the real testnet state, not a display bug.",

    sourceCoingecko: 'display · coingecko',
    sourceOracle: 'display · on-chain oracle',
    sourceSimulated: 'simulated feed',

    /**
     * 接在報價來源後面的價齡。前導空白是值的一部分：畫面上本來就是
     * `display · coingecko · index 3 分鐘前`，那個空白不是排版意外。
     */
    indexAge: ' · index {age}',
  },

  /** 下單面板。 */
  ticket: {
    long: 'LONG',
    short: 'SHORT',
    sideLong: 'Long',
    sideShort: 'Short',

    leverage: 'Leverage',
    margin: 'Margin',
    free: 'free: {amount}',
    marginAria: 'Margin ({token})',

    notional: 'Notional',
    entryOracle: 'Entry (oracle)',
    estLiquidation: 'Est. Liquidation',
    onLiquidation: 'On liquidation',
    onLiquidationValue: 'Refunded minus penalty',
    funding8h: 'Funding rate (8h)',

    enterMargin: 'Enter margin',
    insufficientFreeMargin: 'Insufficient free margin — deposit first',
    opened: '{side} {asset} opened ✓',

    /** 受管制標的的三種 KYC 狀態，各自是完整的一句話。 */
    kycUnknown:
      "⚠ Can't confirm KYC status (on-chain read failed). The compliance gate is fail-closed, so trading {asset} is paused.",
    kycPending:
      '⏳ {asset} requires KYC: application submitted, awaiting reviewer approval — unlocks automatically once approved',
    kycRequired:
      '🔒 {asset} requires KYC — submit an application on the Exchange page (review required after submitting)',

    riskNotice:
      '⚠️ Testnet: this platform is an oracle-priced perpetual — PnL settles at mark price (including OI imbalance); in extreme one-sided markets, paper profit may be adjusted by ADL auto-deleveraging; margin is a test token.',
    showRiskNotice: '⚠️ Show risk notice',

    submitting: 'Opening…',
    insufficientMargin: 'Insufficient margin',
    ctaOpen: 'Open {side} {asset}',
  },

  /** 帳戶區。 */
  account: {
    equity: 'Equity',
    freeMargin: 'Free Margin',
    unrealizedPnl: 'Unrealised PnL',
    wallet: 'Wallet {token}',
    marginNote: 'margin settles in USDC · USDT is hold/swap only',

    enterAmount: 'Enter amount',
    deposited: 'Deposited {amount} USDC ✓',

    depositPlaceholder: 'deposit',
    depositAria: 'Deposit amount (USDC)',
    deposit: 'Deposit',
  },

  /** 持倉區的分頁殼。 */
  panel: {
    tabPositions: 'Positions ({count})',
    tabFills: 'Fills',
    tabFunding: 'Funding',
    refresh: '↺ refresh',
  },

  positions: {
    column: {
      asset: 'Asset',
      side: 'Side',
      entry: 'Entry',
      mark: 'Mark',
      margin: 'Margin',
      leverage: 'Lev',
      pnl: 'PnL',
    },
    empty: 'no open positions',
    long: 'LONG',
    short: 'SHORT',
    closed: 'Closed ✓',
    close: 'Close',
    stale: 'Price stale',
  },

  fills: {
    column: {
      type: 'Type',
      asset: 'Asset',
      side: 'Side',
      price: 'Price',
      pnl: 'PnL',
      tx: 'Tx',
    },
    kind: {
      opened: 'Open',
      closed: 'Close',
      liquidated: 'Liquidated',
    },
    loading: 'Loading on-chain fills…',
    empty: 'No recent fills',
    readError: "Couldn't read on-chain fills",
    long: 'LONG',
    short: 'SHORT',
  },

  funding: {
    column: {
      asset: 'Asset',
      rate: 'Rate (8h)',
      longOi: 'Long OI',
      shortOi: 'Short OI',
      lastSettled: 'Last settled',
    },
    empty: 'No funding data',

    /** 上次結算多久以前。四種區間各自是完整的一句話。 */
    agoNever: 'Never',
    agoSeconds: '{n}s ago',
    agoMinutes: '{n}m ago',
    agoHours: '{n}h ago',

    canSettle: 'Settleable',
    note: 'Only lists assets with funding registered on-chain. A positive value means longs pay shorts.',
  },

  /** 市場活動面板（取代原本的交易所盤口）。 */
  activity: {
    title: 'Market activity',
    onChainBadge: '● on-chain',

    column: {
      side: 'Side',
      margin: 'Margin',
      entry: 'Entry',
      time: 'Time',
      pnl: 'PnL',
    },

    loading: 'Loading on-chain positions…',
    emptyForAsset: 'No on-chain positions for {asset} right now',
    /** 標的代號還沒讀到時，`emptyForAsset` 用的代稱。 */
    thisAsset: 'this asset',

    long: 'LONG',
    short: 'SHORT',
    openMarker: 'open',

    truncated: "Only scanning the most recent positions — older ones aren't listed",
    missed: '{count} entries were not read due to RPC rate limiting — the list may be incomplete',
  },

  /** 圖表面板。 */
  chart: {
    /** 價格線上的圖例文字。 */
    lineIndex: 'index',
    lineMark: 'mark',

    last: 'chart last',
    loadingOlder: 'Loading earlier…',
    exhausted: 'Reached earliest data',
    atCapacity: 'Display limit reached',

    disclaimer:
      "The chart is reference pricing from an external public source, not this platform's trade record — opening, closing, and liquidation all settle at the on-chain oracle index price.",

    error: "Couldn't load candles",
    loading: 'Loading candles…',

    /** 來源徽章。 */
    sourceSimulated: 'SIMULATED',
    sourceNamed: 'data · {name}',
    sourceFallbackSuffix: ' (fallback)',
    sourceFallbackReason: 'Fell back to a backup source: {error}',
  },

  /**
   * K 線 API 的錯誤。「基本訊息」與「基本訊息＋提示」寫成兩條完整的句子，
   * 而不是一句加一段可選的尾巴——尾巴單獨進 catalog 就沒辦法翻。
   */
  candles: {
    unreachable: "Can't reach the market-data API ({url}).",
    unreachableDev:
      "Can't reach the market-data API ({url}). Start signal-api first: cd agent/signal-api && npx tsx src/index.ts",
    httpError: 'Market-data API returned {status} ({url})',
    httpError404:
      'Market-data API returned {status} ({url}) — this deployment may not include the /candles route yet; redeploy signal-api',
  },

  /** 訂單簿欄的收合開關。 */
  book: {
    show: 'Show order book panel',
    hide: 'Hide order book panel',
  },
};
