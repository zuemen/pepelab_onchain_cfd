/**
 * Whale Tracker：頁面本身、feed、KPI、多空分布、最大未平倉，以及
 * `lib/pepefi/whale.ts` 裡跟著資料一起產出的標籤與相對時間。
 *
 * 門檻選項（$500 / $1k / $5k / $25k）不進 catalog：那是金額，不是文字。
 *
 * feed 的 simple 模式把一筆交易寫成一句話（`opened 20× LONG sBTC for $12.4k`），
 * 中間夾了三段上色與粗體的標記——那一句留在原地，交給 #36。
 */
export const whale = {
  /** 相對時間。四個區間各自是完整的一句話，不是「數字 + 單位」。 */
  timeAgo: {
    justNow: 'just now',
    minutes: '{n}m ago',
    hours: '{n}h ago',
    days: '{n}d ago',
  },

  /** feed 上點名一筆交易的原因。 */
  tag: {
    mega: 'Mega',
    megaHint: 'Notional above {threshold}',
    highLeverage: '{leverage}× leverage',
    highLeverageHint: 'Liquidates on a small move against the position',
    newFace: 'New face',
    newFaceHint: 'First activity from this address in the scanned window',
  },

  page: {
    title: '🐋 Whale Tracker',
    subtitle: 'Large trades as they land · live open interest · biggest positions on the book',

    window: 'Window · {label}',
    windowHint: 'Events older than this window are not included',
    blocks: 'Blocks {range}',

    /** 掃描視窗的四種狀態。 */
    windowUnavailable: 'unavailable',
    windowScanFailed: 'scan failed',
    windowScanning: 'scanning…',
    scanFailedTitle: 'Could not scan',
    windowLast: 'last {span}',

    threshold: 'Whale threshold',
    refresh: '↺ Refresh',

    lookupPlaceholder: '0x… look up any trader',
    lookupAria: 'Trader address',
    lookupInvalid: 'Not a valid Ethereum address',
    viewProfile: 'View profile',

    notAvailable:
      'The exchange isn’t available on this network — connect a wallet on Base Sepolia to see whale activity. The address lookup above still works.',
    retry: 'Retry',

    /** feed 空掉時的原因，四種各自是完整的一句話。 */
    emptyDisconnected: 'Connect a wallet on Base Sepolia to scan the exchange.',
    emptyScanFailed: 'The scan did not complete, so this is not an answer — retry above.',
    emptyBelowThreshold:
      '{count} trades in this window, none at or above {threshold}. Try a lower threshold.',
    emptyNoTrades: 'No positions opened at all in blocks {range}.',

    footer:
      'Feed and volume cover blocks {range} ({window}). Open interest is read live from the exchange and covers every position, including older ones.',
    footerPending: 'Scan range pending',
  },

  kpi: {
    whaleTrades: 'Whale Trades',
    whaleTradesSub: '≥ {threshold} notional · {window}',
    volume: 'Traded Volume',
    volumeSub: 'all {count} positions opened · {window}',
    openInterest: 'Open Interest',
    openInterestSub: 'live · every market, all time',
  },

  feed: {
    title: '🐋 Whale Feed',
    scanning: 'Scanning {done}/{total}',
    trades: '{count} trades',
    emptyTitle: 'No whale trades in range',
    emptyTitleFailed: '⚠️',
    emptyDescription: 'Nothing above the $5k notional threshold in the scanned window.',

    copy: '⭐ Copy',
    copyHint: 'Registered strategy — copy this trader on the Marketplace',
    estimatedTime: 'Estimated from average block time',
    txAria: 'View transaction in block explorer',

    column: {
      time: 'Time',
      trader: 'Trader',
      market: 'Market',
      side: 'Side',
      notional: 'Notional',
      entry: 'Entry',
      tx: 'Tx',
    },
  },

  sentiment: {
    title: 'Long vs Short',
    subtitle: 'open interest · live',
    unavailable: 'Unavailable on this network.',
    empty: 'No open positions in any market.',
    long: 'LONG {pct}%',
    short: '{pct}% SHORT',

    /**
     * 「橫跨 N 個市場」的單複數寫成兩條完整的句子——catalog 沒有複數引擎，
     * 而把 's' 抽成一個可插入的字等於假設每個語言都用同樣的句構。
     */
    acrossOne: 'across {count} market',
    acrossMany: 'across {count} markets',

    rowTooltip: 'Long {long} · Short {short}',
    missingOne: '{count} market could not be read — the RPC node may be rate-limiting.',
    missingMany: '{count} markets could not be read — the RPC node may be rate-limiting.',
  },

  largest: {
    title: 'Largest Open Positions',
    top: 'top {count}',
    unavailable: 'Unavailable on this network.',
    empty: 'No open positions in the scanned window.',

    column: {
      market: 'Market',
      trader: 'Trader',
      side: 'Side',
      entry: 'Entry',
      mark: 'Mark',
      notional: 'Notional',
      pnl: 'PnL',
    },

    markUnread: 'Mark price could not be read',
    pnlUnread: 'Unrealised PnL could not be read',
    missingOne: '{count} position could not be read — the RPC node may be rate-limiting.',
    missingMany: '{count} positions could not be read — the RPC node may be rate-limiting.',
  },
};
