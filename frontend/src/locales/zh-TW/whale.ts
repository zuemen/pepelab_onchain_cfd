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
  tag: {
    mega: '巨額',
    megaHint: '名義價值超過 {threshold}',
    highLeverage: '{leverage}× 槓桿',
    highLeverageHint: '價格小幅逆向波動即可能觸發清算',
    newFace: '新面孔',
    newFaceHint: '此地址在掃描區間內首次出現活動',
  },

  page: {
    title: '🐋 鯨魚追蹤',
    subtitle: '大額交易即時追蹤 · 即時未平倉量 · 帳面最大部位',

    window: '視窗 · {label}',
    windowHint: '早於此視窗的事件不列入計算',
    blocks: '區塊 {range}',

    /** 掃描視窗的四種狀態。 */
    windowUnavailable: '無法使用',
    windowScanFailed: '掃描失敗',
    windowScanning: '掃描中…',
    scanFailedTitle: '無法掃描',
    windowLast: '最近 {span}',

    threshold: '鯨魚門檻',
    refresh: '↺ 重新整理',

    lookupPlaceholder: '0x… 查詢任一交易者',
    lookupAria: '交易者地址',
    lookupInvalid: '不是有效的 Ethereum 地址',
    viewProfile: '查看個人頁',

    notAvailable:
      '此網路無法使用交易所功能——請連接 Base Sepolia 錢包以查看鯨魚活動。上方的地址查詢功能仍可正常使用。',
    retry: '重試',

    /** feed 空掉時的原因，四種各自是完整的一句話。 */
    emptyDisconnected: '連接 Base Sepolia 錢包以掃描交易所。',
    emptyScanFailed: '掃描未完成，這不是最終結果——請點擊上方重試。',
    emptyBelowThreshold: '此視窗內共 {count} 筆交易，皆未達 {threshold} 門檻。請嘗試調低門檻。',
    emptyNoTrades: '區塊 {range} 內完全沒有開倉紀錄。',

    footer:
      '動態消息與成交量涵蓋區塊 {range}（{window}）。未平倉量則即時從交易所讀取，涵蓋所有部位，包括更早期的部位。',
    footerPending: '掃描範圍計算中',
  },

  kpi: {
    whaleTrades: '鯨魚交易',
    whaleTradesSub: '名義價值 ≥ {threshold} · {window}',
    volume: '成交量',
    volumeSub: '共 {count} 筆開倉 · {window}',
    openInterest: '未平倉量',
    openInterestSub: '即時 · 涵蓋所有市場、所有時間',
  },

  feed: {
    title: '🐋 鯨魚動態',
    scanning: '掃描中 {done}/{total}',
    trades: '{count} 筆交易',

    /**
     * simple 模式把一筆交易寫成一句話，每個片段之間本來就用明確的
     * `{' '}` 隔開，不是靠 JSX 折疊換行空白，所以直接搬進 catalog 不會漏空格。
     * sideLabel()（多／空）是 `lib/pepefi/whale.ts` 裡的獨立函式，不經過
     * catalog，這句子裡仍是英文 LONG/SHORT，是另一個已知缺口。
     */
    openedVerb: '開倉',
    forPreposition: '金額為',
    emptyTitle: '此範圍內無鯨魚交易',
    emptyTitleFailed: '⚠️',
    emptyDescription: '掃描範圍內沒有名義價值超過 $5k 的交易。',

    copy: '⭐ 跟單',
    copyHint: '已註冊策略——可在交易市集跟單此交易者',
    estimatedTime: '依平均出塊時間估算',
    txAria: '在區塊瀏覽器查看交易',

    column: {
      time: '時間',
      trader: '交易者',
      market: '市場',
      side: '方向',
      notional: '名義價值',
      entry: '進場價',
      tx: '交易',
    },
  },

  sentiment: {
    title: '多空對比',
    subtitle: '未平倉量 · 即時',
    unavailable: '此網路無法使用。',
    empty: '所有市場皆無未平倉部位。',
    long: '做多 {pct}%',
    short: '{pct}% 做空',

    /**
     * 「橫跨 N 個市場」的單複數寫成兩條完整的句子——catalog 沒有複數引擎，
     * 而把 's' 抽成一個可插入的字等於假設每個語言都用同樣的句構。中文沒有
     * 單複數之分，兩份文字目前相同。
     */
    acrossOne: '橫跨 {count} 個市場',
    acrossMany: '橫跨 {count} 個市場',

    rowTooltip: '多 {long} · 空 {short}',
    missingOne: '{count} 個市場無法讀取——RPC 節點可能正在限速。',
    missingMany: '{count} 個市場無法讀取——RPC 節點可能正在限速。',
  },

  largest: {
    title: '最大未平倉部位',
    top: '前 {count} 名',
    unavailable: '此網路無法使用。',
    empty: '掃描範圍內無未平倉部位。',

    column: {
      market: '市場',
      trader: '交易者',
      side: '方向',
      entry: '進場價',
      mark: '標記價',
      notional: '名義價值',
      pnl: 'PnL',
    },

    markUnread: '標記價無法讀取',
    pnlUnread: '未實現 PnL 無法讀取',
    missingOne: '{count} 筆部位無法讀取——RPC 節點可能正在限速。',
    missingMany: '{count} 筆部位無法讀取——RPC 節點可能正在限速。',
  },
};
