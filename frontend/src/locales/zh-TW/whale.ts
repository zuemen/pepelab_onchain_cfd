/**
 * Whale Tracker：頁面本身、feed、KPI、多空分布、最大未平倉，以及
 * `lib/pepefi/whale.ts` 裡跟著資料一起產出的標籤與相對時間。
 *
 * 門檻選項（$500 / $1k / $5k / $25k）不進 catalog：那是金額，不是文字。
 */
export const whale = {
  /** 相對時間。四個區間各自是完整的一句話，不是「數字 + 單位」。 */
  timeAgo: {
    justNow: '剛剛',
    minutes: '{n} 分鐘前',
    hours: '{n} 小時前',
    days: '{n} 天前',
  },

  /** feed 上點名一筆交易的原因。 */
  side: { long: '看漲', short: '看跌' },
  tag: {
    mega: '巨額',
    megaHint: '投資規模超過 {threshold}',
    highLeverage: '高風險',
    highLeverageHint: '投資規模遠大於投入金額，價格小幅反向變動就可能被自動結清',
    newFace: '新面孔',
    newFaceHint: '此地址在掃描區間內首次出現活動',
  },

  page: {
    title: '🐋 鯨魚追蹤',
    subtitle: '大額投資即時追蹤 · 目前持有總額 · 規模最大的投資',

    window: '視窗 · {label}',
    windowHint: '早於此視窗的事件不列入計算',
    blocks: '區塊 {range}',

    /** 掃描視窗的四種狀態。 */
    windowUnavailable: '無法使用',
    windowScanFailed: '掃描失敗',
    windowScanning: '掃描中…',
    scanFailedTitle: '無法掃描',
    /** hook 的錯誤訊息（以前寫死英文）。 */
    readError: '無法讀取鏈上活動，RPC 節點可能正在限流。',
    scanIncomplete: '{count} 個區塊範圍讀取失敗，動態與成交量可能不完整——請重試。',
    windowLast: '最近 {span}',

    threshold: '鯨魚門檻',
    refresh: '↺ 重新整理',

    lookupPlaceholder: '0x… 查詢任一投資人',
    lookupAria: '投資人地址',
    lookupInvalid: '不是有效的 Ethereum 地址',
    viewProfile: '查看個人頁',

    notAvailable:
      '此網路無法使用投資功能——請連接 Base Sepolia 錢包以查看鯨魚活動。上方的地址查詢功能仍可正常使用。',
    retry: '重試',

    /** feed 空掉時的原因，四種各自是完整的一句話。 */
    emptyDisconnected: '連接 Base Sepolia 錢包以掃描鏈上投資紀錄。',
    emptyScanFailed: '掃描未完成，這不是最終結果——請點擊上方重試。',
    emptyBelowThreshold: '此視窗內共 {count} 筆投資，皆未達 {threshold} 門檻。請嘗試調低門檻。',
    emptyNoTrades: '區塊 {range} 內完全沒有買進紀錄。',

    footer:
      '動態消息與成交量涵蓋區塊 {range}（{window}）。目前持有總額則即時從鏈上讀取，涵蓋所有持有中的投資，包括更早買進的。',
    footerPending: '掃描範圍計算中',
  },

  kpi: {
    whaleTrades: '鯨魚投資',
    whaleTradesSub: '投資規模 ≥ {threshold} · {window}',
    volume: '成交量',
    volumeSub: '共 {count} 筆買進 · {window}',
    openInterest: '目前持有總額',
    openInterestSub: '即時 · 涵蓋所有市場、所有時間',
  },

  feed: {
    title: '🐋 鯨魚動態',
    scanning: '掃描中 {done}/{total}',
    trades: '{count} 筆投資',

    /**
     * simple 模式把一筆交易寫成一句話，每個片段之間本來就用明確的
     * `{' '}` 隔開，不是靠 JSX 折疊換行空白，所以直接搬進 catalog 不會漏空格。
     */
    openedVerb: '買進',
    forPreposition: '金額為',
    emptyTitle: '此範圍內無鯨魚投資',
    emptyTitleFailed: '⚠️',
    emptyDescription: '掃描範圍內沒有投資規模超過 $5k 的投資。',

    copy: '⭐ 跟著投資',
    copyHint: '已註冊策略——可在策略市集跟著這位策略分享者投資',
    estimatedTime: '依平均出塊時間估算',
    txAria: '在區塊瀏覽器查看鏈上紀錄',

    column: {
      time: '時間',
      trader: '投資人',
      market: '市場',
      side: '看漲／看跌',
      notional: '投資規模',
      entry: '買進價',
      tx: '紀錄',
    },
  },

  sentiment: {
    title: '看漲看跌對比',
    subtitle: '目前持有總額 · 即時',
    unavailable: '此網路無法使用。',
    empty: '所有市場皆無持有中的投資。',
    long: '看漲 {pct}%',
    short: '{pct}% 看跌',

    /**
     * 「橫跨 N 個市場」的單複數寫成兩條完整的句子——catalog 沒有複數引擎，
     * 而把 's' 抽成一個可插入的字等於假設每個語言都用同樣的句構。中文沒有
     * 單複數之分，兩份文字目前相同。
     */
    acrossOne: '橫跨 {count} 個市場',
    acrossMany: '橫跨 {count} 個市場',

    rowTooltip: '看漲 {long} · 看跌 {short}',
    missingOne: '{count} 個市場無法讀取——RPC 節點可能正在限速。',
    missingMany: '{count} 個市場無法讀取——RPC 節點可能正在限速。',
  },

  /**
   * 全站橫幅版的鯨魚警報（WhaleAlertBanner）。目前沒有掛在任何頁面上，見元件
   * 檔頂的說明。「開倉」「名義價值」複用 `feed.openedVerb` / `feed.column.notional`，
   * 沒有另外造字，避免同一句話在 catalog 裡出現兩份。
   */
  alertBanner: {
    title: '鯨魚警報',
    dismissAria: '關閉鯨魚警報',
  },

  largest: {
    title: '規模最大的持有中投資',
    top: '前 {count} 名',
    unavailable: '此網路無法使用。',
    empty: '掃描範圍內無持有中的投資。',

    column: {
      market: '市場',
      trader: '投資人',
      side: '看漲／看跌',
      entry: '買進價',
      mark: '目前價格',
      notional: '投資規模',
      pnl: '損益',
    },

    markUnread: '目前價格無法讀取',
    pnlUnread: '未實現損益無法讀取',
    missingOne: '{count} 筆投資無法讀取——RPC 節點可能正在限速。',
    missingMany: '{count} 筆投資無法讀取——RPC 節點可能正在限速。',
  },
};
