/**
 * Marketplace 頁：Star Trader 排行榜。
 */
export const marketplace = {
  title: '⭐ Star Trader 排行榜',
  subtitle: '瀏覽並跟單鏈上驗證過的策略',

  esgFiltered: '已篩選',
  esgAll: '全部',
  esgButton: 'ESG {state}',

  sort: {
    reputation: '排序：聲譽',
    followers: '排序：跟隨者',
    volume: '排序：交易量（7 天）',
    pnl: '排序：PnL（7 天）',
    esg: '排序：ESG 評分',
  },

  refreshAria: '重新整理市集資料',

  livePrices: '即時價格',
  loadFailed: '載入失敗：',

  empty: {
    title: '尚無交易者',
    description: '執行 SeedWhales 來產生排行榜資料，或到交易者頁面註冊策略。',
    cta: '成為交易者',
  },

  card: {
    starTrader: '⭐ Star Trader',
    verifiedOnChain: '鏈上已驗證',
    noName: '—',
    noStrategy: '尚無策略',
    /** 策略籌碼：↑sBTC 50% 3× */
    allocChip: '{side}{asset} {weight}% {leverage}×',

    volLabel: '7 日量',
    pnlLabel: '7 日 PnL',
    followersLabel: '跟隨者',
    stakeLabel: '質押',

    slashed: '⚠ 已罰沒 {amount} USDC',

    profile: '個人首頁',
    copy: '跟單 →',
    noStrategyButton: '尚無策略',
  },

  /** 頁尾統計。單複數各自是完整的一句話，不是拼接出來的。 */
  footer: {
    countOne: '{count} 位交易者',
    countMany: '{count} 位交易者',
    followersTotal: '共 {count} 位跟隨者',
    starTraderOne: '{count} 位 Star Trader',
    starTraderMany: '{count} 位 Star Trader',
    volumeWindow: '交易量與 PnL 統計來自最近 ~{blocks} 個區塊（約 7 天）',
  },

  rawData: {
    summary: '原始策略資料',
    noStrategy: '尚無策略',
  },
};
