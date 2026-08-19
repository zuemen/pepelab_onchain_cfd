/**
 * 跟單頁（/copy/:traderAddress）。
 */
export const copy = {
  invalidAddress: '無效的交易者地址。',
  connectWallet: '連接錢包以跟單交易者。',
  viewOn: '在 {explorer} 查看 ↗',
  loadFailed: '載入交易者失敗：',
  breadcrumbMarketplace: '交易市集',

  header: {
    unknownTrader: '未知交易者',
    repChip: '◆ {rep} 聲譽',
    staked: '已質押 {amount} {token}',
    notRegistered: '⚠ 此地址尚未註冊為交易者。',
  },

  strategy: {
    title: '最新策略',
    empty: '尚未發布策略。',
    /** 分配標籤：↑ sBTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  esg: {
    title: '策略 ESG 評分',
    champion: 'ESG 冠軍',
    aware: 'ESG 關注者',
    considerGreener: '考慮選擇更環保的標的',
    details: '詳情 →',
  },

  amount: {
    title: '跟單金額',
    placeholder: '1000',
    unitSuffix: '{token} 總保證金',
    disabledHint: '已停用 — 無策略',
  },

  preview: {
    totalDeposit: '總存入金額：',
    copyFee: '− 跟單手續費（0.3%）：',
    tradingFeeBuffer: '− 交易手續費緩衝：',
    effectiveMargin: '有效保證金：',

    column: {
      asset: '標的',
      side: '方向',
      leverage: '槓桿',
      weight: '權重',
      margin: '保證金',
      notional: '名義價值',
      estEntry: '預估進場價',
    },
    long: '做多 ↑',
    short: '做空 ↓',
  },

  feePreview: {
    title: '手續費預覽',
    copyFee: '跟單手續費（0.3%）',
    netMargin: '實際存入保證金',
    executionFee: '執行費（ETH）',
    split: '跟單手續費依 70% → 交易者 · 20% → 平台 · 10% → 罰沒池 分潤。執行費用於支付 Keeper 機器人。',
  },

  skinInGame: {
    title: '交易者風險共擔',
    staked: '已質押',
    reputation: '聲譽',
    reputationUnit: '分',
    totalSlashed: '累計罰沒',
    slashedWarning:
      '⚠ 此交易者曾因造成跟隨者過度虧損而被罰沒 {amount} {token}。請謹慎評估。',
    noStakeWarning:
      '⚠ 此交易者尚未質押——沒有風險共擔。若其造成虧損，你無法觸發罰沒機制。',
    slashRule:
      '⚠ 若你的虧損超過 30%，此交易者的質押將被罰沒（虧損金額的 50%，上限為質押額的 50%）並轉移給你作為補償。',
  },

  confirm: {
    title: '確認跟單',
    approveStep: '批准 {token} 給 CopyTracker',
    followStep: '跟隨交易者',

    staleTitle: '價格過期 — 暫停跟單',
    staleExplain:
      '跟單是一筆交易開 {count} 個倉位，只要有一檔過期整筆都會被拒絕，而 {count} 份 execution fee 的 gas 已經付出去了。',

    kycRequired:
      '🔒 此策略包含股票 / 債券資產，需通過 KYC 審核才能跟單（送出申請後需等審核人員核准）。',
    kycSubmit: '送出 KYC 申請',

    approving: '批准中…',
    approved: '已批准',
    approveCta: '步驟 1 · 批准',

    following: '跟單中…',
    stalePrice: '⛔ {asset} 價格過期',
    followCta: '步驟 2 · 跟隨交易者',

    noStrategy: '⚠ 交易者尚未發布策略，跟單功能已停用。',
    footer: '你的保證金將依上述策略自動分配並存入各部位。',
  },

  tx: {
    enterValidAmount: '請輸入有效金額',
    approved: '{token} 已批准 ✓',
    following: '已跟隨交易者 ✓',
  },

  /** #36：KYC 待審核那句夾了 `<b>`，拆成前後片段。 */
  markup: {
    kycPendingBefore: '⏳ 你的 KYC 申請',
    kycPendingBold: '已送出，正在等待審核',
    kycPendingAfter: '。審核人員核准後才能跟單含股票 / 債券的策略，不需要重複送出。',
  },
};
