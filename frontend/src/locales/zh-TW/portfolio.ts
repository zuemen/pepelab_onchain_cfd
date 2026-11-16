/**
 * Portfolio 頁與它的 dashboard 元件。
 *
 * 類別旁邊的符號（₿ ◈ ◆ ◉）留在元件裡不進 catalog：它們是裝飾符號而不是文字，
 * 沒有語言可言，也沒有翻譯的餘地。nav 的 emoji 進 catalog 是因為它就長在標籤字串裡。
 */
export const portfolio = {
  netWorth: {
    title: '淨資產',
    /**
     * 淨資產把流動性與風險不同的東西照目前價格加總。只秀一個總額，讀者會以為整筆
     * 隨時拿得出來——所以總額、「可立即動用」、每一欄的標題都有滑過才出現的說明。
     * 各欄的條件（冷卻期、罰沒比例、贖回準備）照合約寫，改合約要回來改這裡。
     */
    titleTooltip: '各項依目前價格估算後加總，不是現在就能全部領出的金額。各項的流動性與風險不同，滑到下方各欄的標題可以看說明。',
    liquid: '可立即動用',
    liquidTooltip: '錢包的 USDC ＋ 投資帳戶的可提領餘額：不必賣出、領回押金或贖回就能動用。不含已投入的金額、履約押金、風險準備金存款與代幣化資產。',
    unrealisedPnl: '未實現損益',
    unrealisedPnlTooltip: '你目前的投資如果現在賣出的淨損益：依鏈上結算價計算，已扣手續費與資金費，與進階投資工具的持有表同一個算法。不含部分投資獲利時另收的 10% 績效費；資金費以最後一次結算為準；不含風險準備金的補貼。有投資讀不到數字時，這裡顯示「—」並標成總額不完整',

    /**
     * 單複數寫成兩條完整的句子。catalog 沒有複數引擎，而把 'balance' / 'balances'
     * 抽成一個可插入的字，等於假設每個語言都用同樣的句構——中文沒有複數變化，
     * 其他語言的複數規則也不只兩種。
     */
    incompleteOne: '{count} 筆餘額無法讀取——此總額不完整。',
    incompleteMany: '{count} 筆餘額無法讀取——此總額不完整。',

    part: {
      spot: '代幣化資產',
      wallet: '錢包',
      trading: '投資帳戶',
      staked: '履約押金',
      lpVault: '風險準備金存款',
    },

    /** 每一欄的流動性與風險說明，滑過欄位標題時出現。 */
    risk: {
      spot: '依價格來源估算，不是市場成交價；標的休市時價格可能停在最後一筆。贖回時以當下價格換回 USDC，而且資產金庫要有足夠的 USDC 準備才贖得到。這些代幣只追蹤標的價格，不能換成真正的股票或商品。',
      wallet: '你的 Web3 錢包裡的 USDC，隨時可以動用。價值取決於穩定幣能否維持 1 美元。',
      trading: '可提領餘額隨時可以領回；已投入的金額要賣出後才拿得回來。虧損達到一定程度時，這筆投資會被自動結清。這一欄不含未實現損益，損益另外列在淨資產旁邊。',
      staked: '你存入的履約押金（USDC）。申請領回後要等 1 天才能拿到。跟著你投資的跟隨者虧損 30% 以上退出時，會從你的押金扣罰該筆虧損的一半，最多扣到押金的 50%。',
      /** 跟單旗標關閉的租戶用這一句：不提跟單，只講罰沒上限。 */
      stakedNoCopy: '你存入的履約押金（USDC）。申請領回後要等 1 天才能拿到。公開的扣罰規則觸發時會被扣除，單次最多扣押金的 50%。',
      lpVault: '投資人的虧損超過投入金額時，由風險準備金補上，補貼會讓份額價值下降。這裡顯示的是依目前份額價格估算可領回的 USDC，準備金不足時無法全額領回。',
    },

    /** 某一項讀不到時的說明（Unread Balance，見 CONTEXT.md）。 */
    unread: {
      spot: '部分代幣化資產的餘額或價格無法讀取',
      wallet: '錢包餘額無法讀取',
      trading: '投資帳戶無法讀取',
      staked: '履約押金無法讀取',
      lpVault: '風險準備金無法讀取',
    },
  },

  /**
   * RWA 資產配置——見 CONTEXT.md 的 RWA／Asset Class 詞條。刻意跟 netWorth
   * 分開：這裡的分母是交易部位的保證金，不是淨資產，兩個數字不會對得起來，
   * 用同一個 title 或同一組詞會讓讀者以為算法一樣。
   */
  allocation: {
    title: '我的資產配置',
    subtitle: '持有的代幣化資產市值 ＋ 投資帳戶裡的投入金額；不含錢包現金、履約押金與風險準備金——不是淨資產的配置。',
    /**
     * SHOW_PERPETUALS 關閉時的版本。仍然要提到部位保證金——帳戶裡可能還有旗標
     * 打開前開的舊部位，說「只算持倉」就是錯的；但把它寫成附帶條件，而不是與
     * 持倉並列的主角。
     */
    subtitleSpot: '持有的代幣化資產市值（投資帳戶若仍有投資，投入金額一併計入）；不含錢包現金、履約押金與風險準備金——不是淨資產的配置。',
    noPositions: '尚無持倉',
    /** 只有現貨持倉、沒有任何部位時的說明——那一欄的損益是「—」而不是 $0。 */
    holdingsOnlyNote: '損益欄只涵蓋投資帳戶裡的投資；直接持有的代幣化資產沒有鏈上成本可算。',

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
      since: '自 {date}（你最早一筆投資的買進日）起 · {days} 天',
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
      youLabel: '你（依名目金額）',
      youHint:
        '未實現損益 ÷ 名目金額——用投資的完整金額當基準，才能跟指數公平比較。上方配置環的分母是投入金額，這裡不同，是刻意的。',
      noPositions: '尚無持倉',
    },
  },

  quickAction: {
    trade: '投資',
    copyTrader: '跟著投資',
    /** 跟單旗標關閉時同一顆按鈕的說法（仍連到 /marketplace 的配置市集）。 */
    marketplace: '瀏覽配置市集',
    history: '歷史記錄',
    proTerminal: '進階投資工具',
  },

  /**
   * Open Positions 的欄位名。simple 與 expert 兩張表共用同一份——原本 expert 表在
   * 頁面裡另外寫了一份一模一樣的清單，兩份字得同時改才不會不一致。
   */
  column: {
    asset: '標的',
    carbonTier: '碳分級',
    side: '看法',
    entry: '買進價',
    oracle: '鏈上價格',
    liveMarket: '即時市價',
    margin: '投入金額',
    leverage: '放大比例',
    copiedFrom: '跟隨的策略分享者',
    unrealizedPnl: '未實現損益',
    accruedFunding: '累計資金費',
    value: '價值',
  },

  /**
   * issue #100 ② / #101：Simple Mode 換掉交易桌的用字。同一批欄位，只換名字——
   * 未實現損益 → 持有期報酬、保證金 → 投入金額。沒有覆寫的欄位沿用上面的 column。
   * 見 frontend/CONTEXT.md 的詞彙表。
   */
  columnSimple: {
    unrealizedPnl: '持有期報酬',
    margin: '投入金額',
    value: '目前價值',
  },

  /** 欄位的 tooltip。只有會被誤讀的欄位需要——兩個價格擺在一起且幾乎不相等。 */
  columnHint: {
    entry: '你的買進價格',
    oracle: '鏈上程式結算依據的價格——未實現損益以這個價格（加上市場熱度溢價後的結算價）計算',
    liveMarket: '鏈下報價來源，變動會早於鏈上價格，因此出現落差是正常現象',
    unrealizedPnl: '現在賣出會比投入金額多拿或少拿多少：依鏈上結算價計算，已扣賣出手續費、借貸費與應付資金費。不含部分投資獲利時另收的 10% 績效費；資金費以最後一次結算為準；不含風險準備金的補貼',
  },

  /** 部位頁籤的平倉按鈕（見 lib/pepefi/closeGuard.ts）。 */
  close: {
    column: '操作',
    button: '賣出',
    closing: '賣出中…',
    closed: '已賣出',
    halted: '{asset} 市場目前暫停，暫時無法賣出。',
    copyManaged: '這筆投資屬於你正在跟隨的策略，請在上方「跟著投資」按「停止跟隨」，會一併賣出。',
    /** 平倉欄的短標籤；完整說明（copyManaged）放在滑鼠移上去的提示。 */
    copyManagedShort: '跟隨中',
    leftover: '這筆是先前跟隨策略分享者時留下的投資，可直接賣出。',
  },

  page: {
    /** 審查 L5：getPosition 讀不到的部位不會出現在表格裡，要明講。 */
    positionsUnread: '有 {count} 筆投資這次讀取失敗，下表與合計不完整。重新整理後再看。',
    title: '我的投資組合',
    refresh: '重新整理',

    /**
     * 頁籤。#146：現貨是平台的門面（SHOW_PERPETUALS 預設關），所以排在前面且
     * 是預設；部位是第二頁。Simple／Expert 共用同一組字——「部位」是本平台對
     * 槓桿持倉的固定講法，不用「合約」。
     */
    tab: {
      spot:      '持有資產',
      positions: '投資帳戶',
    },
    connectWallet: '連接錢包以查看你的投資組合。',

    unsupportedNetwork: '不支援的網路',
    connectedTo: '目前連線於 ',
    connectedToAfter: '。',
    switchTo: '請切換到 ',
    switchToAfter: '。',
    unknownChain: '未知',
    chainNumber: '鏈 {id}',

    demoTitle: '訪客模式 — 無即時鏈上資料',
    demoDescription:
      '你目前在訪客模式，沒有連接錢包，因此無法讀取真實餘額或投資。請連接真實錢包以查看你的實際投資組合。',

    emptyTitle: '你的投資組合是空的',
    emptyDescription: '先領取 {token}，再到「資產」頁買進黃金、股票等代幣化資產；想跟著投資，到「策略市集」挑一位策略分享者。',
    /** 跟單旗標關閉時。 */
    emptyDescriptionNoCopy: '先取得 {token}，接著到「資產」頁買進代幣化資產，或到配置市集參考他人發布的配置。',
    emptyCta: '取得 {token}',

    side: {
      long: '看漲 ↑',
      short: '看跌 ↓',
    },

    activeCopies: '正在跟隨',
    traderFollowedOne: '已跟隨的策略分享者',
    traderFollowedMany: '已跟隨的策略分享者',
    totalCopyPnl: '跟著投資總損益',
    noCopyPositions: '沒有跟著投資的持有',

    copyPositions: '跟著投資',
    copyOutdated: '策略已更新',
    copyOutdatedHint: '策略分享者發布了新版策略。你跟隨的仍是舊版，不會自動調整。',
    copyRefresh: '更新到最新版',
    copyRefreshing: '更新中…',
    copyRefreshStep: '停止跟隨舊版、把取回的 {amount} USDC 提回錢包，接著到跟著投資頁用同樣金額跟隨最新版。',
    stopLossNone: '不提醒',
    stopLossOption: '虧 {pct}%',
    stopLossReached: '已達停損',
    stopLossHint: '停損提醒只存在這個瀏覽器，不會自動賣出；到了請自己按「停止跟隨」。',
    notCopyingAnyone: '你還沒有跟隨任何策略分享者。',
    browseTraders: '瀏覽策略分享者 →',
    copyColumn: {
      trader: '策略分享者',
      copiedAt: '開始跟隨時間',
      initial: '初始金額',
      current: '目前金額',
      return: '報酬率',
      stopLoss: '停損提醒',
      actions: '操作',
    },
    unfollow: '停止跟隨',
    unfollowStale: '價格過期',
    unfollowedOk: '已停止跟隨並賣出所有相關投資 ✓',

    openPositions: '目前的投資',
    openCount: '{count} 筆投資 · 自己買進 + 跟隨策略分享者',
    openCountNoCopy: '{count} 筆投資',
    noOpenPositions: '目前沒有投資。',
    /** 未平倉部位上方總計卡片的標題，label 是欄位名稱（價值、未實現 PnL…）。 */
    totalOf: '{label}總計',

    // issue #101：Simple Mode 的說法。這些部位是既有的（可能在 Expert 開的），
    // Simple Mode 仍要能看到、平掉它們，只是不用交易桌的字。
    openPositionsSimple: '我的投資',
    openCountSimple: '{count} 筆投資',

    freeMargin: '可提領餘額',
    /** issue #100 ②：Simple Mode 不出現「保證金」。這是可以提領回錢包的餘額。 */
    freeMarginSimple: '可提領餘額',
    amountPlaceholder: '金額',
    withdraw: '提領',
    withdrawnOk: '已提領 {amount} {token} ✓',
    enterValidAmount: '請輸入有效金額',

    copyPerformance: '跟著投資績效',
    chart: {
      deposited: '已存入',
      now: '目前',
      initial: '初始',
      portfolioValue: '投資組合價值',
    },
    autoRefresh: '每 30 秒自動更新 · 兩點式檢視（初始 vs 目前）',
  },

  /**
   * ADR-024：全站提醒（CopySyncNotice，任何內頁的頂端；投資組合本身不顯示）。沒有自己跑 agent 的人
   * 收不到 webhook，部位停在舊版時只能靠這裡知道。與下面的 autoSync 一樣刻意不寫「跟單」與槓桿。
   */
  syncNotice: {
    behind: '策略分享者發布了新版策略：你有 {count} 筆還停在舊版。',
    needsYou: '其中 {count} 筆要你處理（{reasons}），不會自己更新。',
    waitingOnly: '自動同步開著，冷卻結束、有執行者送出後就會更新。',
    reasonSeparator: '、',
    reasons: {
      feeAboveCap: '平台調高了執行費，要重新同意',
      needsGas: '自動同步油箱不足',
      manual: '沒有開啟自動同步',
      snapshot: '要更新到最新版',
    },
    cta: '到投資組合查看',
    dismiss: '知道了',
  },

  /**
   * ADR-024：跟單部位卡上的自動同步（同步狀態、立即同步、設定、油箱）。這組字只在合約支援
   * 自動同步時出現；油箱有餘額時就算跟單旗標關閉也要看得到、提得出來（退出永遠不藏）。
   * 刻意不寫「跟單」兩字：油箱與同步是帳戶層級的事。
   */
  autoSync: {
    column: '同步',
    versions: '第 {current} 版／最新第 {latest} 版',
    versionsLatest: '第 {current} 版（最新）',
    on: '自動同步：開',
    off: '自動同步：關',
    syncCount: '已同步 {count} 次',
    followerClosed: '你自己賣出過其中一檔：之後的結果不再計入策略分享者的扣罰評分。',
    status: {
      upToDate: '已是最新版',
      /** Simple 模式、自動同步關著：開啟的入口只在專家模式（與跟單頁的說法一致）。 */
      upToDateSimpleOff: '已是最新版。要開啟自動同步，請切換到專家模式',
      /**
       * 已是最新版、開著自動同步，但平台的執行費已高於你同意的費率：現在沒有東西要同步，策略分享者下次發版時
       * 別人卻不能代為同步（合約 ExecutionFeeAboveCap）。提早說，不要等到落後才發現。
       */
      consentStale: '已是最新版。但平台調高了執行費，超過你同意的費率：策略分享者下次發版時，別人不能代為同步。按「設定」看過新費率後重新儲存即可恢復',
      consentStaleSimple: '已是最新版。但平台調高了執行費，超過你同意的費率：策略分享者下次發版時，別人不能代為同步。切換到專家模式看過新費率後重新同意即可恢復',
      manual: '有新版：按「立即同步」更新，或開啟自動同步',
      /**
       * Simple 模式不提供「立即同步」與自動同步設定：同步會依新版開新部位（含槓桿），是交易桌的入口，
       * 不是退出；要先在專家模式檢視新版內容。取消與關閉自動同步仍在。
       */
      manualSimple: '有新版：切換到專家模式檢視新版內容後再同步',
      feeAboveCap: '平台調高了執行費，超過你開啟自動同步時同意的費率：別人暫時不能代為同步。按「設定」重新儲存即同意新費率，或按「立即同步」自己同步',
      /** 同上，Simple 模式：「設定」與「立即同步」只在專家模式，不能叫人去按看不到的按鈕。 */
      feeAboveCapSimple: '平台調高了執行費，超過你開啟自動同步時同意的費率：別人暫時不能代為同步。切換到專家模式可以看過新費率後重新同意，或自己同步',
      /** 冷卻結束不會自動同步，要等執行者送出：不能讓人以為時間一到就會更新。 */
      cooldown: '冷卻中，{time} 之後執行者才能代為同步，實際時間可能更晚。要馬上更新可按「立即同步」',
      cooldownSimple: '冷卻中，{time} 之後執行者才能代為同步，實際時間可能更晚。要馬上更新，請切換到專家模式',
      needsGas: '油箱不夠付一次代為同步，還差 {eth} ETH',
      waiting: '等執行者送出同步，時間不固定，可能要幾個小時。要馬上更新可按「立即同步」',
      waitingSimple: '等執行者送出同步，時間不固定，可能要幾個小時。要馬上更新，請切換到專家模式',
      waitingExecutor: '等你指定的執行者送出同步。要馬上更新可按「立即同步」',
      waitingExecutorSimple: '等你指定的執行者送出同步。要馬上更新，請切換到專家模式',
      unknown: '讀不到同步狀態',
    },
    outdatedHint: '策略分享者發布了新版策略。按「立即同步」先檢視新版內容，確認後就地換成最新版（不必停止再重來），或開啟自動同步。',
    outdatedHintSimple: '策略分享者發布了新版策略。切換到專家模式可以檢視新版內容後同步。',
    /** 指定執行者（合約 setSyncExecutor）。 */
    executorChip: '限定執行者 {addr}',
    executorTip: '只有這個地址（與你本人）能代為同步，其他人會被鏈上程式拒絕。要改或解除，到「設定」。',
    /** 同上，Simple 模式沒有「設定」鈕。 */
    executorTipSimple: '只有這個地址（與你本人）能代為同步，其他人會被鏈上程式拒絕。要改或解除，請切換到專家模式，按「設定」。',
    executorSaved: '已更新指定執行者 ✓',
    executorFailed: '自動同步設定已儲存，但指定執行者沒有送成功，請再試一次。',
    /** 「立即同步」的確認視窗：送出前先看新版的內容與費用（resyncAtVersion 釘住這裡顯示的那一版）。 */
    confirm: {
      title: '同步到第 {version} 版',
      loading: '讀取新版內容…',
      loadFailed: '讀不到新版內容，請稍後再試。',
      intro:
        '送出前請先看清楚新版的內容。這次送出會釘住第 {version} 版：策略分享者在你送出前又發一版，會整筆退回，不會換成你沒看過的那一版。',
      colAsset: '資產',
      colSide: '看法',
      colWeight: '比重',
      colLeverage: '放大比例（新版 → 實際）',
      long: '看漲',
      short: '看跌',
      capped: '已被上限限制',
      noCap:
        '這一列沒有設定放大比例上限：會照新版的比例買進（只受平台的資產上限約束）。想設上限，先到「設定」儲存一次（可以不開啟自動同步）。',
      leverageRaised: '這次會用到的最高放大比例（{to}×）高於目前投資的最高比例（{from}×）。',
      closeAll:
        '同步會先賣出這一列的全部投資，再用賣出取回的投入金額依新版買進；任何一檔買不進（未通過 KYC、休市、平台總量上限）整筆取消、投資維持原狀。',
      execFee: '執行費（從油箱扣）',
      topUp: '油箱不夠，這次會附上 {eth} ETH 存進油箱',
      released: '預計取回的投入金額',
      perfFee: '獲利投資的績效費（10%，給策略分享者）',
      tradingFee: '依新版買進的手續費',
      approx: '約 {amount} {token}',
      unknown: '—',
      estimateNote: '金額依目前價格估算，實際以上鏈結果為準。賣出的手續費、借款費與資金費已算在目前價值裡。',
      cancel: '取消',
      cta: '確認同步',
    },
    syncNow: '立即同步',
    syncing: '同步中…',
    synced: '已同步到最新版 ✓',
    topUpFirst: '油箱不夠付這次同步的執行費：這筆同步會一起附上 {eth} ETH 存進油箱。',
    settings: '設定',
    enable: '開啟自動同步',
    disable: '關閉自動同步',
    saved: '已更新自動同步設定 ✓',
    disabledOk: '已關閉自動同步 ✓',
    tank: {
      title: '自動同步油箱',
      balance: '{eth} ETH',
      estimate: '約可代為同步 {count} 次',
      /** 平台的執行費高於跟隨者同意的費率：油箱再多，別人也不能代為同步（合約 ExecutionFeeAboveCap）。 */
      consentBlocked: '重新同意新的執行費之前，別人不能代為同步',
      deposit: '存入',
      withdraw: '提領',
      deposited: '已存入 {eth} ETH ✓',
      withdrawn: '已提領 {eth} ETH ✓',
      note: '油箱裡的 ETH 只用來付同步的執行費與小費，記在鏈上程式裡你自己的名下，只有你能提領。',
    },
    dialog: {
      settingsTitle: '自動同步設定',
      enabled: '開啟自動同步',
      /**
       * 開關打開時，儲存＝以平台現行的每檔執行費簽名同意（setAutoSync 的 maxExecFeePerLeg）。
       * 費率和之前同意的不同時，兩個數字都列出來：不能讓人在看不到數字的情況下簽下調高後的上限。
       */
      consentLine: '儲存後，你簽名同意：別人代為同步時，每檔最多從油箱扣 {fee} ETH 執行費（平台現行費率）。',
      consentChanged: '平台的執行費現在是每檔 {fee} ETH，你之前同意的是 {old} ETH。儲存就是同意新的費率。',
      /** 設定與費率都沒變：儲存不會送出 setAutoSync，只說目前同意的。 */
      consentCurrent: '你目前同意：別人代為同步時，每檔最多從油箱扣 {fee} ETH 執行費（與平台現行費率相同）。',
      /** 費率調低：不必重新同意也能同步；儲存會把上限一起降下去。 */
      consentLowered: '平台的執行費調低為每檔 {fee} ETH（你之前同意 {old} ETH）。不必重新同意也能同步；儲存的話，你同意的上限會一起降到 {fee} ETH，之後平台調回去時要再同意一次。',
      /** 讀不到現行費率：不能說出「平台現行費率」，開著時也不能儲存。 */
      consentUnknownFee: '讀不到平台現行的執行費，無法確認你要同意的費率，請稍後再試。在那之前不能改設定；關閉自動同步、只改指定執行者不受影響。',
      gasTitle: '自動同步油箱',
      amount: '金額（ETH）',
      max: '全部',
      cancel: '取消',
      save: '儲存',
      depositCta: '存入油箱',
      withdrawCta: '提領到錢包',
      invalidAmount: '請輸入有效的 ETH 金額。',
      overBalance: '超過油箱餘額。',
      offNote: '自動同步關閉時，這裡的放大比例上限仍會套用在你自己按「立即同步」的時候；指定的執行者在重新開啟後仍然有效。冷卻與小費只在開啟時有作用。',
    },
  },

  /**
   * 配置佔比與分類損益已搬到上面的 allocation（issue #66），平台自評的 ESG 分數在 #383
   * 拿掉。cat 仍留著——assetClass.ts 的 ASSET_CLASS_CONFIG 還在用它。
   */
  analysis: {

    cat: {
      crypto: '加密貨幣',
      equity: '股票',
      commodity: '商品',
      bond: '債券',
    },
  },
};
