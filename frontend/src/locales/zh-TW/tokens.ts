/**
 * 代幣化資產（Tokenized Assets）頁：V1／V2 金庫切換、健康度、買賣對話框。
 *
 * V1/V2 差異對照表整份搬進來——那是一張給人讀的比較表，不是設定。表格右兩欄
 * 的內容多半是合約與函式名（SafeERC20、ReentrancyGuard、UUPS proxy），逐字保留，
 * 它們和合約錯誤代號同一類。
 *
 */
export const tokens = {
  title: '代幣化資產',

  version: {
    v1: 'V1（原始版）',
    v2: 'V2（硬化版）',
    v2Unavailable: '此網路尚未部署 V2',
    v2Chip: 'SafeERC20 · 重入保護 · 可暫停',
  },

  /** V1 / V2 差異對照。 */
  diff: {
    title: 'V1 / V2 差異對照',
    columnItem: '項目',
    columnV1: 'V1',
    columnV2: 'V2',

    transfer: 'ERC-20 轉帳',
    transferV1: '裸 transfer',
    transferV2: 'SafeERC20',

    reentrancy: '重入保護',
    reentrancyV1: '無',
    reentrancyV2: 'ReentrancyGuard',

    pausable: '暫停機制',
    pausableV1: '無',
    pausableV2: 'Pausable',

    access: '權限模型',
    accessV1: 'Ownable（單一 owner）',
    accessV2: 'AccessControl（角色分離）',

    upgradeable: '可升級性',
    upgradeableV1: '不可升級',
    upgradeableV2: 'UUPS proxy',

    oracle: 'Oracle',
    oracleV1: 'MockOracle（單一 key）',
    oracleV2: 'GuardedOracle（多 keeper + 偏差上限）',

    cap: '發行上限',
    capV1: '無',
    capV2: '每資產 cap',

    reserve: '儲備率保護',
    reserveV1: '無',
    reserveV2: '低於下限拒絕 mint',

    fee: '手續費',
    feeV1: '無',
    feeV2: 'mint 手續費',
  },

  notDeployed: {
    v2: '此網路尚未部署 V2 硬化版金庫。',
    vault: '代幣化資產尚未在此網路啟用（AssetVault 未部署）。',
  },

  /** V2 健康度面板。 */
  health: {
    title: '🛡️ V2 硬化特性（鏈上即時數值）',
    reserveRatio: '儲備率',
    reserveRatioInfinite: '∞（尚無發行）',
    reserveRatioNote: '金庫 USDC 儲備 / 已發行代幣總值。低於下限時 mint 會被拒絕。',
    status: '運作狀態',
    paused: '已暫停',
    running: '運作中',
    pausableNote: 'Pausable：緊急時可由 PAUSER_ROLE 停止買賣。',
    accruedFees: '累積手續費',
    guardedOracle: 'GuardedOracle',
    guardedOracleNote: '多 keeper 預言機，單次更新偏差超過上限會被拒絕。',
    v1Notice:
      'V1 為初版實作，未包含 SafeERC20、儲備率保護與暫停機制。已部署合約的 bytecode 無法修改，因此 V1 保留於鏈上作為架構演進的對照組，建議使用 V2。',
  },

  card: {
    oraclePrice: 'Oracle 價格',
    myBalance: '我的餘額',
    issuedOverCap: '發行量 / 上限',
    capClosed: '0（已關閉）',
    buy: '買入',
    sell: '賣出',
    addToWallet: '➕ 加入 MetaMask',
  },

  /** 買賣對話框。 */
  dialog: {
    buyTitle: '買入 {symbol}',
    sellTitle: '賣出 {symbol}',
    buyAmountLabel: '支付 USDC 金額',
    sellAmountLabel: '賣出 {symbol} 數量',
    needAmount: '輸入金額以取得報價',
    buyQuote: '你將獲得 ≈ {amount} {symbol}',
    sellQuote: '你將收到 ≈ {amount} USDC',
    fee: '手續費：{amount} USDC',
    cancel: '取消',
    confirm: '確認',
    working: '處理中…',
  },

  tx: {
    badAmount: '金額格式不正確',
    amountTooSmall: '請輸入大於 0 的金額',
    badQuantity: '數量格式不正確',
    quantityTooSmall: '請輸入大於 0 的數量',
    bought: '已買入 {symbol} ✓ — 代幣已進入你的錢包',
    sold: '已賣出 {symbol} ✓ — USDC 已退回錢包',
    noWallet: '找不到錢包擴充功能',
  },

  /** #36：四段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    diffNoteBefore: '兩套實作並存於鏈上，V1 保留作為對照組。詳見 ',
    diffNoteMid: ' 與',
    diffNoteAfter: '。',

    introBefore: '本頁展示',
    introBold1: '代幣化資產（ERC-20）',
    introMid1: '。與交易頁的合成持倉不同，這裡買入的資產會以 ERC-20 token 形式',
    introBold2: '出現在你的錢包中',
    introMid2: '，可加入 MetaMask 檢視、可轉帳給他人。 買賣以 ',
    introAfter: ' 結算，價格取自鏈上 oracle（無滑價）。',

    staleOracleBold: 'GuardedOracle 價格已過期',
    staleOracleMid1:
      '，買賣暫時無法執行。 這是 fail-closed 的預期行為：預言機拒絕提供過期報價，而金庫的儲備率計算 會直接呼叫它，所以 ',
    staleOracleMid2: ' 與 ',
    staleOracleAfter: ' 會一起 revert。 需由 KEEPER_ROLE 重新餵價後恢復。',

    vaultDryBefore: '提示：賣出由金庫的 USDC 儲備支付。若儲備不足會顯示「vault dry」， 需由管理者呼叫 ',
    vaultDryAfter: ' 補充。',
  },
};
