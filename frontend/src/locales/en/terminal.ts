import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/terminal.ts`。
 */
export const terminal: Catalog['terminal'] = {
  connectWallet: 'Connect wallet to open the advanced investing tools.',

  header: {
    tagline: 'AI-agent native · digital-asset investing · base sepolia',
    status: 'on-chain · live',
  },

  /** 行情列。每個 Stat 的 hint 都是滑鼠提示，`\n\n` 是段落分隔。 */
  stats: {
    closeHintAria: 'Close explanation',
    perpSuffix: '',
    displayPrice: 'display price',

    index: 'Index (price source · used to settle)',
    indexHint:
      'The index price written on-chain by the price source.\n\nBuying, selling and automatic settlement use the mark price: this price plus a premium for the up/down imbalance (the two are equal when the premium cap is 0). All of this is independent of the display price and candlestick chart above — those are external market references. The price is written on-chain periodically by the operator\'s program, so it lags the market a little.',

    mark: 'Mark (imbalance premium)',
    markHint:
      'The index price adjusted by a premium for the imbalance between price-up and price-down investments.\n\nWhen price-up investments clearly outweigh price-down ones, mark sits above index, and vice versa. This makes profit/loss and automatic settlement reflect the risk of "everyone leaning the same way," not just the raw price-source quote.',

    funding: 'Funding',
    fundingHint:
      'A periodic payment between price-up and price-down investments that pulls the price back toward the index.\n\nPositive = the price-up side pays the price-down side (price-up is crowded); negative is the reverse. While you hold an investment, this rate accrues as a cost or a gain.',

    carbon: 'Carbon tier · fee · max amplification',
    carbonHint:
      "Which carbon-intensity band this asset falls in, and the fee and amplification ceiling that follow from it.\n\nThe rule is fixed in a public on-chain program (CarbonTiers), not a settable parameter: the higher the carbon, the more it costs to hold here and the less it can be amplified. Unrated (no unexpired attestation) always falls to the most conservative tier — top fee, 1x (no amplification).",
    carbonValue: '{tier} · {fee} bps · ≤{lev}×',

    openInterest: 'Total held up/down',
    openInterestHint:
      'The size of this asset\'s price-up / price-down investments held on-chain right now.\n\nThe bigger the gap between the two, the more one-sided the market is, and the funding rate grows with it. A "—" means the on-chain read failed, not that nobody holds any.',

    vaultBacking: 'Risk reserve',
    vaultBackingHint:
      "The risk reserve's current size — the backstop that absorbs the part of a loss that goes beyond the amount invested in extreme markets.\n\n$0 means the reserve is deployed but nobody has funded it yet, so the platform has no extra solvency buffer right now. That's the real on-chain state, not a display bug.",

    sourceCoingecko: 'display · coingecko',
    sourceOracle: 'display · on-chain price source',
    sourceNone: 'no price',

    /**
     * 接在報價來源後面的價齡。前導空白是值的一部分：畫面上本來就是
     * `display · coingecko · index 3 分鐘前`，那個空白不是排版意外。
     */
    indexAge: ' · index {age}',
  },

  /** 下單面板。 */
  ticket: {
    long: 'PRICE UP',
    short: 'PRICE DOWN',
    sideLong: 'Price up',
    sideShort: 'Price down',

    leverage: 'Amplification',
    margin: 'Amount invested',
    free: 'free: {amount}',
    marginAria: 'Amount invested ({token})',

    notional: 'Investment size',
    entryOracle: 'Est. buy price (index)',
    noPriceNotice:
      "⛔ Can't read the on-chain index price, so the buy price and automatic settlement price can't be computed. Nothing can be sent until a price is available.",
    estLiquidation: 'Est. automatic settlement price',
    onLiquidation: 'On automatic settlement',
    onLiquidationValue: 'Remainder refunded minus penalty',
    fundingRate: 'Funding rate ({interval})',
    tradingParams: 'Fee · max amplification',
    tradingParamsValue: '{fee} bps · ≤{lev}× · {source}',
    paramsSource: {
      chain: 'source: on-chain',
      static: 'source: static table',
      pending: 'loading (capped at 1×, no amplification, for now)',
    },

    enterMargin: 'Enter amount to invest',
    insufficientFreeMargin: 'Not enough available funds — deposit first',
    opened: '{side} {asset} submitted ✓',

    /** 受管制標的的三種 KYC 狀態，各自是完整的一句話。 */
    kycUnknown:
      "⚠ Can't confirm KYC status (on-chain read failed). To stay safe, buying and selling {asset} is paused until it is confirmed.",
    kycPending:
      '⏳ {asset} requires KYC: application submitted, awaiting reviewer approval — unlocks automatically once approved',
    kycRequired:
      '🔒 {asset} requires KYC. Submit it from the KYC card on the Portfolio page (approved as soon as you submit).',
    kycGoToPortfolio: 'Go to Portfolio to submit',
    marketModeBlocked: 'This asset is closed or paused, so no new buys are possible.',
    insufficientWithFee: 'Not enough to invest after fees',
    kycRequiredVc:
      '🔒 {asset} is an RWA market — buying requires a valid qualified-investor credential registered on-chain',

    riskNotice:
      '⚠️ Advanced: you can bet on a rise or a fall, and you can amplify the investment size. Losses are amplified too: if the price moves against you the investment can be settled automatically, and you can lose the whole amount invested. Start with 1x (no amplification). Prices come from the on-chain price source and profit/loss settles at the mark price (including the up/down imbalance); in extreme one-sided markets, paper profit may be adjusted automatically (ADL); amounts invested are in USDC.',
    showRiskNotice: '⚠️ Show risk notice',

    submitting: 'Buying…',
    insufficientMargin: 'Amount too low',
    ctaOpen: 'Submit {side} {asset}',
  },

  /** 帳戶區。 */
  account: {
    equity: 'Total value',
    freeMargin: 'Available funds',
    unrealizedPnl: 'Unrealised profit / loss',
    pnlPartial: 'Some investments cannot be valued right now (read failed or no usable price), so the total is not shown.',
    positionsUnread: '{count} investment(s) could not be read — the totals are incomplete.',
    wallet: 'Wallet {token}',
    marginNote: 'amounts invested settle in USDC · USDT is hold/swap only',

    enterAmount: 'Enter amount',
    deposited: 'Deposited {amount} USDC ✓',

    depositPlaceholder: 'deposit',
    depositAria: 'Deposit amount (USDC)',
    deposit: 'Deposit',
  },

  /** 持倉區的分頁殼。 */
  panel: {
    tabPositions: 'My investments ({count})',
    tabFills: 'Buys & sells',
    tabFunding: 'Funding',
    refresh: '↺ refresh',

    updatedAt: 'Updated {time}',
    staleData: 'No successful update for over {sec}s — figures may be out of date (last updated {time})',
    readFailed: 'The last read failed — showing data from {time}',
    neverRead: 'Investments not read yet',
  },

  positions: {
    column: {
      asset: 'Asset',
      side: 'Side',
      entry: 'Buy price',
      mark: 'Mark',
      margin: 'Amount invested',
      leverage: 'Amplif.',
      pnl: 'Profit / loss',
    },
    empty: 'no investments held',
    long: 'PRICE UP',
    short: 'PRICE DOWN',
    closed: 'Sold ✓',
    close: 'Sell',
    copyManaged: 'Copy investing',
    copyManagedTip: 'This was bought through copy investing. Selling it alone would put the follower record out of step, so manage it in Portfolio.',
    stale: 'Price stale',
    markHint:
      'The mark price computed by the on-chain program: index price plus the premium from the platform-wide up/down imbalance. An investment\u2019s own profit/loss uses the mark with its own size excluded, so the two can differ when the premium cap is above 0.',
    pnlHint:
      'How much more or less than the amount invested you would get back by selling now (investment value from the on-chain program − amount invested), after the sell fee, borrow fee and accrued funding. Excludes the 10% performance fee some investments pay on profit; funding as of the last settlement; excludes any cover for losses beyond the amount invested.',
  },

  fills: {
    column: {
      type: 'Type',
      asset: 'Asset',
      side: 'Side',
      price: 'Price',
      pnl: 'Profit / loss',
      tx: 'Record',
    },
    kind: {
      opened: 'Buy',
      closed: 'Sell',
      liquidated: 'Settled automatically',
    },
    loading: 'Loading on-chain buys and sells…',
    empty: 'No recent buys or sells',
    readError: "Couldn't read on-chain buys and sells",
    long: 'PRICE UP',
    short: 'PRICE DOWN',
  },

  funding: {
    column: {
      asset: 'Asset',
      rate: 'Rate ({interval})',
      longOi: 'Held (up)',
      shortOi: 'Held (down)',
      lastSettled: 'Last settled',
    },
    empty: 'No funding data',

    intervalUnit: {
      d: '{n}d',
      h: '{n}h',
      m: '{n}m',
      s: '{n}s',
    },

    /** 上次結算多久以前。四種區間各自是完整的一句話。 */
    agoNever: 'Never',
    agoSeconds: '{n}s ago',
    agoMinutes: '{n}m ago',
    agoHours: '{n}h ago',

    canSettle: 'Settleable',
    note: 'Only lists assets with a funding rate set on-chain. A positive value means the price-up side pays the price-down side.',
  },

  /** 市場活動面板（取代原本的交易所盤口）。 */
  activity: {
    title: 'Market activity',
    onChainBadge: '● on-chain',

    column: {
      side: 'Side',
      margin: 'Amount invested',
      entry: 'Buy price',
      time: 'Time',
      pnl: 'Profit / loss',
    },

    loading: 'Loading on-chain investments…',
    emptyForAsset: 'No on-chain investments in {asset} right now',
    /** 標的代號還沒讀到時，`emptyForAsset` 用的代稱。 */
    thisAsset: 'this asset',

    long: 'PRICE UP',
    short: 'PRICE DOWN',
    openMarker: 'held',

    truncated: "Only scanning the most recent investments — older ones aren't listed",
    missed: '{count} entries were not read due to RPC rate limiting — the list may be incomplete',
  },

  /** 圖表面板。 */
  chart: {
    /** 價格線上的圖例文字。 */
    lineIndex: 'index',
    lineMark: 'mark',

    underlyingSpot: '{ticker} Spot',

    last: 'chart last',
    loadingOlder: 'Loading earlier…',
    exhausted: 'Reached earliest data',
    atCapacity: 'Display limit reached',

    disclaimer:
      "The chart is reference pricing from an external public source, not this platform's trade record — buying, selling and automatic settlement all settle at the on-chain mark price (index plus the up/down imbalance premium).",

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
