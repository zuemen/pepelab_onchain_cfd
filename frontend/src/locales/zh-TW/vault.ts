/**
 * LP Vault（保險金庫）。
 */
export const vault = {
  connectWallet: '連接錢包以使用風險準備金。',
  viewOnEtherscan: '在 Etherscan 查看 ↗',

  /** #151：對齊 /tokens 的 Simple/Expert Mode 標題模式——Expert 講機制
   *  （保險），Simple 拿掉那個字。 */
  title: '風險準備金',
  titleSimple: '風險準備金',
  subtitle: '存入 USDC 分得平台手續費。風險準備金要吸收投資人的極端虧損，份額價值可能下跌。',

  /** #151：Simple Mode 版的做市收益提示——不講 bps、不講機制，只講結果。
   *  Expert 版仍用下面 markup.mmActiveLabel 那三句。 */
  simpleYieldActive: '風險準備金目前正在分得手續費收益。',

  stat: {
    totalAssets: '總資產',
    sharePrice: '份額價格',
    totalSupply: '總供給量',
    myValue: '我的 pIV 價值',
  },

  position: {
    title: '你的存款',
    shares: '持有 pIV',
    value: 'USDC 價值',
  },

  deposit: {
    title: '存入 USDC',
    description: '依目前資金規模按比例取得 pIV 份額，分得平台手續費收益。',
    placeholder: 'USDC 金額',
    cta: '存入',
    estimate: '≈ {shares} pIV',
    done: '已存入 {amount} USDC ✓',
  },

  withdraw: {
    title: '提領份額',
    description: '銷毀 pIV 份額，按比例從資金池取回 USDC。',
    placeholder: 'pIV 份額',
    cta: '提領',
    estimate: '≈ {amount} USDC',
    max: '最大值（{shares} pIV）',
    done: '已提領 {amount} pIV 份額 ✓',
  },

  /** 活動列表。每一種事件的名稱。 */
  activity: {
    title: '近期活動',
    emptyTitle: '尚無活動',
    emptyDescription: '存入 USDC 即可開始分得平台手續費收益；風險準備金要吸收極端虧損，份額價值可能下跌。',
    readFailedTitle: '讀取失敗',
    readFailedDescription: '風險準備金的鏈上事件讀取失敗，這裡的空白不代表沒有活動。請稍後重新整理。',
    partial: '部分區塊範圍讀取失敗，下方活動可能不完整。',
    deposited: '存入',
    withdrawn: '提領',
    protocolDeposit: '平台手續費',
    bailout: '已支付補貼',
    block: '#{block}',
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** #36：三句句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    mmActiveLabel: '手續費分配已啟動：',
    mmPctRouted: '每筆投資手續費中的 {pct}% 分配給存入者——',
    mmAmount: '{amount} USDC',
    mmRoutedToDate: '累計已分配。',

    howItWorksLabel: '運作方式：',
    howItWorksBody:
      ' 存入 USDC 的人會拿到 pIV 份額。風險準備金透過手續費分配程式（FeeRouter）取得所有跟著投資與績效手續費的 10%。投資被自動結清時，風險準備金只收取',
    /** 跟單旗標關閉時的說法：收入來源講 FeeRouter 的費用，不點名跟單。 */
    howItWorksBodyNoCopy:
      ' 存入 USDC 的人會拿到 pIV 份額。風險準備金透過手續費分配程式（FeeRouter）取得平台手續費與績效手續費的 10%。投資被自動結清時，風險準備金只收取',
    liquidationPenaltyLabel: '自動結清罰金',
    howItWorksCodeWrap: '（',
    howItWorksTail:
      '），加上執行結清者的獎勵——投資人會拿回扣除虧損、手續費與罰金後剩餘的投入金額，因此自動結清不是全部沒收。',

    badDebtBefore:
      '當投資人的虧損超過投入金額（極端情況）時，風險準備金會直接付給該投資人 10% 的補貼底線。若虧損超出風險準備金可承擔的範圍，短缺部分會以 ',
    badDebtMid: ' 事件記錄在鏈上，需透過 ',
    badDebtAfter: ' 補足資金。存入者承擔這個風險以換取收益。',
  },
};
