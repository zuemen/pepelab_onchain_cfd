/**
 * 交易者個人頁（/trader/:address）。
 */
export const traderProfile = {
  invalidAddress: '無效的地址。',
  connectWallet: '連接錢包以查看交易者個人頁。',
  breadcrumbMarketplace: '交易市集',

  header: {
    unknownName: '未知',
    repChip: '◆ {rep} 聲譽',
    /** 粗體數字由元件自己渲染，這裡只是後面接的單複數字尾。中文沒有單複數之分，兩個一樣。 */
    followerSingular: '位跟隨者',
    followerPlural: '位跟隨者',
    registered: '已註冊',
    staked: '◆ 已質押',
    notStaked: '✗ 未質押',
    noStrategy: '尚無可跟單的策略 🔒',
    copyThisTrader: '跟單此交易者 →',
  },

  stats: {
    staked: '質押金額',
    followers: '跟隨者',
    copiers: '跟單者',
    earnings: '收益',
    strategies: '策略數',
    versions: '版本',
  },

  strategy: {
    title: '最新策略',
    empty: '尚未發布策略。',
    /** 分配標籤：↑ sBTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  history: {
    titleOne: '策略歷史（{count} 個版本）',
    titleMany: '策略歷史（{count} 個版本）',
    /** 摘要行：sBTC L 3× · sETH S 2× */
    summaryEntry: '{asset} {side} {leverage}×',
    long: '多',
    short: '空',

    column: {
      asset: '標的',
      esg: 'ESG',
      side: '方向',
      leverage: '槓桿',
      weight: '權重',
    },
    longLabel: '做多 ↑',
    shortLabel: '做空 ↓',
  },

  followers: {
    titleFirst: '跟隨者（前 {count} 位）',
  },

  slashHistory: {
    titleOne: '罰沒紀錄（{count} 筆）',
    titleMany: '罰沒紀錄（{count} 筆）',
  },

  actions: {
    backToMarketplace: '← 返回交易市集',
    whaleTracker: '🐋 鯨魚追蹤',
  },
};
