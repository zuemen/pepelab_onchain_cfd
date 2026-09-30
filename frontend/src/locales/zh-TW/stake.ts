/**
 * 交易者質押頁：聲譽質押（TraderStake.sol，質押 USDC 換發布資格，可能被罰沒）。
 */
export const stake = {
  viewOn: '在 {explorer} 查看 ↗',

  sections: {
    reputation: {
      title: '聲譽質押',
      subtitle: '質押 {token}，換取發布策略、參與跟單市場的資格——策略造成跟隨者虧損時可能被罰沒。',
    },
  },

  current: {
    title: '你的質押',
    refresh: '↺ 重新整理',
    staked: '已質押',
    totalSlashed: '累計罰沒',
    reputation: '聲譽分數',
    reputationValue: '{score} / 100',
    formula: '公式：質押量 × 100 ÷（質押量 + 累計罰沒 × 5）',
    eligible: '✓ 符合發布策略資格',
    notEligible: '✗ 需質押 100 {token}',
    minimum: '最低質押金額：{amount} {token} · 向跟隨者展現你的風險共擔',
  },

  add: {
    title: '質押 {token}',
    description:
      '質押會讓你的資金承擔風險——若你的策略造成跟單者虧損超過 30%，可能觸發罰沒。作為回報，你將獲得信譽（聲譽分數）並可發布策略。',
    placeholder: '100',
    staking: '質押中…',
    cta: '批准並質押',
    enterAmount: '請輸入有效金額',
    done: '質押成功 ✓',
  },

  unstake: {
    title: '解除質押（24 小時冷卻）',
    pending: '待處理解除質押：{amount} {token}',
    ready: '冷卻期已過——可以執行。',
    availableAt: '可執行時間：{when}',
    executing: '執行中…',
    execute: '執行解除質押',
    cancelling: '取消中…',
    cancel: '取消',
    description: '申請解除質押——資金將在 24 小時冷卻期後解鎖。',
    placeholder: '50',
    requesting: '申請中…',
    request: '申請解除質押',
    enterAmount: '請輸入解除質押金額',
    requested: '已申請解除質押 ✓——請等待 24 小時後執行',
    executed: '解除質押已執行 ✓',
    cancelled: '解除質押已取消 ✓',
  },

  info: {
    title: '交易者質押機制說明',
    publish: '質押 ≥ 100 {token} 即可在交易市集發布策略。',
    slashing:
      '若跟隨者因你的策略虧損超過 30%，該虧損金額的 50%（上限為你質押額的 50%）將被罰沒並發放給他們。',
    reputation: '聲譽 = 質押量 × 100 ÷（質押量 + 累計罰沒 × 5）——遭罰沒時會下降。',
    cooldown: '解除質押需要 24 小時冷卻期。',
    backToMarketplace: '← 返回交易市集',
    traderDashboard: '交易者主頁 →',
  },

  /**
   * 跟單旗標關閉時（商業版預設）的說法。信譽質押本身照常開放——它是配置市集發布
   * 策略的前提——只是不提跟單／跟隨者。罰沒在鏈上只由跟單流程觸發，這裡只陳述
   * TraderStake 合約本身的規則。
   */
  copyOff: {
    subtitle: '質押 {token}，換取在市集發布策略的資格並累積信譽；質押資金依鏈上罰沒規則承擔風險。',
    minimum: '最低質押金額：{amount} {token} · 向使用你策略的人展現風險共擔',
    addDescription:
      '質押會讓你的資金承擔風險——在 TraderStake 合約的罰沒規則觸發時可能被扣除。作為回報，你將獲得信譽（聲譽分數）並可發布策略。',
    slashing: '罰沒由 TraderStake 合約執行：單次最多扣除質押額的 50%，並發放給受損的一方。',
  },
};
