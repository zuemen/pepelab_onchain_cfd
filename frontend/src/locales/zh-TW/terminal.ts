/**
 * Pro Terminal：行情列、下單面板、帳戶面板、持倉／成交／資金費表、訂單簿與圖表。
 *
 * 兩件事值得先說：
 *
 * 1. **品牌字樣不進 catalog。**`PEPELAB·TERMINAL` 中間夾一個上色的分隔點，是
 *    logo 而不是句子；和代幣代號一樣屬於「原樣保留」那一類，沒有可譯的內容。
 *    品牌名稱本身來自白標租戶設定（tenant.brand.name，見 src/tenant/）。
 *    時間框代號（1m/5m/1h…）同理。
 *
 * 2. **擋單訊息只有一份。**終端機下單前的過期價提示走
 *    `lib/pepefi/priceFreshness.ts` 的 `stalenessNotice()`，和 Exchange 頁、
 *    持倉表用的是同一句話。這裡刻意不放第二份 stale 文案——兩份會分岔。
 */
export const terminal = {
  connectWallet: '連接錢包以開啟進階投資工具。',

  header: {
    tagline: 'AI 代理原生 · 數位資產投資 · base sepolia',
    status: '鏈上 · 即時',
  },

  /** 行情列。每個 Stat 的 hint 都是滑鼠提示，`\n\n` 是段落分隔。 */
  stats: {
    closeHintAria: '關閉說明',
    perpSuffix: '',
    displayPrice: '參考價格',

    index: '指數價（價格來源 · 結算用）',
    indexHint:
      '鏈上價格來源寫入的指數價。\n\n買進、賣出與自動結清用的是標記價：這個價格加上看漲看跌失衡的溢價（溢價上限為 0 時兩者相同）。兩者都跟上面的顯示價和 K 線圖無關——那兩個是外部行情的參考。價格由營運方的程式定期寫入鏈上，所以會比市場慢一些。',

    mark: '標記價（失衡溢價）',
    markHint:
      '在指數價之上，依看漲看跌失衡加減一個溢價後的價格。\n\n看漲的投資明顯多於看跌時，標記價會高於指數價，反之則低。用途是讓損益與自動結清反映「大家都站同一邊」的風險，而不是只看價格來源的報價。',

    funding: '資金費率',
    fundingHint:
      '看漲與看跌的投資之間定期互付的費用，用來把價格拉回指數價。\n\n正值 = 看漲的一方付給看跌的一方（代表看漲過熱）；負值相反。你持有期間會依這個費率累積成本或收益。',

    carbon: '碳分級 · 費率 · 放大上限',
    carbonHint:
      '這個資產的碳強度落在哪一級，以及由它推導出的手續費與放大上限。\n\n規則寫死在公開的鏈上程式（CarbonTiers）裡，不是可調參數：碳排越高，在這裡持有越貴、能放大的比例越低。未評等（沒有未過期的見證資料）一律落到最保守級（最高費率、不放大 1×）。',
    carbonValue: '{tier} · {fee} bps · ≤{lev}×',

    openInterest: '持有總額 看漲/看跌',
    openInterestHint:
      '這個資產目前鏈上持有中的看漲 / 看跌投資規模。\n\n兩邊差距越大代表市場越偏向一邊，資金費率也會跟著變大。顯示 "—" 代表鏈上讀取失敗，不是沒有人持有。',

    vaultBacking: '風險準備金',
    vaultBackingHint:
      '風險準備金目前的規模——極端行情下用來吸收「虧損超過投入金額」那一段的後盾。\n\n顯示 $0 代表準備金已部署但還沒有人存入資金，此時平台沒有額外的償付緩衝。這是鏈上的真實狀態，不是顯示錯誤。',

    sourceCoingecko: '參考 · coingecko',
    sourceOracle: '參考 · 鏈上價格來源',
    sourceNone: '尚無價格',

    /**
     * 接在報價來源後面的價齡。前導空白是值的一部分：畫面上本來就是
     * `display · coingecko · index 3 分鐘前`，那個空白不是排版意外。
     */
    indexAge: ' · 指數 {age}',
  },

  /** 下單面板。 */
  ticket: {
    long: '看漲',
    short: '看跌',
    sideLong: '看漲',
    sideShort: '看跌',

    leverage: '放大比例',
    margin: '投入金額',
    free: '可用：{amount}',
    marginAria: '投入金額（{token}）',

    notional: '投資規模',
    entryOracle: '預估買進價（指數價）',
    noPriceNotice:
      '⛔ 讀不到鏈上指數價，無法計算買進價與自動結清價。在讀到價格之前不送出。',
    estLiquidation: '預估自動結清價',
    onLiquidation: '自動結清時',
    onLiquidationValue: '退還剩餘金額（扣罰金）',
    /** `{interval}` 由鏈上 FUNDING_INTERVAL() 格式化（funding.intervalUnit），讀不到是「—」。 */
    fundingRate: '資金費率（{interval}）',
    /** 交易費與槓桿上限：優先讀 exchange 的 per-asset view，讀不到才用碳分級靜態表。 */
    tradingParams: '手續費 · 放大上限',
    tradingParamsValue: '{fee} bps · ≤{lev}× · {source}',
    paramsSource: {
      chain: '來源：鏈上',
      static: '來源：靜態表',
      pending: '讀取中（暫以 1×、不放大為上限）',
    },

    enterMargin: '輸入投入金額',
    insufficientFreeMargin: '可用金額不足——請先存入',
    opened: '{side} {asset} 已送出 ✓',

    /** 受管制標的的三種 KYC 狀態，各自是完整的一句話。 */
    kycUnknown: '⚠ 無法確認 KYC 狀態（鏈上讀取失敗）。為了安全，確認之前 {asset} 暫停買賣。',
    kycPending: '⏳ {asset} 需 KYC：申請已送出，等待審核人員核准中，核准後自動解鎖',
    kycRequired: '🔒 {asset} 需 KYC，請到「投資組合」頁的 KYC 卡片送出申請（送出即通過）',
    kycGoToPortfolio: '前往投資組合送出申請',
    marketModeBlocked: '這個資產目前休市或暫停，不能新買進。',
    insufficientWithFee: '含手續費後投入金額不足',
    kycRequiredVc: '🔒 {asset} 是 RWA 市場，買進需要有效的合格投資人資格（可驗證憑證登記上鏈）',

    riskNotice:
      '⚠️ 進階功能：可以押上漲或押下跌，也可以放大投資規模；虧損也會跟著放大，價格不利時這筆投資可能被自動結清，投入金額可能全部虧光。第一次請選 1×（不放大）。價格依鏈上價格來源計算，損益以標記價（含看漲看跌失衡）結算；極端單邊行情下帳面利潤可能被自動調整（ADL）；投入金額以 USDC 計。',
    showRiskNotice: '⚠️ 顯示風險提示',

    submitting: '買進中…',
    insufficientMargin: '投入金額不足',
    ctaOpen: '送出 {side} {asset}',
  },

  /** 帳戶區。 */
  account: {
    equity: '總值',
    freeMargin: '可用金額',
    unrealizedPnl: '未實現損益',
    /** 有部位讀不出數字時，權益與未實現 PnL 都顯示「—」，下面加這一句。 */
    pnlPartial: '有投資目前無法估值（讀取失敗或價格不可用），合計不顯示。',
    /** 審查 N1：getPosition 讀不到的部位不在持倉表裡，合計也不顯示。 */
    positionsUnread: '{count} 筆投資讀取失敗，總額不完整。',
    wallet: '錢包 {token}',
    marginNote: '投入金額以 USDC 結算 · USDT 僅供持有/兌換',

    enterAmount: '輸入金額',
    deposited: '已存入 {amount} USDC ✓',

    depositPlaceholder: '存入',
    depositAria: '存入金額（USDC）',
    deposit: '存入',
  },

  /** 持倉區的分頁殼。 */
  panel: {
    tabPositions: '我的投資（{count}）',
    tabFills: '買賣紀錄',
    tabFunding: '資金費率',
    refresh: '↺ 重新整理',

    /** 持倉每 30 秒輪詢一次；這三句告訴使用者畫面上的數字是什麼時候的。 */
    updatedAt: '更新於 {time}',
    staleData: '已超過 {sec} 秒沒有更新成功，數字可能已過期（最後更新 {time}）',
    readFailed: '最近一次讀取失敗，顯示的是 {time} 的資料',
    neverRead: '尚未讀到我的投資',
  },

  positions: {
    column: {
      asset: '資產',
      side: '方向',
      entry: '買進價',
      mark: '標記價',
      margin: '投入金額',
      leverage: '放大比例',
      pnl: '損益',
    },
    empty: '目前沒有持有中的投資',
    long: '看漲',
    short: '看跌',
    closed: '已賣出 ✓',
    close: '賣出',
    copyManaged: '跟著投資',
    copyManagedTip: '這筆是跟著策略分享者投資買進的。單筆賣出會讓跟隨紀錄對不上，請到「投資組合」處理。',
    stale: '價格過期',
    /** 「標記價」欄與 PnL 欄的 tooltip（見 lib/pepefi/positionPnl.ts 檔頭）。 */
    markHint:
      '鏈上程式算出的標記價：指數價加上全平台看漲看跌失衡的溢價。每筆投資自己的損益用的是排除自身規模的標記價，溢價上限大於 0 時兩者可能不同。',
    pnlHint:
      '現在賣出會比投入金額多拿或少拿多少（鏈上程式算出的投資價值 − 投入金額）：已扣賣出手續費、借款費與應付資金費。不含部分投資獲利時另收的 10% 績效費；資金費以最後一次結算為準；不含虧損超過投入金額時的補貼。',
  },

  fills: {
    column: {
      type: '類型',
      asset: '資產',
      side: '方向',
      price: '價格',
      pnl: '損益',
      tx: '紀錄',
    },
    kind: {
      opened: '新增投資',
      closed: '結束投資',
      liquidated: '已自動結清',
    },
    loading: '讀取鏈上買賣紀錄…',
    empty: '近期無買賣紀錄',
    readError: '無法讀取鏈上買賣紀錄',
    long: '看漲',
    short: '看跌',
  },

  funding: {
    column: {
      asset: '資產',
      rate: '費率（{interval}）',
      longOi: '看漲持有總額',
      shortOi: '看跌持有總額',
      lastSettled: '上次結算',
    },
    empty: '無資金費率資料',

    /** 結算週期的單位（#196）：秒數取能整除的最大單位，28800 → 8 小時、300 → 5 分鐘。 */
    intervalUnit: {
      d: '{n} 天',
      h: '{n} 小時',
      m: '{n} 分鐘',
      s: '{n} 秒',
    },

    /** 上次結算多久以前。四種區間各自是完整的一句話。 */
    agoNever: '從未',
    agoSeconds: '{n}s 前',
    agoMinutes: '{n}m 前',
    agoHours: '{n}h 前',

    canSettle: '可結算',
    note: '僅列出鏈上已設定資金費率的資產。正值代表看漲方付給看跌方。',
  },

  /** 市場活動面板（取代原本的交易所盤口）。 */
  activity: {
    title: '市場動態',
    onChainBadge: '● 鏈上',

    column: {
      side: '方向',
      margin: '投入金額',
      entry: '買進價',
      time: '時間',
      pnl: '損益',
    },

    loading: '讀取鏈上投資…',
    emptyForAsset: '{asset} 目前沒有鏈上投資',
    /** 標的代號還沒讀到時，`emptyForAsset` 用的代稱。 */
    thisAsset: '此資產',

    long: '看漲',
    short: '看跌',
    openMarker: '持有中',

    truncated: '只掃描最近的投資，更早的未列出',
    missed: '{count} 筆因 RPC 限流未讀取，列表可能不完整',
  },

  /** 圖表面板。 */
  chart: {
    /** 價格線上的圖例文字。 */
    lineIndex: '指數',
    lineMark: '標記價',

    /** 行情 API 回的 underlying 若是「<代號> Spot」，代號不譯、Spot 改成現貨。 */
    underlyingSpot: '{ticker} 現貨',

    last: '圖表最新',
    loadingOlder: '載入更早…',
    exhausted: '已到最早資料',
    atCapacity: '已達顯示上限',

    disclaimer:
      '圖表為外部公開來源的參考行情，非本平台成交紀錄；買進 / 賣出 / 自動結清一律以鏈上標記價結算（指數價＋看漲看跌失衡溢價）。',

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
