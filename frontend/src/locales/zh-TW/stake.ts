/**
 * 交易者質押頁：質押、聲譽分數、解質押冷卻，以及 PEPE 收益農場。
 */
export const stake = {
  viewOn: '在 {explorer} 查看 ↗',

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

  /** PEPE 收益農場。整區是展示用的試算，不是鏈上真的獎勵池。 */
  farm: {
    title: 'PEPE 收益農場',
    chip: '鏈上聯動實時挖礦',
    subtitle: '依 {token} 聲譽質押試算 PEPE 產出（展示用，尚未接上鏈上獎勵池）',
    aprLabel: '穩健收益率',
    pending: '待收割 PEPE 收益 (Pending)',
    walletBalance: '錢包鏈上 PEPE 餘額 (Wallet)',
    accruedFrom: '依質押的 {amount} {token} 累計（展示用）',
    notStaked: '⚠️ 您目前尚未質押 {token}',
    harvest: '🌾 收割（展示用 · 尚未啟用）',
    harvestDisabledHint: '尚未接上獎勵來源合約（PepeStaking 未部署），此為展示用累計',
    addToWallet: '🦊 加 Metamask',
    addedToWallet: '已將 PEPE 代幣合約成功加入您的 Metamask！ 🦊🐸',
    addToWalletFailed: '新增代幣失敗，請手動複製合約地址。',
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

  /** #36：兩段免責說明各自在句中夾了 `<b>`，拆成前後片段。 */
  markup: {
    disclaimerBefore: '⚠ 此數字為前端依質押量與時間試算的',
    disclaimerBold: '展示值',
    disclaimerAfter: '，鏈上沒有對應的獎勵池， 目前無法領取。（PepeStaking 尚未在本網路部署。）',

    footnoteBefore: '* 質押的 ',
    footnoteMid1: ' 是給跟單者的聲譽保障金，本身不生息。上方的 PEPE 產出 （每質押 1 ',
    footnoteMid2: ' 每日 0.02 PEPE）目前是',
    footnoteBold: '前端試算的展示值',
    footnoteAfter: '：鏈上沒有 對應的獎勵池，也沒有任何合約會把它發給你，因此收割按鈕停用。',
  },
};
