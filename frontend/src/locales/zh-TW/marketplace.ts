/**
 * Marketplace 頁：明星交易者排行榜。
 *
 * 「明星交易者」（isStarTrader）純粹是前端算出來的徽章（聲譽 > 80 且跟隨者 > 3），
 * 不對應任何合約層級的等級，跟 common.ts 的 `tier`（鑽石／黃金／白銀／青銅，那個
 * 才是合約事件裡真的用到的名字）不是同一類，沒有理由留英文。
 */
export const marketplace = {
  title: '⭐ 明星策略分享者排行榜',
  subtitle: '瀏覽公開發布在鏈上的策略，選一位跟著投資',
  networkError: '網路錯誤——請檢查錢包連線',

  /** #383：下架的交易者（lib/pepefi/hiddenTraders.ts）。交易者頁與跟單頁共用。 */
  hiddenTrader: {
    title: '這位策略分享者已下架',
    /** 交易者頁在跟單旗標關閉時也會顯示這段，所以不能用跟單用語（copyWording.test.ts）。 */
    body: '這位模擬策略分享者已不再列出（策略依據不再使用，或與另一位同名、較活躍的策略分享者重複）。鏈上的紀錄沒有刪除，仍可在區塊鏈瀏覽器查到；你名下與它有關的投資照樣在投資組合裡，可以自行賣出。',
    back: '回到策略分享者排行榜',
  },


  sort: {
    score: '排序：綜合分',
    reputation: '排序：聲譽',
    followers: '排序：跟隨者',
    volume: '排序：投資金額（7 天）',
    pnl: '排序：損益（7 天）',
    stake: '排序：履約押金',
  },

  refreshAria: '重新整理市集資料',

  search: {
    placeholder: '搜尋名稱或地址…',
    /** 這條鏈上有交易者,只是搜尋詞沒比對到——跟「這條鏈真的沒人」是不同的空狀態。 */
    noResults: '沒有符合「{query}」的策略分享者',
  },

  /** 表格欄位標頭。金額類欄位(量、PnL、質押)沿用 card.* 裡已經有的字串,單一來源不重複定義。 */
  table: {
    /** 掃描不完整時排名旁的標記。 */
    provisional: '暫定',
    rank: '#',
    trader: '策略分享者',
    score: '綜合分',
    reputation: '聲譽',
    strategy: '策略',
    winRate: '勝率',
    actions: '操作',
    /** 平倉少於 5 筆時掛在勝率旁邊的灰標,不是紅色警告——只是不夠準,不是壞消息。 */
    /** 勝率旁的小標籤：這段期間平倉不到 5 筆，勝率參考就好。跟「不列入排名」是兩件事。 */
    insufficientSample: '樣本少',
    /** 表格裡「不列入排名」那一段的分隔列。rule 是下面兩句之一。 */
    unranked: '以下資料不足，不列入排名（{rule}）',
    unrankedRuleHistory: '投資未滿 {days} 天',
    unrankedRuleTrades: '賣出未滿 {count} 筆',

    /**
     * 滑鼠移到欄位標題時的說明。{days} 是近期視窗的天數（有績效資料是 30，否則是 7），
     * {from}／{to} 是績效統計期間，{rule} 是上面 unrankedRule… 其中一句。
     */
    tips: {
      rank: '名次只給資料足夠的策略分享者；{rule}的列在表格最後，名次顯示「—」。前三名在上方的領獎台。',
      score: '0–100 的綜合分：報酬（40）＋勝率（25）＋履約押金（20）＋聲譽（15），被扣罰會再扣分（最多 20）。報酬與勝率看最近 {days} 天。點分數看拆解。',
      strategy: '策略分享者目前發布的這一版策略：資產、方向（↑ 看漲、↓ 看跌）與權重。跟著投資時照的就是這一版。',
      totalReturn: '整段統計期間（{from} 至 {to}）的淨值變化：期末淨值 ÷ 起始資金 − 1。淨值包含還在持有的投資依當日價格計算的價值。',
      maxDrawdown: '統計期間內，淨值從歷史高點往下跌的最大幅度。例如 -20% 代表曾經從高點跌掉五分之一。越接近 0 越穩。',
      sharpe: '風險調整後報酬：每日報酬的平均 ÷ 每日報酬的標準差，再乘 √365 換算成一年。同樣的波動下報酬越高，數字越大；一般把 1 以上視為不錯，負數代表這段期間平均是虧的。',
      volume: '最近 {days} 天新買進的投資金額加總（USDC）。',
      pnl: '最近 {days} 天賣出的投資已實現損益加總（USDC）。還沒賣出的投資不算。',
      winRate: '最近 {days} 天賣出的投資中，賺錢的比例；括號內是賣出筆數。少於 5 筆時標「樣本少」，參考就好。',
      followers: '目前還跟著這位策略分享者投資的人數，同一人只算一次；已經停止跟隨的人不算。',
      stake: '策略分享者繳在鏈上程式裡的履約押金（USDC）。跟隨者的虧損達 30% 時，會扣罰虧損金額的一半（最多履約押金的一半）；⚠ 表示被扣罰過。',
    },
  },

  /**
   * TraderScore 算式攤開的 popover。不是展示公式長什麼樣子,是把這位交易者
   * 自己五行的實際數字與各自拿到幾分秀出來。
   */
  scoreBreakdown: {
    returnLabel: '報酬率',
    winRateLabel: '勝率',
    slashLabel: '扣罰扣分',
    totalLabel: '總分',
    totalValue: '{total} / 100',
    insufficientNote: '賣出少於 5 筆,勝率僅供參考',
  },

  /** 領獎台跟著目前排序走——這句標題是唯一提醒使用者這件事的地方。 */
  podium: {
    hiddenIncomplete: '部分區塊範圍讀取失敗，7 日指標不完整，暫不選出領獎台。重新整理成功後才會顯示。',
    heading: '🏆 目前排序前三名',
    /** 平倉 <5 筆的人被排除在領獎台之外,人數不夠時要講清楚為什麼消失,不能悄悄空白。 */
    noneQualified: '還沒有策略分享者符合排名資格（{rule}的不列入排名），暫時沒有領獎台名次——這些人仍然在下面的表格裡。',
  },

  loadFailed: '載入失敗：',
  /** getAllTraders 讀取失敗——不是「沒有交易者」。 */
  tradersReadFailed: {
    title: '讀取失敗',
    description: '無法從鏈上讀取策略分享者清單，這裡的空白不代表沒有策略分享者。請稍後按重新整理再試。',
  },
  /** 分段掃描有段落失敗：交易量／PnL 不完整，不能讀成「沒人交易」。 */
  scanIncomplete: '{count}／{total} 個區塊範圍讀取失敗，下方投資金額與損益可能偏低、不完整。',

  /** 排行榜掃描鏈上事件的進度。視窗在 Base 上是 800 段（併發 3 約兩分半），不講進度會像當掉。 */
  scanProgress: '掃描鏈上紀錄… {done}/{total}',

  empty: {
    title: '這條鏈上還沒有已發布策略的策略分享者',
    /** 排行榜是即時算的,不是「還沒有人」——講清楚資料怎麼來的,讓人自己判斷是連錯鏈還是真的沒人。 */
    description: '排行榜由鏈上紀錄即時計算,目前連線到 {chain},掃描了最近 {blocks} 個區塊（約 {window}）。如果預期會看到策略分享者,先確認錢包連的是正確的鏈。',
    unknownChain: '未知網路（chainId {chainId}）',
    cta: '成為策略分享者',
    secondaryCta: '看 x402 文件',
  },

  card: {
    starTrader: '⭐ 明星策略分享者',
    /** 判定只看聲譽與跟隨人數，跟績效無關，不能寫成「已驗證」。 */
    starHint: '聲譽高且多人跟著投資，不代表績效好',
    noName: '—',
    noStrategy: '尚無策略',
    /** 策略籌碼：↑BTC 50% 3× */
    allocChip: '{side}{asset} {weight}%',

    volLabel: '7 日投資金額',
    pnlLabel: '7 日損益',
    followersLabel: '跟隨者',
    /** 換過 CopyTracker 之後，舊 tracker 上還在跟的人（contracts/legacyCopyTrackers.ts）。 */
    legacyFollowers: '含舊版 {count}',
    legacyFollowersTip: '其中 {count} 位跟隨者用的是舊版鏈上程式：投資仍在跟隨者自己名下，但不會自動同步，停止跟隨時也不再計入扣罰評分。',
    stakeLabel: '履約押金',

    slashed: '⚠ 已被扣罰 {amount} USDC',

    copy: '跟著投資 →',
    noStrategyButton: '尚無策略',
  },

  /** 頁尾統計。單複數各自是完整的一句話，不是拼接出來的。 */
  footer: {
    countOne: '{count} 位策略分享者',
    countMany: '{count} 位策略分享者',
    followersTotal: '共 {count} 位跟隨者',
    starTraderOne: '{count} 位明星策略分享者',
    starTraderMany: '{count} 位明星策略分享者',
    volumeWindow: '投資金額與損益統計來自最近 ~{blocks} 個區塊（約 {window}）',
    /** 視窗長度的兩種單位。不足兩天講小時,否則講天。 */
    windowHours: '{hours} 小時',
    windowDays: '{days} 天',
  },

  /**
   * 模擬交易者（issue #309）。這條鏈有績效資料時才出現。
   * disclosure 是固定顯示的揭露：不能收合，也不依賴任何鏈上讀取。
   */
  hero: {
    simulatedTag: '模擬',
    disclosure:
      '模擬策略分享者：標示「模擬」的策略分享者由程式依公開的規則操作，績效是真實歷史價格在本機鏈上的回放，不是真人的投資紀錄。每一筆買進與賣出都是鏈上紀錄；累積報酬、回撤等統計由這些鏈上紀錄在鏈下算出。',
    /**
     * 時間壓縮的回放（公開站，#344）。不能沿用上面那句：「本機鏈」在 Base Sepolia 上不是事實。
     * 後兩句是這份資料特有的代價與 KYC 的展示方式。
     */
    disclosureCompressed:
      '模擬策略分享者：標示「模擬」的策略分享者由程式依公開的規則操作，績效是真實歷史價格的回放，不是真人的投資紀錄。每一筆買進與賣出都是鏈上紀錄；累積報酬、回撤等統計由這些鏈上紀錄在鏈下算出。在 Base Sepolia 以壓縮時間回放，未計借款費與資金費率，上鏈時間為回放當天。KYC 送出即通過。',
    range: '績效統計期間 {from} 至 {to}；投資金額、損益、勝率為最近 30 天',
    volLabel: '30 日投資金額',
    pnlLabel: '30 日損益',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    sortReturn: '排序：累積報酬',
    sortDrawdown: '排序：最大回撤',
    sortSharpe: '排序：Sharpe',
    /** 領獎台卡片上的報酬率是 30 天的數字，跟表格的「累積報酬」不同。 */
    podiumReturn: '30 日報酬率',
    /** 有績效資料時交易量與 PnL 是 30 天的視窗，排序下拉也要跟著講 30 天。 */
    sortVolume: '排序：投資金額（30 天）',
    sortPnl: '排序：損益（30 天）',
  },
};
