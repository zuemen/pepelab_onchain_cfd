/**
 * Marketplace 頁：明星交易者排行榜。
 *
 * 「明星交易者」（isStarTrader）純粹是前端算出來的徽章（聲譽 > 80 且跟隨者 > 3），
 * 不對應任何合約層級的等級，跟 common.ts 的 `tier`（鑽石／黃金／白銀／青銅，那個
 * 才是合約事件裡真的用到的名字）不是同一類，沒有理由留英文。
 */
export const marketplace = {
  title: '⭐ 明星交易者排行榜',
  subtitle: '瀏覽並跟單鏈上驗證過的策略',

  esgFiltered: '已篩選',
  esgAll: '全部',
  esgButton: 'ESG {state}',

  sort: {
    reputation: '排序：聲譽',
    followers: '排序：跟隨者',
    volume: '排序：交易量（7 天）',
    pnl: '排序：PnL（7 天）',
    stake: '排序：質押',
    esg: '排序：ESG 評分',
  },

  refreshAria: '重新整理市集資料',

  search: {
    placeholder: '搜尋名稱或地址…',
    /** 這條鏈上有交易者,只是搜尋詞沒比對到——跟「這條鏈真的沒人」是不同的空狀態。 */
    noResults: '沒有符合「{query}」的交易者',
  },

  /** 表格欄位標頭。金額類欄位(量、PnL、質押)沿用 card.* 裡已經有的字串,單一來源不重複定義。 */
  table: {
    rank: '#',
    trader: '交易者',
    reputation: '聲譽',
    strategy: '策略',
    esg: 'ESG',
    actions: '操作',
  },

  loadFailed: '載入失敗：',

  empty: {
    title: '這條鏈上還沒有已發布策略的交易者',
    /** 排行榜是即時算的,不是「還沒有人」——講清楚資料怎麼來的,讓人自己判斷是連錯鏈還是真的沒人。 */
    description: '排行榜由鏈上事件即時計算,目前連線到 {chain},掃描了最近 {blocks} 個區塊。如果預期會看到交易者,先確認錢包連的是正確的鏈。',
    unknownChain: '未知網路（chainId {chainId}）',
    cta: '成為交易者',
    secondaryCta: '看 x402 文件',
  },

  card: {
    starTrader: '⭐ 明星交易者',
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
    starTraderOne: '{count} 位明星交易者',
    starTraderMany: '{count} 位明星交易者',
    volumeWindow: '交易量與 PnL 統計來自最近 ~{blocks} 個區塊（約 7 天）',
  },
};
