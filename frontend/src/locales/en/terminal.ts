import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/terminal.ts`。搬移階段逐字複製原文。
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
      '鏈上預言機價格，也是你實際成交的價格。\n\n開倉、平倉、清算全部以這個價格結算，跟上面的顯示價和 K 線圖都無關——那兩個是外部行情的參考。預言機由 keeper 定期寫入鏈上，所以會比市場慢一些。',

    mark: 'Mark (OI premium)',
    markHint:
      '在指數價之上，依多空失衡加減一個溢價後的價格。\n\n多單明顯多於空單時 mark 會高於 index，反之則低。用途是讓損益與清算反映「大家都站同一邊」的風險，而不是只看預言機報價。',

    funding: 'Funding',
    fundingHint:
      '多空之間定期互付的資金費，用來把價格拉回指數。\n\n正值 = 持多單的人付錢給持空單的人（代表多單過熱）；負值相反。你持倉期間會依這個費率累積成本或收益。',

    openInterest: 'Open interest L/S',
    openInterestHint:
      '這個標的目前鏈上未平倉的多單 / 空單名目金額。\n\n兩邊差距越大代表市場越偏向一邊，funding 費率也會跟著變大。顯示 "—" 代表鏈上讀取失敗，不是沒有部位。',

    vaultBacking: 'Vault backing',
    vaultBackingHint:
      '保險金庫目前的資金規模——極端行情下用來吸收穿倉損失的後盾。\n\n顯示 $0 代表金庫已部署但還沒有人存入資金，此時平台沒有額外的償付緩衝。這是測試網的真實狀態，不是顯示錯誤。',

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
    estLiquidation: 'Est. liquidation',
    onLiquidation: 'On liquidation',
    onLiquidationValue: '殘值退還（扣罰金）',
    funding8h: 'Funding (8h)',

    enterMargin: 'Enter margin',
    insufficientFreeMargin: 'Insufficient free margin — deposit first',
    opened: '{side} {asset} opened ✓',

    /** 受管制標的的三種 KYC 狀態，各自是完整的一句話。 */
    kycUnknown: '⚠ 無法確認 KYC 狀態（鏈上讀取失敗）。合規閘門採 fail-closed，{asset} 暫停交易。',
    kycPending: '⏳ {asset} 需 KYC：申請已送出，等待審核人員核准中，核准後自動解鎖',
    kycRequired: '🔒 {asset} 需 KYC，請至 Exchange 頁送出申請（送出後需審核）',

    riskNotice:
      '⚠️ 測試網：本平台為 oracle 計價永續，損益以 mark 價（含 OI 失衡）結算；極端單邊行情下帳面利潤可能因 ADL 自動減倉而調整；保證金為測試代幣。',
    showRiskNotice: '⚠️ 顯示風險提示',

    submitting: 'Opening…',
    insufficientMargin: 'Insufficient margin',
    ctaOpen: 'Open {side} {asset}',
  },

  /** 帳戶區。 */
  account: {
    equity: 'Equity',
    freeMargin: 'Free margin',
    unrealizedPnl: 'Unrealized PnL',
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
    stale: '價格過期',
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
    loading: '讀取鏈上成交…',
    empty: '近期無成交紀錄',
    readError: '無法讀取鏈上成交紀錄',
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
    empty: '無 funding 資料',

    /** 上次結算多久以前。四種區間各自是完整的一句話。 */
    agoNever: '從未',
    agoSeconds: '{n}s 前',
    agoMinutes: '{n}m 前',
    agoHours: '{n}h 前',

    canSettle: '可結算',
    note: '僅列出鏈上已註冊 funding 的標的。正值代表多方付給空方。',
  },

  /** 市場活動面板（取代原本的交易所盤口）。 */
  activity: {
    title: 'Market activity',
    onChainBadge: '● 鏈上',

    column: {
      side: 'Side',
      margin: 'Margin',
      entry: 'Entry',
      time: 'Time',
      pnl: 'PnL',
    },

    loading: '讀取鏈上部位…',
    emptyForAsset: '{asset} 目前無鏈上部位',
    /** 標的代號還沒讀到時，`emptyForAsset` 用的代稱。 */
    thisAsset: '此標的',

    long: 'LONG',
    short: 'SHORT',
    openMarker: 'open',

    truncated: '只掃描最近的部位，更早的未列出',
    missed: '{count} 筆因 RPC 限流未讀取，列表可能不完整',
  },

  /** 圖表面板。 */
  chart: {
    /** 價格線上的圖例文字。 */
    lineIndex: 'index',
    lineMark: 'mark',

    last: 'chart last',
    loadingOlder: '載入更早…',
    exhausted: '已到最早資料',
    atCapacity: '已達顯示上限',

    disclaimer:
      '圖表為外部公開來源的參考行情，非本平台成交紀錄；開倉 / 平倉 / 清算一律以鏈上 oracle index 價結算。',

    error: '無法載入 K 線',
    loading: '載入 K 線…',

    /** 來源徽章。 */
    sourceSimulated: 'SIMULATED',
    sourceNamed: 'data · {name}',
    sourceFallbackSuffix: ' (備援)',
    sourceFallbackReason: '已退用備援來源：{error}',
  },

  /**
   * K 線 API 的錯誤。「基本訊息」與「基本訊息＋提示」寫成兩條完整的句子，
   * 而不是一句加一段可選的尾巴——尾巴單獨進 catalog 就沒辦法翻。
   */
  candles: {
    unreachable: '無法連線到行情 API（{url}）。',
    unreachableDev:
      '無法連線到行情 API（{url}）。請先啟動 signal-api：cd agent/signal-api && npx tsx src/index.ts',
    httpError: '行情 API 回 {status}（{url}）',
    httpError404:
      '行情 API 回 {status}（{url}） — 該部署可能尚未包含 /candles 路由，需重新部署 signal-api',
  },

  /** 訂單簿欄的收合開關。 */
  book: {
    show: '顯示訂單簿欄',
    hide: '收合訂單簿欄',
  },
};
