/**
 * 交易者個人頁（/trader/:address）。
 */
export const traderProfile = {
  invalidAddress: '無效的地址。',
  connectWallet: '連接錢包以查看策略分享者個人頁。',
  breadcrumbMarketplace: '策略市集',

  header: {
    unknownName: '未知',
    repChip: '◆ {rep} 聲譽',
    /** 粗體數字由元件自己渲染，這裡只是後面接的單複數字尾。中文沒有單複數之分，兩個一樣。 */
    followerSingular: '位跟隨者',
    followerPlural: '位跟隨者',
    registered: '已註冊',
    staked: '◆ 已繳履約押金',
    notStaked: '✗ 履約押金未達門檻',
    noStrategy: '尚無可跟著投資的策略 🔒',
    copyThisTrader: '跟著這位策略分享者投資 →',
  },

  stats: {
    staked: '履約押金',
    followers: '跟隨者',
    copiers: '人跟著投資',
    /** 換過 CopyTracker 之後，舊 tracker 上還在跟的人（contracts/legacyCopyTrackers.ts）。 */
    legacyCopiers: '人跟著投資（含舊版鏈上程式 {count} 位）',
    earnings: '收益',
    strategies: '策略數',
    versions: '版本',
  },

  strategy: {
    title: '最新策略',
    empty: '尚未發布策略。',
    /** 分配標籤：↑ BTC 50% · 3× */
    chip: '{side} {asset} {weight}%',
  },

  history: {
    titleOne: '策略歷史（{count} 個版本）',
    titleMany: '策略歷史（{count} 個版本）',
    /** 摘要行：BTC L 3× · ETH S 2× */
    summaryEntry: '{asset} {side}',
    long: '漲',
    short: '跌',

    column: {
      asset: '標的',
      carbonTier: '碳分級',
      side: '方向',
      leverage: '倍率',
      weight: '權重',
    },
    longLabel: '看漲 ↑',
    shortLabel: '看跌 ↓',
  },

  followers: {
    titleFirst: '跟隨者（前 {count} 位）',
  },

  slashHistory: {
    loading: '扣罰紀錄讀取中…',
    titleOne: '扣罰紀錄（{count} 筆）',
    titleMany: '扣罰紀錄（{count} 筆）',
    readFailedTitle: '扣罰紀錄讀取失敗',
    readFailedBody: '無法讀取鏈上的扣罰紀錄，因此不能據此判斷這位策略分享者是否曾被扣罰。請稍後重新整理。',
    totalFromContract: '鏈上程式記錄的累計扣罰：{amount} USDC',
    outsideWindow: '最近 {span} 內沒有扣罰紀錄，但鏈上程式記錄的累計扣罰為 {amount} USDC——扣罰發生在掃描範圍之前。',
    emptyInWindow: '最近 {span} 內沒有扣罰紀錄。',
  },

  /** 要逐段掃描事件的區塊（目前部位與時間軸、最近動態、罰沒紀錄）預設收起，點了才掃，不跟主要內容搶讀鏈額度。 */
  deferred: {
    body: '這一區要逐段掃描鏈上紀錄，比較花時間，需要時再載入。',
    load: '載入',
    activityTitle: '目前持有與動態時間軸',
    slashTitle: '扣罰紀錄',
  },

  actions: {
    backToMarketplace: '← 返回策略市集',
    whaleTracker: '🐋 鯨魚追蹤',
  },

  /**
   * TraderActivity：目前未平倉部位表 + 動態時間軸，兩張卡都在這裡。
   *
   * side 徽章仍是 `sideLabel()` 回傳的裸英文 LONG/SHORT——那是 `lib/pepefi/whale.ts`
   * 的已知缺口（見該檔 catalog 註解），WhaleFeed / LargestOpenPositions 兩個已搬過的
   * 手足元件也是同樣處理方式，這裡跟著一致，不單獨修。
   *
   * markUnreadTitle / pnlUnreadTitle / missingOne / missingMany / estimatedTime /
   * txAria 直接複用 `whale.largest` 與 `whale.feed` 裡已經存在、逐字相同的句子，
   * 不在這裡另造一份。
   */
  activity: {
    /** useAddressActivity 的錯誤訊息（以前寫死英文）。 */
    readError: '無法讀取此地址的鏈上紀錄，RPC 節點可能正在限流。',
    scanIncomplete: '{count} 個區塊範圍讀取失敗，動態時間軸可能不完整——請重新整理。',
    openPositions: {
      title: '目前持有',
      subtitle: '即時讀取鏈上資料 · 亦包含早於掃描範圍的持有',
      empty: '目前沒有持有中的投資。',
      readFailed: '目前持有讀取失敗，請稍後重新整理。這不代表沒有持有。',
      columnSimple: { market: '資產', side: '方向', notional: '目前價值', pnl: '損益' },
      columnExpert: {
        market: '資產',
        side: '方向',
        entry: '買進價',
        mark: '目前價格',
        margin: '投入金額',
        notional: '目前價值',
        pnl: '損益',
      },
    },

    timeline: {
      title: '動態時間軸',
      scanning: '掃描中 {done}/{total}',
      noRange: '—',
      emptyTitle: '尚無動態',
      emptyRange: '區塊 {range} 內無事件。',
      emptyNone: '目前沒有內容可顯示。',
      readFailedTitle: '讀取失敗',
      readFailedBody: '鏈上事件讀取失敗或不完整，這裡的空白不代表沒有動態。請重新整理再試。',
      column: { when: '時間', event: '事件', detail: '詳情', tx: '鏈上紀錄' },

      kind: {
        opened: '買進',
        closed: '賣出',
        liquidated: '已自動結清',
        following: '跟著投資中',
        followedBy: '被跟隨',
        staked: '繳交履約押金',
        slashed: '被扣罰',
      },

      /** 每種事件在「詳情」欄的句子。side 徽章與地址是獨立 JSX，前後才是這裡的字串。 */
      detail: {
        openedTail: '{asset} @ {price} · 投入金額 {margin}',
        closedTail: ' · 已收回 {received}',
        liquidatedBefore: '已自動結清 · 損益 ',
        liquidatedBy: ' · 執行者 ',
        followingBefore: '開始跟著投資 ',
        followingAfter: ' · 投入金額 {margin}',
        followedByAfter: ' 開始跟著這位策略分享者投資 · 投入金額 {margin}',
        stakedBefore: '繳交履約押金 ',
        slashedBefore: '被扣罰 ',
      },
    },
  },

  /** 模擬交易者的歷史績效（issue #309）。該位址有績效資料時才出現。 */
  hero: {
    performanceTitle: '歷史績效',
    range: '{from} 至 {to}',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    winRate: '勝率',
    winRateSub: '{count} 筆已賣出',
    esgCorrelation: '與 ESG 資產的相關性',
    esgCorrelationSub: '日報酬對 ESGU',
    avgHold: '平均持有',
    avgHoldValue: '{days} 天',
    equityTitle: '淨值',
    equityNote: '淨值 = 可用資金 + 每筆投資依當日價格計算的價值。還在持有的投資尚未結算的持有費用不計入，賣出時才反映。',
    monthlyTitle: '逐月報酬',
    exposureTitle: '目前策略的持有分布',
    tradesTitle: '投資紀錄',
    tradesNote: '損益為淨額：賣出取回的金額減去投入金額與買進手續費。括號內是扣除費用前的價格漲跌損益。',
    colAsset: '資產',
    colSide: '方向',
    colMargin: '投入金額',
    colOpen: '買進',
    colClose: '賣出',
    colPnl: '損益',
    colProof: '鏈上紀錄',
    long: '看漲',
    short: '看跌',
    stillOpen: '持有中',
    liquidated: '已自動結清',
    openTx: '買進紀錄',
    closeTx: '賣出紀錄',
    publishTx: '發布紀錄',
    proofLoading: '從鏈上讀取中…',
    proofFailed: '這筆紀錄讀不到。鏈重新啟動後，歷史紀錄可能不在節點上。',
    proofBlock: '區塊 {block}',
    proofTime: '時間 {time}',
    proofStatus: '狀態 {status}',
    proofSuccess: '成功',
    proofReverted: '失敗',
    proofLogs: '{count} 筆事件',
    /** 時間壓縮的回放（#344）：日期是模擬的那一天，上鏈時間是回放當天，兩個都標出來。 */
    simDate: '模擬日期 {date}',
    chainTime: '上鏈 {time}',
    tradesNoteCompressed: '日期為模擬日期；上鏈時間是在 Base Sepolia 回放的當天。點紀錄編號可到 BaseScan 查證。',
    riskTitle: '風險與投資統計',
    riskScore: '風險分數',
    riskScoreScale: '1 最低、10 最高',
    /** 量表下的三段說明：VaR 是什麼、怎麼分級、對照平台資產的實際級數。 */
    riskScoreNote: '風險分數看最近一年每天的報酬。把這些日報酬由差到好排好，第 5% 那一天的跌幅叫做「單日 95% 風險值（VaR）」，意思是大約每 20 天會有 1 天跌得比它更多。',
    riskScoreBands: 'VaR 每超過一道門檻加 1 級，門檻標在上方每一格下面。這組門檻是本平台自訂的：參考 eToro 用 VaR 分 1–10 級的做法，但不是 eToro 的公式。資料不足 30 天的策略分享者不評分。',
    riskScoreReference: '用平台資產最近一年（2025-10 至 2026-10）的價格對照：綠色債券 ETF（BGRN）約 2 級、ESG 美股大盤 ETF（ESGU）約 4 級、AAPL／GOOGL／MSFT、黃金與潔淨能源 ETF（sICLN）約 6 級、BTC 與 NVDA 約 7 級、TSLA 與 ETH 約 8 級。',
    worstDay: '最差單日',
    worstWeek: '最差一週',
    drawdown1y: '近一年最大回撤',
    profitableWeeks: '獲利週數',
    tradesPerWeek: '每週買賣次數',
    activeSince: '開始投資',
    topAssets: '最常投資的資產',
    topAssetValue: '{asset} {share}%',
    followersTitle: '跟隨人數',
  },
};
