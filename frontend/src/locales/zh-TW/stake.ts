/**
 * 交易者質押頁：聲譽質押（TraderStake.sol，質押 USDC 換發布資格，可能被罰沒）。
 */
export const stake = {
  viewOn: '在 {explorer} 查看 ↗',

  sections: {
    reputation: {
      title: '履約押金',
      subtitle: '存入 {token} 當履約押金，換取發布策略、讓人跟著投資的資格——策略造成跟隨者虧損時，押金可能被扣罰。',
    },
  },

  current: {
    title: '你的履約押金',
    refresh: '↺ 重新整理',
    staked: '已存押金',
    totalSlashed: '累計扣罰',
    reputation: '聲譽分數',
    reputationValue: '{score} / 100',
    formula: '公式：押金 × 100 ÷（押金 + 累計扣罰 × 5）',
    eligible: '✓ 符合發布策略資格',
    notEligible: '✗ 需存入 100 {token} 押金',
    notEligibleUnstaking: '✗ 取回押金申請中，暫時不能發布；取消申請可恢復資格',
    minimum: '最低押金：{amount} {token} · 向跟隨者展現你和他們一起承擔風險',
  },

  add: {
    title: '存入 {token} 押金',
    description:
      '押金會承擔風險——若你的策略造成跟隨者虧損超過 30%，押金可能被扣罰。作為回報，你將獲得聲譽（聲譽分數）並可發布策略。',
    placeholder: '100',
    staking: '存入中…',
    cta: '批准並存入押金',
    enterAmount: '請輸入有效金額',
    belowMinimum: '存入後押金總額至少要 {amount} {token}，請提高金額',
    done: '押金存入成功 ✓',
  },

  unstake: {
    title: '取回押金（24 小時等待期）',
    pending: '待取回押金：{amount} {token}',
    ready: '等待期已過——可以執行。',
    availableAt: '可執行時間：{when}',
    executing: '執行中…',
    execute: '執行取回押金',
    cancelling: '取消中…',
    cancel: '取消',
    description: '申請取回押金——資金將在 24 小時等待期後解鎖。',
    placeholder: '50',
    requesting: '申請中…',
    request: '申請取回押金',
    enterAmount: '請輸入要取回的押金金額',
    requested: '已申請取回押金 ✓——請等待 24 小時後執行',
    executed: '押金已取回 ✓',
    cancelled: '取回押金已取消 ✓',
  },

  info: {
    title: '策略分享者履約押金說明',
    publish: '押金 ≥ 100 {token} 即可在策略市集發布策略。',
    slashing:
      '跟隨者停止跟隨時，若這筆跟著投資因價格變動虧損達 30%（不含各項費用），該虧損金額的 50%（上限為你押金的 50%）會被扣罰。扣罰的錢存入平台準備金，不會發給跟隨者。',
    reputation: '聲譽 = 押金 × 100 ÷（押金 + 累計扣罰 × 5）——被扣罰時會下降。',
    cooldown: '取回押金需要 24 小時等待期。',
    backToMarketplace: '← 返回策略市集',
    traderDashboard: '策略分享者主頁 →',
  },

  /**
   * 跟單旗標關閉時（商業版預設）的說法。聲譽質押本身照常開放——它是配置市集發布
   * 策略的前提——只是不提跟單／跟隨者。罰沒在鏈上只由跟單流程觸發，這裡只陳述
   * TraderStake 合約本身的規則。
   */
  copyOff: {
    subtitle: '存入 {token} 當履約押金，換取在市集發布策略的資格並累積聲譽；押金依公開的鏈上扣罰規則承擔風險。',
    minimum: '最低押金：{amount} {token} · 向使用你策略的人展現你一起承擔風險',
    addDescription:
      '押金會承擔風險——公開的鏈上扣罰規則觸發時可能被扣除。作為回報，你將獲得聲譽（聲譽分數）並可發布策略。',
    slashing: '扣罰由公開的鏈上程式自動執行：單次最多扣除押金的 50%，扣罰的錢存入平台準備金，不會直接發給任何使用者。',
  },
};
