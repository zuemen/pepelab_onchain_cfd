/**
 * Trader Dashboard（/trader）：自己的交易者主頁——註冊、發布策略、收益、策略歷史。
 */
export const traderDashboard = {
  connectWallet: '連接錢包以使用策略分享者主頁。',
  viewOn: '在 {explorer} 查看 ↗',

  profile: {
    repChip: '◆ {rep} 聲譽',
    staked: '履約押金 {amount} USDC',
  },

  register: {
    title: '註冊為策略分享者',
    registeredChip: '✓ {name}',
    registeredNote: '已註冊為公開的策略分享者',
    placeholder: '顯示名稱（例如：穩健小資族）',
    registering: '…',
    cta: '註冊',
    done: '已註冊為策略分享者 ✓',
  },

  publish: {
    title: '發布策略',
    addAsset: '+ 新增標的',

    stakeRequiredTitle: '發布策略需先繳履約押金',
    stakeRequiredBody: '發布策略前需先繳至少 100 USDC 的履約押金，讓跟隨者知道你也承擔風險；申請取回履約押金期間也不能發布。',
    /** 跟單旗標關閉時的說法：不提跟隨者。 */
    stakeRequiredBodyNeutral: '發布策略前需先繳至少 100 USDC 的履約押金，讓使用你策略的人知道你也承擔風險。',
    goToStake: '前往繳履約押金 →',

    empty: '點擊「+ 新增標的」以建立策略。',

    column: {
      asset: '標的',
      direction: '方向',
      leverage: '倍率',
      weight: '權重 %',
    },
    long: '看漲 ↑',
    short: '看跌 ↓',

    duplicateWarning: '每個策略中，同一標的只能出現一次，請移除重複項目。',
    exceeds: '超過',
    mustReach: '需達到',
    weightTarget: '{state} 100%',
    autoFix: '自動修正為 100%',

    /** 對齊 StrategyRegistry 的 revert（見 lib/pepefi/strategyValidation.ts）。 */
    issue: {
      tooFew: '策略至少要有 {min} 檔標的（目前 {got} 檔）。',
      exceedsMax: '第 {row} 列權重 {pct}% 超過單一標的上限 50%。',
      zeroWeight: '第 {row} 列權重不能為 0。',
      roundingAdjusted: '已將四捨五入差額 {bps} bps 補到權重最大的標的，總和為 100.00%。',
    },

    publishing: '發布中…',
    cta: '發布策略',
    done: '策略已發布 ✓',

    registerFirst: '請先註冊為策略分享者才能發布。',

    /** #36：夾了連到 /stake 的 `<Link>`，拆成前後片段。 */
    stakeToUnlockBefore: '要解鎖發布功能，請在',
    stakeToUnlockLink: '履約押金頁面',
    stakeToUnlockAfter: '繳交 ≥ 100 USDC 的履約押金。',
  },

  earnings: {
    title: '手續費收益',
    refresh: '↺ 重新整理',
    claimable: '可領取（跟隨費 + 績效費）',
    claiming: '領取中…',
    claimAll: '全部領取',
    note: '當跟隨者支付 0.3% 跟隨費，或跟著你投資的部分賣出獲利、產生 10% 績效費時，即會累積收益。你可分得每筆費用的 70%。',
    /** 跟單旗標關閉時的中性說法——既有收益仍可領取。 */
    claimableNeutral: '可領取的策略分享者收益',
    noteNeutral: '策略分享者收益依公開的鏈上規則累積，你可分得每筆費用的 70%。',
    claimed: '收益已領取 ✓',
  },

  history: {
    title: '策略歷史',
    refresh: '↺ 重新整理',
    empty: '尚未發布任何策略。',
    /** 摘要行：BTC L 3×  ·  ETH S 2× */
    summaryEntry: '{asset} {side}',
    long: '漲',
    short: '跌',

    column: {
      asset: '標的',
      side: '方向',
      leverage: '倍率',
      weight: '權重',
    },
    longLabel: '看漲 ↑',
    shortLabel: '看跌 ↓',
  },
};
