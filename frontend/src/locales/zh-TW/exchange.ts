/**
 * Exchange 頁。
 *
 * 這一頁是全站最大的下單路徑，也是搬移最麻煩的一頁：條件字串、插值、句中夾標記
 * 三種都有。前兩種都搬進來了；**句中夾標記**那一種刻意留在原地，交給 #36 一起處理。
 *
 * 兩個在這一頁反覆出現的寫法，值得先說清楚：
 *
 * 1. **條件字串拆成兩個 key**，不是一個 key 加膠水。`busy ? '領取中…' : '領取 X'`
 *    寫成 `claiming` 與 `claimToken` 兩條完整的句子，而不是 `'領取' + suffix`——
 *    詞序是語言的一部分，拼接會把它焊死在中文的順序上。
 *
 * 2. **跨行的句子帶著那個空白**。JSX 會把字串中間的換行壓成一個半形空格，所以
 *    畫面上本來就有那個空格。搬移階段要求逐字相同，就得連它一起搬——不是筆誤。
 */
export const exchange = {
  connectWallet: 'Connect wallet to access the exchange.',
  loadingChainData: 'Loading blockchain data...',

  /** 全域交易覆蓋層上，標題底下那句固定的說明。 */
  confirmInWallet: 'Please confirm the transaction in your wallet and wait for block confirmation.',

  side: {
    long: 'Long',
    short: 'Short',
  },

  /** 送出交易前後對使用者說的話。 */
  tx: {
    enterValidAmount: 'Enter a valid amount',
    enterValidMargin: 'Enter a valid margin',
    insufficientMargin: '保證金不足，請先在 Margin Account 區塊 Approve & Deposit',

    /**
     * 兌換池的 oracle 過期。這句話在按下去之前就要說——合約會 revert
     * StaleOraclePrice，等使用者付完 gas 才知道是最糟的順序。
     */
    ammStale:
      '兌換池的參考預言機報價已過期，合約會拒絕兌換（StaleOraclePrice）。請等 keeper 更新價格後再試。',

    approving: 'Approving {token}…',
    swappedEthForToken: 'Swapped {amount} ETH for ~{received} {token} ✓',
    swappedTokenForEth: 'Swapped {amount} {token} for ~{received} ETH ✓',

    faucetStable: '已領取測試 {token} ✓ — 可在右側 Margin Account「Approve & Deposit」作為保證金',
    faucetAltStable: '已領取測試 {alt} ✓ — 可持有與兌換；保證金請用 {token}',
    faucetPepe: '已領取測試 PEPE ✓',

    deposited: 'Deposited {amount} {token} ✓',
    withdrew: 'Withdrew {amount} {token} ✓',

    positionOpened: '{side} {asset} opened ✓',
    positionClosed: 'Position closed ✓',
    esgClaimed: '🌱 ESG 獎勵領取成功！',
  },

  /** 全域交易覆蓋層上的字，依當下進行中的動作切換。 */
  loading: {
    fallback: 'Processing transaction...',
    swapEthToToken: 'Swapping ETH to {token}…',
    swapTokenToEth: 'Swapping {token} to ETH…',
    faucetStable: 'Claiming test {token}…',
    faucetPepe: 'Claiming test PEPE…',
    deposit: 'Depositing Margin...',
    withdraw: 'Withdrawing Margin...',
    open: 'Opening Position...',
    close: 'Closing Position...',
  },

  /**
   * 新手引導卡。只有標題進 catalog：底下那四條 `<li>` 每一條都是
   * `<strong>前綴：</strong> 說明` 的句中夾標記，和幣別說明那段一起留給 #36。
   */
  guide: {
    title: 'How CFD trading works on PepeLab',
  },

  /** 水龍頭區塊。三種代幣共用同一組「領取中／領取 X／尚未部署」的字。 */
  faucet: {
    title: '🚰 Get Test Tokens',
    intro:
      'PEPE 是平台幣（測試網模擬），用水龍頭免費領取；{stable} 為模擬保證金穩定幣；x402 付費用{x402Stable}。',

    stableNote: '· 模擬保證金',
    altStableNote: '· 模擬穩定幣（持有／兌換）',
    pepeNote: '· 平台幣',

    balance: 'Balance: {amount}',
    notDeployed: '尚未在本網路部署',
    notDeployedChip: '尚未部署',

    claiming: '領取中…',
    claimToken: '領取 {token}',

    pepeUndeployed:
      'PEPE 尚未在本網路（Base Sepolia）部署。部署 PepeToken 後把位址填入 addresses.ts 即可開放領取。',

    addToWallet: '把 {token} 加入 MetaMask',
  },

  /** ETH ↔ USDC 兌換區塊（PepeAMM）。 */
  swap: {
    title: 'Swap',
    poolBadge: '● 恆定乘積池 · 有滑點',
    notDeployed: '本網路未部署兌換池（PepeAMM）。請切換到 Base Sepolia。',

    youPay: 'You pay',
    youReceive: 'You receive (est.)',
    balance: 'Balance: {amount}',

    /**
     * 池內現價和 oracle 參考價是兩個不同的數字，所以是兩條 label 而不是一條——
     * 它們分岔超過 maxOracleDeviationBps 時合約就會擋下兌換。
     */
    poolPrice: 'Pool price（池內現價）',
    oracleRef: 'Oracle ref.（參考價）',
    poolReserves: 'Pool reserves',
    priceImpact: 'Price impact（含手續費）',
    minimumReceived: 'Minimum received（{tolerance}% 容忍）',

    constantProductNote:
      '恆定乘積 (x·y=k) 池：金額越大滑點越高。報價已含 0.3% 手續費，minOut 以即時 quote 為基準。',

    swapping: 'Swapping…',
    oracleStale: '⛔ 預言機報價過期，暫停兌換',
    enterAmount: 'Enter an amount',
    ethToToken: 'Swap ETH → {token}',
    tokenToEth: 'Swap {token} → ETH',
  },

  /** 保證金帳戶區塊。 */
  margin: {
    accountEquity: 'Account Equity',
    equityUnit: '{token} (Testnet)',
    freeMargin: 'Free Margin',
    unrealizedPnl: 'Unrealized PnL',

    stablecoin: '穩定幣',
    balance: '餘額 {token}',

    depositPlaceholder: 'Amount to deposit',
    approveDeposit: 'Approve & Deposit',
    withdrawPlaceholder: 'Amount to withdraw',
    withdraw: 'Withdraw',
  },

  /** 下單表單。 */
  open: {
    title: 'Open Position',

    riskNotice:
      '⚠️ 測試網：本平台為 oracle 計價永續，損益以 mark 價（含 OI 失衡）結算；極端單邊行情下帳面利潤可能因 ADL 自動減倉而調整；保證金為測試代幣。',
    showRiskNotice: '⚠️ 顯示風險提示',

    staleTitle: '價格過期 — 暫停下單',
    staleIndexAge:
      '指數價年齡：{age} · 上方「Live market」是 CoinGecko 顯示價， 不是結算價，兩者不一致時以鏈上 oracle 為準。',
    ageUnknown: '未知',

    kycUnknown:
      '⚠ 無法確認您的 KYC 狀態（鏈上讀取失敗），不是「未驗證」。合規閘門採 fail-closed， 在確認之前暫停受管制資產的交易。請檢查網路或稍後重試。',
    kycSubmit: '送出 KYC 申請',

    esgWarningTitle: '⚠ ESG 警告：此資產評分偏低（{composite}/100 · {rating}）',
    esgWarningBody:
      '此資產 ESG 評分偏低，可能涉及較高環境、社會或治理風險，請謹慎評估永續投資風險後再決定是否開倉。',
    esgConfirm: '我已了解此資產的 ESG 風險，仍要繼續交易',

    asset: 'Asset',
    esgHighRating: '高永續評級',
    esgLowRating: '低永續評級',
    esgUnavailable: '本鏈未提供 ESG 資料（ESGRegistry 未部署）',
    esgLoading: 'ESG 資料載入中…',
    esgNone: '此標的無 ESG 評級',

    direction: 'Direction',
    long: 'LONG ↑',
    short: 'SHORT ↓',
    orderType: 'Order Type: Market',
    executionFee: 'Execution Fee: {fee} ETH',
    executionFeeDefault: '（預設值）',

    leverage: 'Leverage',
    maxLeverage: '⚠ Max {max}× — tighter risk cap for this asset class',

    marginLabel: 'Margin',
    marginPlaceholder: 'e.g. 100',

    entryOracle: 'Entry (oracle)',
    liveMarket: 'Live market',
    simulated: '(simulated)',
    notional: 'Notional',

    fundingRate: 'Funding rate (8h)',
    fundingLongsPay: '(longs pay)',
    fundingShortsPay: '(shorts pay)',
    fundingBalanced: '(balanced)',

    estLiquidation: 'Est. Liquidation: {price}',
    liquidationTooltip:
      '觸及清算價時倉位會被強制平倉。扣除虧損、手續費、清算人獎勵與清算罰金（liquidationPenaltyBps）後的殘餘保證金會退還給你——不是全額沒收。',

    freeMargin: 'Free margin',
    insufficient: '⚠ Insufficient — deposit at least {amount} more {token} first',

    /** 下單鈕的每一種狀態都是完整的一句話，不是拼接出來的。 */
    submitting: 'Opening…',
    ctaStale: '⛔ 價格過期，無法下單',
    ctaKycUnknown: '⚠ 無法確認 KYC 狀態',
    ctaKycPending: '⏳ KYC 審核中，尚未核准',
    ctaKycRequired: '🔒 送出 KYC 申請才能交易 {asset}',
    ctaEsgUnconfirmed: '請先確認 ESG 風險',
    ctaOpen: 'Open {side} {asset}',
  },

  esgLeaderboard: {
    title: 'ESG Leaderboard',
  },

  /** 持倉表。 */
  positions: {
    title: 'Open Positions',
    refresh: 'Refresh',
    empty: 'No open positions.',

    column: {
      asset: 'Asset',
      side: 'Side',
      entry: 'Entry',
      current: 'Current',
      size: 'Size',
      margin: 'Margin',
      leverage: 'Lev',
      pnl: 'PnL',
    },

    long: 'LONG',
    short: 'SHORT',

    close: 'Close',
    stale: '價格過期',
    staleNote: '指數價 {age} — 平倉會被 StalePrice 拒絕，等 keeper 更新後再試。',
    staleAgeUnknown: '年齡未知',

    esgRewarded: '✓ 已領 ESG 獎勵',
    esgHoldLonger: '🌱 ESG 獎勵：再抱 {days} 天',
    esgIneligible: '🌱 ESG 獎勵：尚不符資格',
    esgHoldLongerTooltip: 'ESG 獎勵需持倉滿 {days} 天且倉位仍未平倉',
    esgIneligibleTooltip: 'previewReward 回 0：倉位需仍持有中，且已滿最短持有期',
  },

  /** 按鈕正在跑交易的時候，格子裡顯示的字。 */
  working: '…',
};
