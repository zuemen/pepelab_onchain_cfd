/**
 * 策略實驗室（issue #332）。只在 專家模式出現，所以可以用交易桌的詞（開倉、平倉、槓桿、清算）。
 * 揭露（disclosure 與 forecast.method）固定顯示、不可收合；改寫時不能拿掉「不代表未來績效」與
 * 「根據歷史波動的模擬，不是預測模型」這兩個事實。
 */
export const lab = {
  title: '策略實驗室',
  subtitle: '拿真實的歷史價格試跑一種投資方法：看它賺不賺、最多會跌多深，以及未來 90 天可能落在哪個範圍。',
  steps: { pick: '選策略', tune: '調參數', read: '看結果' },
  disclosure:
    '回測與預測不代表未來績效。回測用真實歷史日收盤價，在收盤價成交，並扣掉與本平台相同的費用：買進與賣出手續費依碳分級計算，放大投資時借來的部分每小時收借款費，虧損超過投入金額能承受的範圍時會被自動結清；不模擬資金費用與滑價。預測是根據歷史波動的模擬，不是預測模型。',
  range: '回測期間 {from} 至 {to}・本金 {capital} USDC',

  loading: '載入中…',
  indexMissing: '讀不到策略實驗室的資料。',
  resultMissing: '讀不到這組結果，數字以「—」顯示。',

  expertOnly: {
    title: '這一頁只在 專家模式提供',
    body: '策略實驗室用專業的績效指標比較不同的投資方法，切換到 專家模式就能使用。',
    action: '切換到 專家模式',
  },

  picker: {
    strategy: '選策略',
    params: '調參數',
    asset: '選資產',
    basket: '選一籃資產',
    single: '逐筆（單一資產）',
    portfolio: '持有組合（一籃資產）',
  },

  strategies: {
    dca: { name: '定期定額', tagline: '固定時間買，不猜高低', description: '每隔固定天數買一次，本金平均分給整段期間的每一次。' },
    martingale: {
      name: '馬丁加碼',
      tagline: '越跌越加碼，反彈就出場',
      description: '每一輪先買本金的 {base}%；每比上一筆再跌一段就加碼，金額是上一筆的幾倍；整輪賺到停利就全部賣出、重新開始。',
    },
    grid: { name: '網格', tagline: '低買高賣，賺來回的波動', description: '從起始價往下每隔一段設一格，跌到某一格就買、漲回上一格就賣；一格同時只持有一筆。' },
    momentum: { name: '動量', tagline: '追最近漲最多的', description: '定期換成過去一段時間漲最多的 3 檔，等權重買進。' },
    mean_reversion: { name: '均值回歸', tagline: '撿最近跌最多的', description: '定期換成過去一段時間跌最多的 3 檔，賭它們會漲回來。' },
    trend: { name: '均線趨勢', tagline: '站上均線看漲、跌破看跌', description: '每一檔都持有：價格在均線之上押上漲、之下改押下跌（價格下跌時賺錢）。' },
  },

  params: {
    every_days: '頻率',
    leverage: '放大比例',
    multiplier: '加碼倍數',
    drop_pct: '加碼間距（下跌）',
    take_profit_pct: '停利',
    spacing_pct: '網格間距',
    levels: '格數',
    lookback: '回看',
    window: '均線',
  },
  values: {
    days: '每 {n} 天',
    span: '{n} 天',
    times: '{n}×',
    pct: '{n}%',
    levels: '{n} 格',
  },

  baskets: {
    low_carbon: '低碳四檔',
    equities: '科技股五檔',
    macro: '總經四檔',
    crypto_mix: '加密與成長四檔',
  },

  fees: {
    single: '已扣：買進與賣出手續費各 {fee}%（{tier}碳分級）、放大投資時的借款費每小時 {borrow}%（只對借來的部分）。',
    portfolio: '已扣：各資產依碳分級的買進與賣出手續費，以及放大投資時借來部分的每小時借款費。換倉日先全部賣出再重新買進。',
    leverageCapped: '{asset} 的碳分級放大上限是 {max}×，這組以 {max}× 計算。',
    portfolioLeverage: '每一檔的放大比例不超過該資產的碳分級上限。',
  },
  tiers: { low: '低', mid: '中', high: '高' },

  /** 結果區最上面的一句話結論。數字全部來自回測檔，「贏／輸」只比較累積報酬。 */
  summary: {
    title: '回測結果',
    sentence: '如果在 {from} 拿 {capital} USDC，用「{strategy}」操作 {target}，到 {to} 會變成',
    benchmark: '同期買入持有：{final} USDC（{pct}）',
    beat: '贏過買入持有 {pts} 個百分點',
    lose: '輸給買入持有 {pts} 個百分點',
    tie: '與買入持有相同',
    maxDrawdown: '最大回撤',
    riskScore: '風險分數',
    trades: '買賣次數',
    lossProb: '未來 {days} 天虧損機率',
  },
  tabs: {
    backtest: '回測：過去的淨值',
    forecast: '預測：未來 {days} 天',
  },
  details: {
    metrics: '完整指標（與買入持有比較）',
    trades: '每一筆買賣（{count} 筆）',
  },
  next: {
    title: '想照這個做法操作？',
    marketplace: '看策略分享者排行榜',
    share: '複製這組設定的連結',
    copied: '已複製連結，分享出去的人會看到同一組結果',
  },

  metrics: {
    title: '績效指標',
    strategy: '策略',
    benchmark: '買入持有',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    winRate: '勝率',
    trades: '買賣次數',
    riskScore: '風險分數',
    winRateNote: '勝率只算已賣出的投資',
  },

  chart: {
    title: '回測淨值與買賣點',
    strategy: '策略',
    benchmark: '買入持有',
    open: '買進',
    close: '賣出',
    liquidated: '自動結清',
    note: '買入持有是第一天不放大、把本金全部買進同一個標的（一籃資產時等權重），之後不動。',
  },

  trades: {
    title: '每一筆買賣',
    count: '共 {count} 筆',
    date: '日期',
    asset: '資產',
    action: '動作',
    side: '方向',
    long: '看漲',
    short: '看跌',
    price: '價格',
    margin: '投入金額',
    pnl: '淨損益',
    empty: '這組參數在回測期間沒有任何買賣。',
  },

  forecast: {
    title: '未來 {days} 天的淨值區間',
    p5: '悲觀（第 5 百分位）',
    p50: '中位數',
    p95: '樂觀（第 95 百分位）',
    outer: '第 5–95 百分位',
    inner: '第 25–75 百分位',
    lossProb: '期末虧損的機率',
    halfLossProb: '虧掉一半以上的機率',
    method:
      '預測方法：從 {from} 的收盤價起、以全新的本金 {capital} USDC 開始，把回測期間的歷史日報酬每 {block} 天一段隨機抽出、接成 {paths} 條 {days} 天的價格路徑（所有資產抽同一段日子），每一條都讓這個策略照同樣的規則跑一次。這是根據歷史波動的模擬，不是預測模型：它不預測漲跌方向，也不會出現歷史上沒有過的單日波動。',
  },

  similar: {
    title: '用相近做法的模擬策略分享者',
    body: '這些模擬策略分享者用同一條規則操作；到個人頁可以看完整績效。',
    view: '看個人頁',
  },

  noOrder: {
    title: '為什麼不能在這裡買賣',
    body: '這是分析工具，不會替你買賣。鏈上能由公開的自動化規則代為執行的，只有策略分享者已發布的持有組合。',
    /** 只在跟單旗標開啟時顯示。 */
    copy: '想照某位策略分享者的持有組合投資，可以到策略分享者排行榜跟著投資。',
    single: '逐筆策略（定期定額、馬丁加碼、網格）需要 AI 代理逐筆代為執行，本期不提供，也沒有對應的模擬策略分享者。',
  },
};
