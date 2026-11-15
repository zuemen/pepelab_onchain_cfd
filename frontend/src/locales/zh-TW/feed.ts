/**
 * 鏈上動態牆（issue #335）。只在 專家模式出現，可以用交易桌的詞（開倉、平倉、清算、罰沒、跟單）。
 * 每一則的句子由 src/lib/pepefi/feed.ts 算出的參數填入，不是 AI 生成。
 */
export const feed = {
  title: '動態',
  subtitle: '平台上正在發生的事：每一則都來自鏈上紀錄，可以點紀錄回鏈上核對。',
  scanWindow: '掃描範圍：區塊 {from} 至 {to}（約 {span}）',
  scanWindowAll: '掃描範圍：區塊 {from} 至 {to}（本機鏈，從頭掃）',
  incomplete: '有部分區塊讀不到，動態不完整：沒列出來的不代表沒有發生。',
  loading: '讀取鏈上事件中…',
  empty: '這段期間沒有符合條件的動態。',
  refresh: '重新整理',
  loadMore: '顯示更多',
  pnlNote: '價差損益是事件裡記錄的價格變動損益，還沒扣手續費、借款費與資金費率；所以被自動結清的投資也可能是正的。',

  expertOnly: {
    title: '這一頁只在 專家模式提供',
    body: '動態牆列出策略分享者與投資人的鏈上事件，切換到 專家模式就能看。',
    action: '切換到 專家模式',
  },

  filter: {
    types: '類型',
    trader: '策略分享者',
    allTraders: '全部',
  },

  types: {
    strategy: '調整策略',
    bigOpen: '大額投資',
    bigClose: '大額結束投資',
    liquidation: '自動結清',
    follow: '開始跟著投資',
    unfollow: '停止跟隨',
    slash: '扣罰',
    retirement: '碳權退役',
    resync: '自動同步',
    autoSync: '同步設定',
  },

  sentence: {
    strategyFirst: '發布了第一版策略：{legs}',
    strategyChanged: '調整了策略（第 {version} 版）：{changes}',
    strategyUnknown: '發布了第 {version} 版策略',
    strategySame: '重新發布了第 {version} 版策略，持有內容不變',
    added: '新增 {asset} {side} {weight}%',
    removed: '移除 {asset}',
    reweighted: '{asset} {from}% → {to}%',
    flipped: '{asset} 改為{side}',
    leg: '{asset} {side} {weight}%',
    bigOpen: '新增一筆 {asset} 投資（{side}），總額 {notional}',
    bigClose: '結束一筆 {asset} 投資（{side}，總額 {notional}），價差損益 {pnl}',
    liquidation: '{asset}（{side}，總額 {notional}）的投資被自動結清，價差損益 {pnl}',
    liquidationUnknown: '一筆投資被自動結清，價差損益 {pnl}',
    follow: '今天有 {count} 人開始跟著投資，共 {margin}',
    followOn: '{day} 有 {count} 人開始跟著投資，共 {margin}',
    unfollow: '今天有 {count} 人停止跟隨',
    unfollowOn: '{day} 有 {count} 人停止跟隨',
    slash: '履約押金被扣罰 {amount}',
    retirement: '退役了 {tonnes} 噸平台自鑄碳權（花費 {amount}），來自平台手續費的碳權份額',
    long: '看漲',
    short: '看跌',
    separator: '；',
    /** ADR-024：同一位交易者、同一版的同步合成一則；不列出跟隨者與執行者的位址。 */
    resync: '{count} 筆跟著投資的持有已同步到第 {version} 版',
    autoSyncOn: '{when}有 {count} 位跟隨者開啟自動同步',
    autoSyncOff: '{when}有 {count} 位跟隨者關閉自動同步',
    today: '今天',
    onDay: '{day} ',
  },

  item: {
    simulated: '模擬',
    platform: '平台',
    profile: '個人頁',
    copy: '跟著投資',
    tx: '鏈上紀錄',
  },

  profile: {
    title: '最近動態',
    viewAll: '看全部動態',
    empty: '這段期間這位策略分享者沒有動態。',
  },

  sides: {
    title: '市場看漲／看跌比例',
    subtitle: '策略中每一檔目前全站看漲與看跌的投資比例（直接讀鏈上程式）。',
    long: '看漲 {pct}%',
    short: '看跌 {pct}%',
    with: '與市場看法相同',
    against: '與市場看法相反',
    even: '看漲看跌相當',
    none: '目前沒有投資',
    missing: '有 {count} 個市場讀不到',
    yourSide: '策略：{side}',
  },
};
