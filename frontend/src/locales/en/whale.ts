import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/whale.ts`。
 */
export const whale: Catalog['whale'] = {
  /** 相對時間。四個區間各自是完整的一句話，不是「數字 + 單位」。 */
  timeAgo: {
    justNow: 'just now',
    minutes: '{n}m ago',
    hours: '{n}h ago',
    days: '{n}d ago',
  },

  /** feed 上點名一筆交易的原因。 */
  side: { long: 'Price up', short: 'Price down' },
  tag: {
    mega: 'Mega',
    megaHint: 'Investment size above {threshold}',
    highLeverage: 'High risk',
    highLeverageHint: 'The investment size is far larger than the amount invested, so a small price move the wrong way can settle it automatically',
    newFace: 'New face',
    newFaceHint: 'First activity from this address in the scanned window',
  },

  page: {
    title: '🐋 Whale Tracker',
    subtitle: 'Large investments as they land · total currently held · the biggest investments',

    window: 'Window · {label}',
    windowHint: 'Events older than this window are not included',
    blocks: 'Blocks {range}',

    /** 掃描視窗的四種狀態。 */
    windowUnavailable: 'unavailable',
    windowScanFailed: 'scan failed',
    windowScanning: 'scanning…',
    scanFailedTitle: 'Could not scan',
    readError: 'Could not read on-chain activity. The RPC node may be rate-limiting.',
    scanIncomplete: '{count} block range(s) could not be read — the feed and volume may be incomplete. Please retry.',
    windowLast: 'last {span}',

    threshold: 'Whale threshold',
    refresh: '↺ Refresh',

    lookupPlaceholder: '0x… look up any investor',
    lookupAria: 'Investor address',
    lookupInvalid: 'Not a valid Ethereum address',
    viewProfile: 'View profile',

    notAvailable:
      'Investing isn’t available on this network — connect a wallet on Base Sepolia to see whale activity. The address lookup above still works.',
    retry: 'Retry',

    /** feed 空掉時的原因，四種各自是完整的一句話。 */
    emptyDisconnected: 'Connect a wallet on Base Sepolia to scan on-chain investment records.',
    emptyScanFailed: 'The scan did not complete, so this is not an answer — retry above.',
    emptyBelowThreshold:
      '{count} investments in this window, none at or above {threshold}. Try a lower threshold.',
    emptyNoTrades: 'No buys at all in blocks {range}.',

    footer:
      'Feed and volume cover blocks {range} ({window}). The total currently held is read live from the chain and covers every investment still held, including older ones.',
    footerPending: 'Scan range pending',
  },

  kpi: {
    whaleTrades: 'Whale Investments',
    whaleTradesSub: '≥ {threshold} investment size · {window}',
    volume: 'Volume',
    volumeSub: 'all {count} buys · {window}',
    openInterest: 'Total Currently Held',
    openInterestSub: 'live · every market, all time',
  },

  feed: {
    title: '🐋 Whale Feed',
    scanning: 'Scanning {done}/{total}',
    trades: '{count} investments',

    /**
     * #36：simple 模式把一筆交易寫成一句話，每個片段之間本來就用明確的
     * `{' '}` 隔開，不是靠 JSX 折疊換行空白，所以直接搬進 catalog 不會漏空格。
     */
    openedVerb: 'bought',
    forPreposition: 'for',
    emptyTitle: 'No whale investments in range',
    emptyTitleFailed: '⚠️',
    emptyDescription: 'Nothing above the $5k investment-size threshold in the scanned window.',

    copy: '⭐ Copy investing',
    copyHint: 'Registered strategy — follow this strategy sharer through copy investing on the Strategy Marketplace',
    estimatedTime: 'Estimated from average block time',
    txAria: 'View the on-chain record in the block explorer',

    column: {
      time: 'Time',
      trader: 'Investor',
      market: 'Market',
      side: 'Up / Down',
      notional: 'Size',
      entry: 'Buy price',
      tx: 'Record',
    },
  },

  sentiment: {
    title: 'Price Up vs Price Down',
    subtitle: 'total currently held · live',
    unavailable: 'Unavailable on this network.',
    empty: 'No investments held in any market.',
    long: 'UP {pct}%',
    short: '{pct}% DOWN',

    /**
     * 「橫跨 N 個市場」的單複數寫成兩條完整的句子——catalog 沒有複數引擎，
     * 而把 's' 抽成一個可插入的字等於假設每個語言都用同樣的句構。
     */
    acrossOne: 'across {count} market',
    acrossMany: 'across {count} markets',

    rowTooltip: 'Up {long} · Down {short}',
    missingOne: '{count} market could not be read — the RPC node may be rate-limiting.',
    missingMany: '{count} markets could not be read — the RPC node may be rate-limiting.',
  },

  /**
   * 全站橫幅版的鯨魚警報（WhaleAlertBanner）。目前沒有掛在任何頁面上，見元件
   * 檔頂的說明。「開倉」「名義價值」複用 `feed.openedVerb` / `feed.column.notional`，
   * 沒有另外造字，避免同一句話在 catalog 裡出現兩份。
   */
  alertBanner: {
    title: 'Whale Alert',
    dismissAria: 'Dismiss whale alert',
  },

  largest: {
    title: 'Largest Investments Held',
    top: 'top {count}',
    unavailable: 'Unavailable on this network.',
    empty: 'No investments held in the scanned window.',

    column: {
      market: 'Market',
      trader: 'Investor',
      side: 'Up / Down',
      entry: 'Buy price',
      mark: 'Current price',
      notional: 'Size',
      pnl: 'Profit / loss',
    },

    markUnread: 'Current price could not be read',
    pnlUnread: 'Unrealised profit / loss could not be read',
    missingOne: '{count} investment could not be read — the RPC node may be rate-limiting.',
    missingMany: '{count} investments could not be read — the RPC node may be rate-limiting.',
  },
};
