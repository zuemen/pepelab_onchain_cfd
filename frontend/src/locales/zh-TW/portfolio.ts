/**
 * Portfolio 頁與它的 dashboard 元件。
 *
 * 類別旁邊的符號（₿ ◈ ◆ ◉）留在元件裡不進 catalog：它們是裝飾符號而不是文字，
 * 沒有語言可言，也沒有翻譯的餘地。nav 的 emoji 進 catalog 是因為它就長在標籤字串裡。
 */
export const portfolio = {
  netWorth: {
    title: '淨資產',
    unrealisedPnl: '未實現 PnL',
    unrealisedPnlTooltip: '未平倉部位以市價計算的 PnL',

    /**
     * 單複數寫成兩條完整的句子。catalog 沒有複數引擎，而把 'balance' / 'balances'
     * 抽成一個可插入的字，等於假設每個語言都用同樣的句構——中文沒有複數變化，
     * 其他語言的複數規則也不只兩種。
     */
    incompleteOne: '{count} 筆餘額無法讀取——此總額不完整。',
    incompleteMany: '{count} 筆餘額無法讀取——此總額不完整。',

    part: {
      wallet: '錢包',
      trading: '交易帳戶',
      staked: '已質押',
      lpVault: 'LP 保險金庫',
    },

    /** 某一項讀不到時的說明（Unread Balance，見 CONTEXT.md）。 */
    unread: {
      wallet: '錢包餘額無法讀取',
      trading: '交易帳戶無法讀取',
      staked: '質押金額無法讀取',
      lpVault: 'LP 保險金庫無法讀取',
    },
  },

  /**
   * RWA 資產配置——見 CONTEXT.md 的 RWA／Asset Class 詞條。刻意跟 netWorth
   * 分開：這裡的分母是交易部位的保證金，不是淨資產，兩個數字不會對得起來，
   * 用同一個 title 或同一組詞會讓讀者以為算法一樣。
   */
  allocation: {
    title: 'RWA 資產配置',
    subtitle: '依未平倉部位的保證金計算，不含錢包現金、質押與 LP 金庫——不是淨資產的配置。',
    noPositions: '尚無部位',

    /**
     * 對照指數（Benchmark，見 CONTEXT.md）——刻意不叫「指數」，避免跟永續
     * 合約自己的 index price 混用。名稱固定用這裡的翻譯，不信任後端 API
     * 回傳的英文 name 欄位：那是給非中文語境用的，這個 app 的顯示字一律
     * 走 catalog（ADR 0002），不能讓一個外部服務決定畫面上出現什麼語言。
     */
    benchmark: {
      heading: '對照指數',
      names: {
        spx: '標普 500',
        // TLT（20 年期以上公債 ETF）,不是殖利率——見後端 benchmarks.ts 的說明。
        bond: '美國公債',
        gold: '黃金',
        btc: '比特幣',
      },
      dayChange: '當日漲跌',
      /** 走勢圖的區間說明,以及 tooltip 裡價格那一列的名稱。 */
      chartRange: '近一個月',
      chartPrice: '收盤價',
      itemUnavailable: '暫時無法取得',
      unreachable: '無法連線到指數 API（{url}）。',
      unreachableDev:
        '無法連線到指數 API（{url}）。請先啟動 signal-api：cd agent/signal-api && npx tsx src/index.ts',
      httpError: '指數 API 回 {status}（{url}）',
      httpError404:
        '指數 API 回 {status}（{url}） — 該部署可能尚未包含 /benchmarks 路由，需重新部署 signal-api',
    },

    /**
     * 「你 vs 大盤」，見 CONTEXT.md 的 Anchor Date 詞條。youHint 一定要講清楚
     * 分母是名目——上面配置環用保證金，這裡用名目，不解釋這個落差會被讀成
     * bug，不是刻意的設計。
     */
    comparison: {
      heading: '你 vs 大盤',
      since: '自 {date}（你最早持倉的開倉日）起 · {days} 天',
      /** 分母只算真的拿到報酬率的指數,見 beatCountOf。 */
      beatSummary: '在 {total} 個對照指數中領先 {beat} 個',
      beatSummaryNone: '尚無可比較的指數資料',
      /**
       * 兩個百分比相減的單位是「百分點」不是「%」——寫成 % 會讓人以為是
       * 相對變化（例如 24% 比 23% 高 4%）,那是另一個數字。
       *
       * 中文寫全「百分點」而不是縮寫 pp：pp 在中文語境不是通用縮寫,讀者
       * 得先知道它代表什麼才看得懂。英文那份保留 pp,那在英文裡是標準寫法。
       */
      aheadBy: '領先 {pp} 百分點',
      behindBy: '落後 {pp} 百分點',
      youLabel: '你（去槓桿）',
      youHint:
        '未實現損益 ÷ 名目——已去除槓桿倍數，才能跟未槓桿的指數公平比較。上方配置環的分母是保證金，這裡不同，是刻意的。',
      noPositions: '尚無持倉',
    },
  },

  quickAction: {
    trade: '交易',
    copyTrader: '跟單交易者',
    history: '歷史記錄',
    proTerminal: '專業交易終端',
  },

  /**
   * Open Positions 的欄位名。simple 與 expert 兩張表共用同一份——原本 expert 表在
   * 頁面裡另外寫了一份一模一樣的清單，兩份字得同時改才不會不一致。
   */
  column: {
    asset: '標的',
    esg: 'ESG',
    side: '方向',
    entry: '進場價',
    oracle: '預言機',
    liveMarket: '即時市價',
    margin: '保證金',
    leverage: '槓桿',
    copiedFrom: '跟單來源',
    unrealizedPnl: '未實現 PnL',
    accruedFunding: '累計資金費',
    value: '價值',
  },

  /** 欄位的 tooltip。只有會被誤讀的欄位需要——兩個價格擺在一起且幾乎不相等。 */
  columnHint: {
    entry: '你的開倉價格',
    oracle: '合約結算依據的鏈上價格——未實現 PnL 就是用這個價格計算',
    liveMarket: '鏈下報價來源，變動會早於預言機，因此出現落差是正常現象',
    unrealizedPnl: '未實現損益，依預言機價格計算',
  },

  page: {
    title: '我的投資組合',
    refresh: '重新整理',
    connectWallet: '連接錢包以查看你的投資組合。',

    unsupportedNetwork: '不支援的網路',
    unknownChain: '未知',
    chainNumber: '鏈 {id}',

    demoTitle: '示範模式 — 無即時鏈上資料',
    demoDescription:
      '你目前在展示導覽模式，沒有連接錢包，因此無法讀取真實餘額或部位。請連接真實錢包以查看你的實際投資組合。',

    emptyTitle: '你的投資組合是空的',
    emptyDescription: '先取得測試用 {token}，接著可以跟單交易者或自行開倉。',
    emptyCta: '取得 {token}',

    side: {
      long: '做多 ↑',
      short: '做空 ↓',
    },

    activeCopies: '進行中的跟單',
    traderFollowedOne: '已跟隨的交易者',
    traderFollowedMany: '已跟隨的交易者',
    totalCopyPnl: '跟單總損益',
    noCopyPositions: '無跟單部位',

    copyPositions: '跟單部位',
    notCopyingAnyone: '你尚未跟單任何人。',
    browseTraders: '瀏覽交易者 →',
    copyColumn: {
      trader: '交易者',
      copiedAt: '跟單時間',
      initial: '初始金額',
      current: '目前金額',
      return: '報酬率',
      actions: '操作',
    },
    unfollow: '取消跟隨',
    unfollowStale: '價格過期',
    unfollowedOk: '已取消跟隨並平倉所有部位 ✓',

    openPositions: '未平倉部位',
    openCount: '{count} 筆未平倉 · 手動 + 跟單',
    noOpenPositions: '無未平倉部位。',
    total: '總計',

    freeMargin: '可用保證金',
    amountPlaceholder: '金額',
    withdraw: '提領',
    withdrawnOk: '已提領 {amount} {token} ✓',
    enterValidAmount: '請輸入有效金額',

    copyPerformance: '跟單績效',
    chart: {
      deposited: '已存入',
      now: '目前',
      initial: '初始',
      portfolioValue: '投資組合價值',
    },
    autoRefresh: '每 30 秒自動更新 · 兩點式檢視（初始 vs 目前）',
  },

  /**
   * 配置佔比與分類損益已搬到上面的 allocation（issue #66）。這裡只剩
   * ESG 分數，cat 仍留著——assetClass.ts 的 ASSET_CLASS_CONFIG 還在用它。
   */
  analysis: {
    esgScore: 'ESG 評分（依價值加權）',
    esgMethodology:
      '每個持倉的市值當權重，加權平均出這個分數；任一標的缺 ESG 資料，整個分數就不顯示，不用半套資料湊一個看起來正常的數字。',
    esgIncomplete: '並非所有持倉都有 ESG 資料。',
    byAsset: '各標的貢獻',

    cat: {
      crypto: '加密貨幣',
      equity: '股票',
      commodity: '商品',
      bond: '債券',
    },
  },
};
