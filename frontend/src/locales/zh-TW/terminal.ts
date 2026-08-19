/**
 * Pro Terminal：行情列、下單面板、帳戶面板、持倉／成交／資金費表、訂單簿與圖表。
 *
 * 兩件事值得先說：
 *
 * 1. **品牌字樣不進 catalog。**`PEPELAB·TERMINAL` 中間夾一個上色的分隔點，是
 *    logo 而不是句子；和代幣代號一樣屬於「原樣保留」那一類，沒有可譯的內容。
 *    時間框代號（1m/5m/1h…）同理。
 *
 * 2. **擋單訊息只有一份。**終端機下單前的過期價提示走
 *    `lib/pepefi/priceFreshness.ts` 的 `stalenessNotice()`，和 Exchange 頁、
 *    持倉表用的是同一句話。這裡刻意不放第二份 stale 文案——兩份會分岔。
 */
export const terminal = {
  connectWallet: '連接錢包以開啟終端機。',

  header: {
    tagline: 'agent 原生永續 · base sepolia',
    status: '鏈上 · 即時',
  },

  /** 行情列。每個 Stat 的 hint 都是滑鼠提示，`\n\n` 是段落分隔。 */
  stats: {
    perpSuffix: '-PERP',
    displayPrice: '參考價格',

    index: '指數（oracle · 此為結算價）',
    indexHint:
      '鏈上預言機價格，也是你實際成交的價格。\n\n開倉、平倉、清算全部以這個價格結算，跟上面的顯示價和 K 線圖都無關——那兩個是外部行情的參考。預言機由 keeper 定期寫入鏈上，所以會比市場慢一些。',

    mark: '標記價（OI 溢價）',
    markHint:
      '在指數價之上，依多空失衡加減一個溢價後的價格。\n\n多單明顯多於空單時 mark 會高於 index，反之則低。用途是讓損益與清算反映「大家都站同一邊」的風險，而不是只看預言機報價。',

    funding: '資金費率',
    fundingHint:
      '多空之間定期互付的資金費，用來把價格拉回指數。\n\n正值 = 持多單的人付錢給持空單的人（代表多單過熱）；負值相反。你持倉期間會依這個費率累積成本或收益。',

    openInterest: '未平倉量 多/空',
    openInterestHint:
      '這個標的目前鏈上未平倉的多單 / 空單名目金額。\n\n兩邊差距越大代表市場越偏向一邊，funding 費率也會跟著變大。顯示 "—" 代表鏈上讀取失敗，不是沒有部位。',

    vaultBacking: '金庫後盾',
    vaultBackingHint:
      '保險金庫目前的資金規模——極端行情下用來吸收穿倉損失的後盾。\n\n顯示 $0 代表金庫已部署但還沒有人存入資金，此時平台沒有額外的償付緩衝。這是測試網的真實狀態，不是顯示錯誤。',

    sourceCoingecko: '參考 · coingecko',
    sourceOracle: '參考 · 鏈上 oracle',
    sourceSimulated: '模擬報價',

    /**
     * 接在報價來源後面的價齡。前導空白是值的一部分：畫面上本來就是
     * `display · coingecko · index 3 分鐘前`，那個空白不是排版意外。
     */
    indexAge: ' · 指數 {age}',
  },

  /** 下單面板。 */
  ticket: {
    long: '做多',
    short: '做空',
    sideLong: '做多',
    sideShort: '做空',

    leverage: '槓桿',
    margin: '保證金',
    free: '可用：{amount}',
    marginAria: '保證金（{token}）',

    notional: '名義價值',
    entryOracle: '進場價（oracle）',
    estLiquidation: '預估清算價',
    onLiquidation: '清算時',
    onLiquidationValue: '殘值退還（扣罰金）',
    funding8h: '資金費率（8 小時）',

    enterMargin: '輸入保證金',
    insufficientFreeMargin: '可用保證金不足——請先存入',
    opened: '{side} {asset} 開倉成功 ✓',

    /** 受管制標的的三種 KYC 狀態，各自是完整的一句話。 */
    kycUnknown: '⚠ 無法確認 KYC 狀態（鏈上讀取失敗）。合規閘門採 fail-closed，{asset} 暫停交易。',
    kycPending: '⏳ {asset} 需 KYC：申請已送出，等待審核人員核准中，核准後自動解鎖',
    kycRequired: '🔒 {asset} 需 KYC，請至 Exchange 頁送出申請（送出後需審核）',

    riskNotice:
      '⚠️ 測試網：本平台為 oracle 計價永續，損益以 mark 價（含 OI 失衡）結算；極端單邊行情下帳面利潤可能因 ADL 自動減倉而調整；保證金為測試代幣。',
    showRiskNotice: '⚠️ 顯示風險提示',

    submitting: '開倉中…',
    insufficientMargin: '保證金不足',
    ctaOpen: '開倉 {side} {asset}',
  },

  /** 帳戶區。 */
  account: {
    equity: '權益',
    freeMargin: '可用保證金',
    unrealizedPnl: '未實現 PnL',
    wallet: '錢包 {token}',
    marginNote: '保證金以 USDC 結算 · USDT 僅供持有/兌換',

    enterAmount: '輸入金額',
    deposited: '已存入 {amount} USDC ✓',

    depositPlaceholder: '存入',
    depositAria: '存入金額（USDC）',
    deposit: '存入',
  },

  /** 持倉區的分頁殼。 */
  panel: {
    tabPositions: '持倉（{count}）',
    tabFills: '成交紀錄',
    tabFunding: '資金費率',
    refresh: '↺ 重新整理',
  },

  positions: {
    column: {
      asset: '標的',
      side: '方向',
      entry: '進場價',
      mark: '標記價',
      margin: '保證金',
      leverage: '槓桿',
      pnl: 'PnL',
    },
    empty: '無未平倉部位',
    long: '做多',
    short: '做空',
    closed: '已平倉 ✓',
    close: '平倉',
    stale: '價格過期',
  },

  fills: {
    column: {
      type: '類型',
      asset: '標的',
      side: '方向',
      price: '價格',
      pnl: 'PnL',
      tx: '交易',
    },
    kind: {
      opened: '開倉',
      closed: '平倉',
      liquidated: '已清算',
    },
    loading: '讀取鏈上成交…',
    empty: '近期無成交紀錄',
    readError: '無法讀取鏈上成交紀錄',
    long: '做多',
    short: '做空',
  },

  funding: {
    column: {
      asset: '標的',
      rate: '費率（8 小時）',
      longOi: '多方未平倉',
      shortOi: '空方未平倉',
      lastSettled: '上次結算',
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
    title: '市場動態',
    onChainBadge: '● 鏈上',

    column: {
      side: '方向',
      margin: '保證金',
      entry: '進場價',
      time: '時間',
      pnl: 'PnL',
    },

    loading: '讀取鏈上部位…',
    emptyForAsset: '{asset} 目前無鏈上部位',
    /** 標的代號還沒讀到時，`emptyForAsset` 用的代稱。 */
    thisAsset: '此標的',

    long: '做多',
    short: '做空',
    openMarker: '未平倉',

    truncated: '只掃描最近的部位，更早的未列出',
    missed: '{count} 筆因 RPC 限流未讀取，列表可能不完整',
  },

  /** 圖表面板。 */
  chart: {
    /** 價格線上的圖例文字。 */
    lineIndex: '指數',
    lineMark: '標記價',

    last: '圖表最新',
    loadingOlder: '載入更早…',
    exhausted: '已到最早資料',
    atCapacity: '已達顯示上限',

    disclaimer:
      '圖表為外部公開來源的參考行情，非本平台成交紀錄；開倉 / 平倉 / 清算一律以鏈上 oracle index 價結算。',

    error: '無法載入 K 線',
    loading: '載入 K 線…',

    /** 來源徽章。 */
    sourceSimulated: '模擬資料',
    sourceNamed: '資料 · {name}',
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
