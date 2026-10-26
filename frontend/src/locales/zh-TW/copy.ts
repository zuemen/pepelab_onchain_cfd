/**
 * 跟單頁（/copy/:traderAddress）。
 */
export const copy = {
  invalidAddress: '無效的交易者地址。',
  connectWallet: '連接錢包以跟單交易者。',
  viewOn: '在 {explorer} 查看 ↗',
  loadFailed: '載入交易者失敗：',
  breadcrumbMarketplace: '交易市集',

  header: {
    unknownTrader: '未知交易者',
    repChip: '◆ {rep} 聲譽',
    staked: '已質押 {amount} {token}',
    notRegistered: '⚠ 此地址尚未註冊為交易者。',
  },

  strategy: {
    title: '最新策略',
    empty: '尚未發布策略。',
    /** 分配標籤：↑ sBTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  esg: {
    title: '策略 ESG 評分',
    champion: 'ESG 冠軍',
    aware: 'ESG 關注者',
    considerGreener: '考慮選擇更環保的標的',
    details: '詳情 →',
  },

  amount: {
    title: '跟單金額',
    placeholder: '1000',
    unitSuffix: '{token} 總保證金',
    disabledHint: '已停用 — 無策略',
    /** 金額太小，有一檔會低於交易所的最低保證金，整筆會失敗。 */
    belowMinimum: '金額太小：照比例拆分後有一檔低於交易所的最低保證金。這位交易者的策略最少需要 {amount} USDC。',
  },

  /** #333：跟單前看到這次跟單會促成平台退役多少模擬碳權。噸數歸屬平台（carbonWording.test.ts）。 */
  retirementEstimate: {
    title: '這次跟單促成的碳權退役（估算）',
    value: '約 {tonnes} 公噸模擬碳權',
    body: '跟單手續費 {fee} 中，平台份額 {platform} 裡有 {carbon} 會撥入退役預算，促成平台退役約 {tonnes} 公噸模擬碳權。噸數歸屬平台，不是你個人的減碳；退役用的是平台自己的收入，不向你多收任何費用。',
    note: '估算：只算跟單手續費；跟單部位日後的績效費也會照同樣比例撥入。比例與價格讀自鏈上合約，退役紀錄在 ESG 頁。',
  },

  preview: {
    totalDeposit: '總存入金額：',
    copyFee: '− 跟單手續費（0.3%）：',
    tradingFeeBuffer: '− 交易手續費緩衝：',
    effectiveMargin: '有效保證金：',

    column: {
      asset: '標的',
      side: '方向',
      leverage: '槓桿',
      weight: '權重',
      margin: '保證金',
      notional: '名義價值',
      estEntry: '預估進場價',
    },
    long: '做多 ↑',
    short: '做空 ↓',
  },

  feePreview: {
    title: '手續費預覽',
    copyFee: '跟單手續費（0.3%）',
    netMargin: '實際存入保證金',
    executionFee: '執行費（ETH）',
    split: '跟單手續費依 70% → 交易者 · 20% → 平台 · 10% → 罰沒池 分潤。執行費用於支付 Keeper 機器人。',
  },

  skinInGame: {
    title: '交易者風險共擔',
    staked: '已質押',
    reputation: '聲譽',
    reputationUnit: '分',
    totalSlashed: '累計罰沒',
    slashedWarning:
      '⚠ 此交易者曾因造成跟隨者過度虧損而被罰沒 {amount} {token}。請謹慎評估。',
    noStakeWarning:
      '⚠ 此交易者尚未質押——沒有風險共擔。若其造成虧損，你無法觸發罰沒機制。',
    slashRule:
      '⚠ 若你的虧損超過 30%，此交易者的質押將被罰沒（虧損金額的 50%，上限為質押額的 50%）並轉移給你作為補償。',
  },

  confirm: {
    title: '確認跟單',
    approveStep: '批准 {token} 給 CopyTracker',
    followStep: '跟隨交易者',

    staleTitle: '價格過期 — 暫停跟單',
    staleExplain:
      '跟單是一筆交易開 {count} 個倉位，只要有一檔過期整筆都會被拒絕，而 {count} 份 execution fee 的 gas 已經付出去了。',

    kycRequired:
      '🔒 此策略包含股票 / 債券資產，需通過 KYC 審核才能跟單（送出申請後需等審核人員核准）。',
    kycSubmit: '送出 KYC 申請',

    approving: '批准中…',
    approved: '已批准',
    approveCta: '步驟 1 · 批准',

    following: '跟單中…',
    stalePrice: '⛔ {asset} 價格過期',
    followCta: '步驟 2 · 跟隨交易者',

    noStrategy: '⚠ 交易者尚未發布策略，跟單功能已停用。',
    footer: '你的保證金將依上述策略自動分配並存入各部位。',
    /** 合約不支援自動同步（ADR-024）時跟單不是持續跟隨——這句固定顯示在確認區，送出前一定看得到。 */
    snapshotNote:
      '跟單複製的是交易者「目前這一版」策略。之後交易者發布新版本，你的部位不會自動跟著調整；要換成新版本，請取消跟單後重新跟一次。',
    /** 合約支援同步、但這次沒勾自動同步時的說法：換版本不必取消重跟。 */
    snapshotNoteSyncable:
      '跟單複製的是交易者「目前這一版」策略。沒開自動同步時，交易者之後發布新版，你的部位不會自己變；可以在投資組合按「立即同步」換成最新版，或隨時開啟自動同步。',
    /**
     * 同上，Simple 模式：「立即同步」與自動同步的設定只在專家模式（與投資組合一致），這裡不能叫人去按
     * 一個看不到的按鈕。
     */
    snapshotNoteSyncableSimple:
      '跟單複製的是交易者「目前這一版」策略。交易者之後發布新版，你的部位不會自己變；切換到專家模式可以先檢視新版內容再同步，或開啟自動同步。',
  },

  /**
   * ADR-024：跟單時選用的「自動同步」。揭露那一句固定顯示在勾選框下方——開啟前一定看得到
   * 「誰能做什麼、不能做什麼、怎麼退出」。
   */
  autoSync: {
    title: '自動同步（選用）',
    toggle: '交易者發布新版時，自動把我的部位調成最新版',
    disclosure:
      '開啟後，任何人（你自己的 agent、平台的執行程式或第三方）都能在交易者發布新版時，把你的部位調成鏈上最新版；你也可以限定只有自己指定的地址（例如自己的 agent）能執行。他們不能選資產、方向或槓桿，也動不到你其他的資金；你可以隨時關閉自動同步、提領油箱。',
    /** 每次同步的 USDC 成本與時機風險（ADR-024「經濟」、KNOWN_LIMITATIONS #41、#42）：開啟前一定看得到。 */
    costs:
      '每次同步都會先平掉這筆跟單的全部部位、再依新版開倉：平倉與開倉各付一次交易費（例如 5 倍槓桿、0.10% 費率時，每輪約為保證金的 1%），獲利的部位會先結算 10% 績效費給交易者（沒有高水位線，價格來回時可能重複收取）。同步的時間點由交易者何時發版、執行者何時送出決定，可能剛好落在價格對你不利的時候。冷卻越長、槓桿上限越低，這些成本與風險越小。',
    selfCustody:
      '你的私鑰不會離開你的錢包：同步規則寫在合約裡，執行者只是按下按鈕的人，不需要也拿不到你的私鑰。',
    unsupported: '這個網路上的跟單合約還沒升級到支援自動同步的版本，目前跟單仍是快照式。',
    /**
     * Simple 模式只說明、不給勾選框：設定裡有槓桿上限，同步會依新版開新部位，是交易桌的入口。
     * 投資組合在 Simple 模式也只給「關閉」，不給開啟與設定——兩頁說法一致。這句不提槓桿。
     */
    expertOnly:
      '自動同步只能在專家模式開啟：開啟前要先看過它的設定與費用。切換到專家模式就能在跟單時一併開啟，跟單之後也能在投資組合開啟。',
    maxLeverage: '槓桿上限',
    maxLeverageHelp:
      '新版策略的槓桿超過這個數字時，用這個數字開倉。預設是這一版策略最高的槓桿：交易者之後把槓桿調高，不會帶著你一起調高。',
    leverageOption: '{lev}×',
    cooldown: '冷卻時間',
    cooldownHelp:
      '別人兩次替你同步之間至少隔這麼久（你自己同步不受限）。冷卻越短，交易者連發版本時能讓你付的交易費越多：1 小時一天最多 24 輪，24 小時一天 1 輪。預設 24 小時。',
    cooldownOption: '{hours} 小時',
    tip: '執行者小費（每次）',
    tipHelp: '別人替你送出同步時，從油箱付給他的 ETH；你自己同步不付。上限 {max} ETH。',
    tipOption: '{eth} ETH',
    tipNone: '不給（只靠自己或自己的 agent）',
    prefund: '預存油箱（ETH）',
    prefundHelp:
      '油箱付每次同步的執行費（新版每一檔 {fee} ETH）與小費。存在合約裡你自己的名下，隨時可以提領。每檔 {fee} ETH 也是你簽名同意的執行費上限：交易所之後調高費率，別人就不能代為同步，直到你在投資組合看過新費率、重新同意。',
    estimate: '約可同步 {count} 次（以 {legs} 檔、每次 {cost} ETH 估算）',
    oneTx: '一筆交易完成跟單、開啟自動同步與存入油箱，共附 {total} ETH（開倉執行費 {open} ETH + 油箱 {prefund} ETH）。',
    twoTx: '這個合約版本要分開送出：先跟單，再開啟自動同步，最後存入油箱。',
    snapshotNoteAuto:
      '已選擇自動同步：交易者發布新版時，任何人都能把你的部位調成最新版（槓桿不超過 {lev}×），你不需要重新跟單。之後在投資組合可以隨時關閉。',
    invalid: {
      leverage: '槓桿上限必須是 1–5×。',
      tip: '小費超過合約上限。',
      interval: '冷卻時間至少 1 小時（合約下限）。',
      prefund: '預存金額格式不正確。',
    },
    /** 指定執行者（合約 setSyncExecutor）：只讓自己的 agent 同步，別人都不行。 */
    executor: '只讓這個地址代為同步（選填）',
    executorPlaceholder: '0x…（留空＝任何人）',
    executorHelp:
      '填你自己的 agent 使用的熱錢包地址（不是你的主錢包）。之後除了你本人，只有它能替你同步，平台與其他人會被合約拒絕；冷卻、小費、執行費上限照樣適用。留空＝任何人都能代為同步。',
    executorExtraTx: '指定執行者要在跟單之後另送一筆交易；跟單後的冷卻期內（至少 1 小時），本來就沒有人能代為同步。',
    executorInvalid: {
      address: '地址格式不正確。',
      self: '這是你自己的地址：你本人本來就能隨時同步。這裡請填另一把只放 gas 的熱錢包（例如自己的 agent）。',
    },
  },

  tx: {
    enterValidAmount: '請輸入有效金額',
    approved: '{token} 已批准 ✓',
    following: '已跟隨交易者 ✓',
    followingAuto: '已跟隨交易者並開啟自動同步 ✓',
    autoSyncStep: '跟單完成，接著開啟自動同步…',
    autoSyncFailed: '跟單已完成，但自動同步沒有開成功；可以到投資組合再開一次。',
    executorStep: '跟單完成，接著指定執行者…',
    executorFailed:
      '跟單與自動同步已完成，但指定執行者沒有送成功：冷卻結束後任何人都能代為同步。可以到投資組合的「設定」再指定。',
  },

  /** #36：KYC 待審核那句夾了 `<b>`，拆成前後片段。 */
  markup: {
    kycPendingBefore: '⏳ 你的 KYC 申請',
    kycPendingBold: '已送出，正在等待審核',
    kycPendingAfter: '。審核人員核准後才能跟單含股票 / 債券的策略，不需要重複送出。',
  },
};
