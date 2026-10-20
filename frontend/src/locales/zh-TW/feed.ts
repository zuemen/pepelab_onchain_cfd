/**
 * 鏈上動態牆（issue #335）。只在 Expert 模式出現，可以用交易桌的詞（開倉、平倉、清算、罰沒、跟單）。
 * 每一則的句子由 src/lib/pepefi/feed.ts 算出的參數填入，不是 AI 生成。
 */
export const feed = {
  title: '動態',
  subtitle: '平台上正在發生的事：每一則都來自鏈上交易，可以點交易回鏈上核對。',
  scanWindow: '掃描範圍：區塊 {from} 至 {to}（約 {span}）',
  scanWindowAll: '掃描範圍：區塊 {from} 至 {to}（本機鏈，從頭掃）',
  incomplete: '有部分區塊讀不到，動態不完整：沒列出來的不代表沒有發生。',
  loading: '讀取鏈上事件中…',
  empty: '這段期間沒有符合條件的動態。',
  refresh: '重新整理',
  loadMore: '顯示更多',
  pnlNote: '價差損益是事件裡記錄的價格變動損益，還沒扣手續費、借款費與資金費率；所以被清算的部位也可能是正的。',

  expertOnly: {
    title: '這一頁只在 Expert 模式提供',
    body: '動態牆列出交易桌的鏈上事件，切換到 Expert 模式就能看。',
    action: '切換到 Expert 模式',
  },

  filter: {
    types: '類型',
    trader: '交易者',
    allTraders: '全部',
  },

  types: {
    strategy: '調整策略',
    bigOpen: '大額開倉',
    bigClose: '大額平倉',
    liquidation: '清算',
    follow: '跟單',
    unfollow: '取消跟單',
    slash: '罰沒',
    retirement: '碳權退役',
  },

  sentence: {
    strategyFirst: '發布了第一版策略：{legs}',
    strategyChanged: '調整了策略（第 {version} 版）：{changes}',
    strategyUnknown: '發布了第 {version} 版策略',
    strategySame: '重新發布了第 {version} 版策略，持倉不變',
    added: '新增 {asset} {side} {weight}%',
    removed: '移除 {asset}',
    reweighted: '{asset} {from}% → {to}%',
    flipped: '{asset} 改為{side}',
    leg: '{asset} {side} {weight}%',
    bigOpen: '開了 {asset} {side} {leverage}× 部位，名目 {notional}',
    bigClose: '平掉 {asset} {side} 部位（名目 {notional}），價差損益 {pnl}',
    liquidation: '{asset} {side} 部位（名目 {notional}）被清算，價差損益 {pnl}',
    liquidationUnknown: '一個部位被清算，價差損益 {pnl}',
    follow: '今天有 {count} 人開始跟單，共 {margin}',
    followOn: '{day} 有 {count} 人開始跟單，共 {margin}',
    unfollow: '今天有 {count} 人取消跟單',
    unfollowOn: '{day} 有 {count} 人取消跟單',
    slash: '質押被罰沒 {amount}',
    retirement: '退役了 {tonnes} 噸模擬碳權（花費 {amount}），來自平台手續費的碳權份額',
    long: '做多',
    short: '做空',
    separator: '；',
  },

  item: {
    simulated: '模擬',
    platform: '平台',
    profile: '個人頁',
    copy: '跟單',
    tx: '交易',
  },

  profile: {
    title: '最近動態',
    viewAll: '看全部動態',
    empty: '這段期間這位交易者沒有動態。',
  },

  sides: {
    title: '市場多空比例',
    subtitle: '策略中每一檔目前全站的多空未平倉比例（直接讀交易所合約）。',
    long: '多 {pct}%',
    short: '空 {pct}%',
    with: '與市場同邊',
    against: '與市場反邊',
    even: '多空相當',
    none: '目前沒有未平倉',
    missing: '有 {count} 個市場讀不到',
    yourSide: '策略：{side}',
  },
};
