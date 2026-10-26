/**
 * 交易者個人頁（/trader/:address）。
 */
export const traderProfile = {
  invalidAddress: '無效的地址。',
  connectWallet: '連接錢包以查看交易者個人頁。',
  breadcrumbMarketplace: '交易市集',

  header: {
    unknownName: '未知',
    repChip: '◆ {rep} 聲譽',
    /** 粗體數字由元件自己渲染，這裡只是後面接的單複數字尾。中文沒有單複數之分，兩個一樣。 */
    followerSingular: '位跟隨者',
    followerPlural: '位跟隨者',
    registered: '已註冊',
    staked: '◆ 已質押',
    notStaked: '✗ 未質押',
    noStrategy: '尚無可跟單的策略 🔒',
    copyThisTrader: '跟單此交易者 →',
  },

  stats: {
    staked: '質押金額',
    followers: '跟隨者',
    copiers: '跟單者',
    /** 換過 CopyTracker 之後，舊 tracker 上還在跟的人（contracts/legacyCopyTrackers.ts）。 */
    legacyCopiers: '跟單者（含舊版合約 {count} 位）',
    earnings: '收益',
    strategies: '策略數',
    versions: '版本',
  },

  strategy: {
    title: '最新策略',
    empty: '尚未發布策略。',
    /** 分配標籤：↑ BTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  history: {
    titleOne: '策略歷史（{count} 個版本）',
    titleMany: '策略歷史（{count} 個版本）',
    /** 摘要行：BTC L 3× · ETH S 2× */
    summaryEntry: '{asset} {side} {leverage}×',
    long: '多',
    short: '空',

    column: {
      asset: '標的',
      esg: 'ESG',
      side: '方向',
      leverage: '槓桿',
      weight: '權重',
    },
    longLabel: '做多 ↑',
    shortLabel: '做空 ↓',
  },

  followers: {
    titleFirst: '跟隨者（前 {count} 位）',
  },

  slashHistory: {
    loading: '罰沒紀錄讀取中…',
    titleOne: '罰沒紀錄（{count} 筆）',
    titleMany: '罰沒紀錄（{count} 筆）',
    readFailedTitle: '罰沒紀錄讀取失敗',
    readFailedBody: '無法讀取鏈上的罰沒事件，因此不能據此判斷此交易員是否曾被罰沒。請稍後重新整理。',
    totalFromContract: '合約記錄的累計罰沒：{amount} USDC',
    outsideWindow: '最近 {span} 內沒有罰沒事件，但合約記錄的累計罰沒為 {amount} USDC——罰沒發生在掃描範圍之前。',
  },

  actions: {
    backToMarketplace: '← 返回交易市集',
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
      title: '目前未平倉部位',
      subtitle: '即時讀取交易所資料 · 亦包含早於掃描視窗的部位',
      empty: '無未平倉部位。',
      columnSimple: { market: '市場', side: '方向', notional: '名義價值', pnl: 'PnL' },
      columnExpert: {
        market: '市場',
        side: '方向',
        entry: '進場價',
        mark: '標記價',
        margin: '保證金',
        notional: '名義價值',
        pnl: 'PnL',
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
      column: { when: '時間', event: '事件', detail: '詳情', tx: '交易' },

      kind: {
        opened: '開倉',
        closed: '平倉',
        liquidated: '已清算',
        following: '跟單中',
        followedBy: '被跟單',
        staked: '已質押',
        slashed: '已罰沒',
      },

      /** 每種事件在「詳情」欄的句子。side 徽章與地址是獨立 JSX，前後才是這裡的字串。 */
      detail: {
        openedTail: '{asset} {leverage}× @ {price} · 保證金 {margin}',
        closedTail: ' · 已收回 {received}',
        liquidatedBefore: '已清算 · 損益 ',
        liquidatedBy: ' · 執行者 ',
        followingBefore: '開始跟單 ',
        followingAfter: ' · 保證金 {margin}',
        followedByAfter: ' 開始跟單此交易者 · 保證金 {margin}',
        stakedBefore: '已質押 ',
        slashedBefore: '已罰沒 ',
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
    winRateSub: '{count} 筆平倉',
    esgCorrelation: '與永續型資產的相關性',
    esgCorrelationSub: '日報酬對 ESGU',
    avgHold: '平均持有',
    avgHoldValue: '{days} 天',
    equityTitle: '淨值',
    equityNote: '淨值 = 可用保證金 + 各部位依當日價格計算的價值。未平倉部位尚未實現的借款費與資金費率不計入，平倉時才反映。',
    monthlyTitle: '逐月報酬',
    exposureTitle: '目前策略的持倉分布',
    tradesTitle: '部位紀錄',
    tradesNote: '損益為淨額：平倉取回的金額減去保證金與開倉手續費。括號內是未扣費用與資金費率的價差損益。',
    colAsset: '資產',
    colSide: '方向',
    colMargin: '保證金',
    colOpen: '開倉',
    colClose: '平倉',
    colPnl: '損益',
    colProof: '交易',
    long: '多',
    short: '空',
    stillOpen: '未平倉',
    liquidated: '已清算',
    openTx: '開倉交易',
    closeTx: '平倉交易',
    publishTx: '發布交易',
    proofLoading: '從鏈上讀取中…',
    proofFailed: '這筆交易讀不到。鏈重新啟動後，歷史交易可能不在節點上。',
    proofBlock: '區塊 {block}',
    proofTime: '時間 {time}',
    proofStatus: '狀態 {status}',
    proofSuccess: '成功',
    proofReverted: '失敗',
    proofLogs: '{count} 筆事件',
    /** 時間壓縮的回放（#344）：日期是模擬的那一天，上鏈時間是回放當天，兩個都標出來。 */
    simDate: '模擬日期 {date}',
    chainTime: '上鏈 {time}',
    tradesNoteCompressed: '日期為模擬日期；上鏈時間是在 Base Sepolia 回放的當天。點交易雜湊可到 BaseScan 查證。',
    riskTitle: '風險與交易統計',
    riskScore: '風險分數',
    riskScoreScale: '1 最低、10 最高',
    /** 量表下的三段說明：VaR 是什麼、怎麼分級、對照平台資產的實際級數。 */
    riskScoreNote: '風險分數看最近一年每天的報酬。把這些日報酬由差到好排好，第 5% 那一天的跌幅叫做「單日 95% 風險值（VaR）」，意思是大約每 20 天會有 1 天跌得比它更多。',
    riskScoreBands: 'VaR 每超過一道門檻加 1 級，門檻標在上方每一格下面。這組門檻是本平台自訂的：參考 eToro 用 VaR 分 1–10 級的做法，但不是 eToro 的公式。資料不足 30 天的交易者不評分。',
    riskScoreReference: '用平台資產最近一年（2025-10 至 2026-10）、不加槓桿的價格對照：綠色債券 ETF（BGRN）約 2 級、ESG 美股大盤 ETF（ESGU）約 4 級、AAPL／GOOGL／MSFT、黃金與潔淨能源 ETF（sICLN）約 6 級、BTC 與 NVDA 約 7 級、TSLA 與 ETH 約 8 級。9、10 級通常要用槓桿才會到。',
    worstDay: '最差單日',
    worstWeek: '最差一週',
    drawdown1y: '近一年最大回撤',
    profitableWeeks: '獲利週數',
    tradesPerWeek: '每週交易',
    activeSince: '開始交易',
    topAssets: '最常交易的資產',
    topAssetValue: '{asset} {share}%',
    followersTitle: '跟隨人數',
  },
};
