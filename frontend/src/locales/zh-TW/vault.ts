/**
 * LP Vault（保險金庫）。
 */
export const vault = {
  connectWallet: '連接錢包以使用 LP 保險金庫。',
  viewOnEtherscan: '在 Etherscan 查看 ↗',

  stat: {
    totalAssets: '總資產',
    sharePrice: '份額價格',
    totalSupply: '總供給量',
    myValue: '我的 pIV 價值',
  },

  position: {
    title: '你的部位',
    shares: '持有 pIV',
    value: 'mUSDC 價值',
  },

  deposit: {
    title: '存入 mUSDC',
    description: '依目前資金池規模按比例獲得 pIV 份額，賺取協議手續費收益。',
    placeholder: 'mUSDC 金額',
    cta: '存入',
    estimate: '≈ {shares} pIV',
    done: '已存入 {amount} mUSDC ✓',
  },

  withdraw: {
    title: '提領份額',
    description: '銷毀 pIV 份額，按比例從資金池取回 mUSDC。',
    placeholder: 'pIV 份額',
    cta: '提領',
    estimate: '≈ {amount} mUSDC',
    max: '最大值（{shares} pIV）',
    done: '已提領 {amount} pIV 份額 ✓',
  },

  /** 活動列表。每一種事件的名稱。 */
  activity: {
    title: '近期活動',
    emptyTitle: '尚無活動',
    emptyDescription: '存入 mUSDC 即可開始賺取協議手續費收益。',
    deposited: 'LP 存入',
    withdrawn: 'LP 提領',
    protocolDeposit: '協議手續費',
    bailout: '已支付紓困金',
    block: '#{block}',
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** #36：三句句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    mmActiveLabel: '做市收益已啟動：',
    mmPctRouted: '每筆交易手續費中的 {pct}% 分配給 LP——',
    mmAmount: '{amount} mUSDC',
    mmRoutedToDate: '累計已分配。',

    howItWorksLabel: '運作方式：',
    howItWorksBody:
      ' LP 存入 mUSDC 並獲得 pIV 份額。金庫透過 FeeRouter 賺取所有跟單與績效手續費的 10%。清算時金庫僅收取',
    liquidationPenaltyLabel: '清算罰金',
    howItWorksCodeWrap: '（',
    howItWorksTail:
      '），加上清算人的獎勵——部位持有者會拿回扣除虧損、手續費與罰金後剩餘的保證金，因此清算不再是 100% 沒收。',

    badDebtBefore:
      '當交易者的虧損超過其保證金（極端事件）時，金庫會直接支付 10% 紓困底線給該交易者。若虧損超出金庫可承擔的範圍，短缺部分會以 ',
    badDebtMid: ' 事件形式發出，金庫需透過 ',
    badDebtAfter: ' 補足資金。LP 承擔此風險以換取收益。',
  },
};
