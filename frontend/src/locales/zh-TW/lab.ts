/**
 * 策略實驗室（issue #332）。只在 Expert 模式出現，所以可以用交易桌的詞（開倉、平倉、槓桿、清算）。
 * 揭露（disclosure 與 forecast.method）固定顯示、不可收合；改寫時不能拿掉「不代表未來績效」與
 * 「根據歷史波動的模擬，不是預測模型」這兩個事實。
 */
export const lab = {
  title: '策略實驗室',
  subtitle: '選一種策略、一組參數與標的，看它在真實歷史價格上會怎樣，以及未來 90 天可能的範圍。',
  disclosure:
    '回測與預測不代表未來績效。回測用真實歷史日收盤價，在收盤價成交，並扣掉與本平台相同的費用：開倉與平倉手續費依碳分級計算，槓桿借來的部分每小時收借款費，部位跌破維持保證金會被清算；不模擬資金費率與滑價。預測是根據歷史波動的模擬，不是預測模型。',
  range: '回測期間 {from} 至 {to}・本金 {capital} USDC',

  loading: '載入中…',
  indexMissing: '讀不到策略實驗室的資料。',
  resultMissing: '讀不到這組結果，數字以「—」顯示。',

  expertOnly: {
    title: '這一頁只在 Expert 模式提供',
    body: '策略實驗室用交易桌的指標比較不同的操作方法，切換到 Expert 模式就能使用。',
    action: '切換到 Expert 模式',
  },

  picker: {
    strategy: '策略',
    params: '參數',
    asset: '資產',
    basket: '一籃資產',
    single: '逐筆（單一資產）',
    portfolio: '持倉組合（一籃資產）',
  },

  strategies: {
    dca: { name: '定期定額', description: '每隔固定天數買一次，本金平均分給整段期間的每一次。' },
    martingale: {
      name: '馬丁加倉',
      description: '每一輪先買本金的 {base}%；每比上一筆再跌一段就加倉，金額是上一筆的幾倍；整輪賺到停利就全部平倉、重新開始。',
    },
    grid: { name: '網格', description: '從起始價往下每隔一段設一格，跌到某一格就買、漲回上一格就賣；一格同時只持有一筆。' },
    momentum: { name: '動量', description: '定期換成過去一段時間漲最多的 3 檔，等權重做多。' },
    mean_reversion: { name: '均值回歸', description: '定期換成過去一段時間跌最多的 3 檔，賭它們會漲回來。' },
    trend: { name: '均線趨勢', description: '每一檔都持有：價格在均線之上做多、之下做空。' },
  },

  params: {
    every_days: '頻率',
    leverage: '槓桿',
    multiplier: '加倉倍數',
    drop_pct: '加倉間距（下跌）',
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
    single: '已扣：開倉與平倉手續費各 {fee}%（{tier}碳分級）、槓桿借款費每小時 {borrow}%（只對借來的部分）。',
    portfolio: '已扣：各資產依碳分級的開倉與平倉手續費，以及槓桿借來部分的每小時借款費。換倉日先全部平倉再開新部位。',
    leverageCapped: '{asset} 的碳分級槓桿上限是 {max}×，這組以 {max}× 計算。',
    portfolioLeverage: '每一檔的槓桿不超過該資產的碳分級上限。',
  },
  tiers: { low: '低', mid: '中', high: '高' },

  metrics: {
    title: '績效指標',
    strategy: '策略',
    benchmark: '買入持有',
    totalReturn: '累積報酬',
    maxDrawdown: '最大回撤',
    sharpe: 'Sharpe',
    winRate: '勝率',
    trades: '交易次數',
    riskScore: '風險分數',
    winRateNote: '勝率只算已平倉的部位',
  },

  chart: {
    title: '回測淨值與買賣點',
    strategy: '策略',
    benchmark: '買入持有',
    open: '開倉',
    close: '平倉',
    liquidated: '清算',
    note: '買入持有是第一天以 1 倍把本金全部買進同一個標的（一籃資產時等權重），之後不動。',
  },

  trades: {
    title: '每一筆交易',
    count: '共 {count} 筆',
    date: '日期',
    asset: '資產',
    action: '動作',
    side: '方向',
    long: '多',
    short: '空',
    price: '價格',
    margin: '保證金',
    pnl: '淨損益',
    empty: '這組參數在回測期間沒有任何交易。',
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
    title: '用相近做法的模擬交易者',
    body: '這些模擬交易者用同一條規則操作；到個人頁可以看完整績效。',
    view: '看個人頁',
  },

  noOrder: {
    title: '為什麼不能在這裡下單',
    body: '這是分析工具，不會替你交易。鏈上能由合約代為執行的，只有交易者已發布的持倉組合。',
    /** 只在跟單旗標開啟時顯示。 */
    copy: '想照某位交易者的持倉組合操作，可以到交易者排行榜跟單。',
    single: '逐筆策略（定期定額、馬丁加倉、網格）需要 agent 逐筆代為執行，本期不提供，也沒有對應的模擬交易者。',
  },
};
