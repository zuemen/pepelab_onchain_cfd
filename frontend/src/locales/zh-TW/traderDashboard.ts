/**
 * Trader Dashboard（/trader）：自己的交易者主頁——註冊、發布策略、收益、策略歷史。
 */
export const traderDashboard = {
  connectWallet: '連接錢包以使用交易者主頁。',
  viewOn: '在 {explorer} 查看 ↗',

  profile: {
    repChip: '◆ {rep} 聲譽',
    staked: '已質押 {amount} USDC',
  },

  register: {
    title: '註冊為交易者',
    registeredChip: '✓ {name}',
    registeredNote: '已註冊為公開交易者',
    placeholder: '顯示名稱（例如：AlphaTrader）',
    registering: '…',
    cta: '註冊',
    done: '已註冊為交易者 ✓',
  },

  publish: {
    title: '發布策略',
    addAsset: '+ 新增標的',

    stakeRequiredTitle: '發布策略需先質押',
    stakeRequiredBody: '發布策略前需先質押至少 100 USDC。這能讓跟隨者相信你也承擔風險。',
    /** 跟單旗標關閉時（交易員質押未開放）。 */
    stakeUnavailable: '這個部署未開放交易員信譽質押，因此暫時無法發布策略。如需開通，請聯繫平台營運方。',
    goToStake: '前往交易者質押 →',

    empty: '點擊「+ 新增標的」以建立策略。',

    column: {
      asset: '標的',
      direction: '方向',
      leverage: '槓桿',
      weight: '權重 %',
    },
    long: '做多 ↑',
    short: '做空 ↓',

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

    registerFirst: '請先註冊為交易者才能發布。',

    /** #36：夾了連到 /stake 的 `<Link>`，拆成前後片段。 */
    stakeToUnlockBefore: '要解鎖發布功能，請在',
    stakeToUnlockLink: '質押頁面',
    stakeToUnlockAfter: '質押 ≥ 100 USDC。',
  },

  earnings: {
    title: '手續費收益',
    refresh: '↺ 重新整理',
    claimable: '可領取（跟單費 + 績效費）',
    claiming: '領取中…',
    claimAll: '全部領取',
    note: '當跟隨者支付 0.3% 跟單費，或平倉獲利的跟單部位產生 10% 績效費時，即會累積收益。你可分得每筆費用的 70%。',
    /** 跟單旗標關閉時的中性說法——既有收益仍可領取。 */
    claimableNeutral: '可領取的交易員收益',
    noteNeutral: '交易員收益由 FeeRouter 依鏈上規則累積，你可分得每筆費用的 70%。',
    claimed: '收益已領取 ✓',
  },

  history: {
    title: '策略歷史',
    refresh: '↺ 重新整理',
    empty: '尚未發布任何策略。',
    /** 摘要行：sBTC L 3×  ·  sETH S 2× */
    summaryEntry: '{asset} {side} {leverage}×',
    long: '多',
    short: '空',

    column: {
      asset: '標的',
      side: '方向',
      leverage: '槓桿',
      weight: '權重',
    },
    longLabel: '做多 ↑',
    shortLabel: '做空 ↓',
  },
};
