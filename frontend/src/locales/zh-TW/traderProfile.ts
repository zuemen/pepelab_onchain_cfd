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

  /**
   * TraderActivity：目前未平倉部位表 + 動態時間軸，兩張卡都在這裡。
   *
   * side 徽章仍是 `sideLabel()` 回傳的裸英文 LONG/SHORT——那是 `lib/pepefi/whale.ts`
   * 的已知缺口（見該檔 catalog 註解），WhaleFeed / LargestOpenPositions 兩個已搬過的
   * 手足元件也是同樣處理方式，這裡跟著一致，不單獨修。
   *
   * markUnreadTitle / pnlUnreadTitle / missingOne / missingMany / estimatedTime /
   * txAria 直接複用 `whale.largest` 與 `whale.feed` 裡已經存在、逐字相同的句子，
   * 不在這裡另造一份。
   */
  activity: {
    openPositions: {
      title: '目前未平倉部位',
      subtitle: '即時讀取交易所資料 · 亦包含早於掃描視窗的部位',
      empty: '無未平倉部位。',
      columnSimple: { market: '市場', side: '方向', notional: '名義價值', pnl: 'PnL' },
      columnExpert: {
        market: '市場',
        side: '方向',
        entry: '進場價',
        mark: '標記價',
        margin: '保證金',
        notional: '名義價值',
        pnl: 'PnL',
      },
    },

    timeline: {
      title: '動態時間軸',
      scanning: '掃描中 {done}/{total}',
      noRange: '—',
      emptyTitle: '尚無動態',
      emptyRange: '區塊 {range} 內無事件。',
      emptyNone: '目前沒有內容可顯示。',
      column: { when: '時間', event: '事件', detail: '詳情', tx: '交易' },

      kind: {
        opened: '開倉',
        closed: '平倉',
        liquidated: '已清算',
        following: '跟單中',
        followedBy: '被跟單',
        staked: '已質押',
        slashed: '已罰沒',
      },

      /** 每種事件在「詳情」欄的句子。side 徽章與地址是獨立 JSX，前後才是這裡的字串。 */
      detail: {
        openedTail: '{asset} {leverage}× @ {price} · 保證金 {margin}',
        closedTail: ' · 已收回 {received}',
        liquidatedBefore: '已清算 · 損益 ',
        liquidatedBy: ' · 執行者 ',
        followingBefore: '開始跟單 ',
        followingAfter: ' · 保證金 {margin}',
        followedByAfter: ' 開始跟單此交易者 · 保證金 {margin}',
        stakedBefore: '已質押 ',
        slashedBefore: '已罰沒 ',
      },
    },
  },
};
