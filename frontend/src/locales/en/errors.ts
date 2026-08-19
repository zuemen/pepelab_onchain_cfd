import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/errors.ts`。搬移階段逐字複製原文，所以這裡整份還是中文——這是英文版
 * 最大的一塊待辦，`locales.test.ts` 的 ratchet 在盯著它的字數。
 */

export const errors: Catalog['errors'] = {
  unknown: '未知錯誤',

  contract: {
    // Selectors (0x + 4-byte hex)
    '0xbb90b0d9': '需要先批准 USDC 給 Swap Router，請點擊 Approve',
    '0xe450d38c': '您的 Web3 錢包 USDC 餘額不足，請先前往【首頁/水龍頭】免費領取 USDC 測試幣 🚰',
    // Keyword matches (case-insensitive)
    ERC20InsufficientBalance:
      '您的 Web3 錢包 USDC 餘額不足，請先前往【首頁/水龍頭】免費領取 USDC 測試幣 🚰',
    'no strategies': '該交易員目前尚未發布任何跟單策略！',
    FaucetCooldown: 'Faucet 24h 內只能領一次，請等待 cooldown',
    NoStrategyPublished: '此 trader 尚未發布策略',
    TradingFeeExceedsMargin: '跟單金額太小，trading fee 超過 margin，請增加金額',
    InsufficientFreeMargin: '保證金不足，請先 deposit 更多 USDC',
    MarginTooLow: '保證金低於最低門檻（10 USDC）',
    InvalidLeverage: '槓桿必須是 1x / 2x / 5x',
    NotPositionOwner: '只有 position 持有者能操作',
    PositionAlreadyClosed: '此 position 已平倉',
    NotCopyTracker: '此 function 只有 CopyTracker 能呼叫',
    CopyTrackerNotSet: 'CopyTracker 尚未設定，請聯絡管理員',
    'Insufficient execution fee': '需要 0.001 ETH 作為執行費，請補充 ETH',
    AlreadyRegistered: '你已經是 trader，不需要重新註冊',
    NotRegistered: '請先註冊為 trader',
    EmptyAllocations: '策略不能為空，至少要有一個 allocation',
    InvalidWeightSum: '權重總和必須等於 100%',
    ZeroWeight: '權重不能為 0',
    CooldownNotElapsed: 'Unstake 冷凍期還沒結束',
    NoUnstakeRequest: '沒有 pending unstake 請求',
    InsufficientStake: '質押額度不足',
    AlreadyMined: '此倉位已申領過交易挖礦獎勵，請勿重複申領',
    AlreadyCheckedIn: '您今天已經簽到過囉，明天再來吧！',
    TierAlreadyClaimed: '此等級的晉升獎勵已申領過囉！',
    CopyAlreadyClaimed: '此跟單關係的獎勵已申領過囉！',
    NotFollowing: '您目前尚未開始跟單此交易員！',
    InvalidTier: '無效的等級參數！',
    InsufficientPool: '激勵合約的 PEPE 資金池餘額不足，請聯絡管理員充值！',
    TierThresholdNotMet: '您的累計交易量（Notional Volume）未達到此等級的要求！',
    StalePrice: '鏈上價格已過期，keeper 尚未更新。請稍等幾分鐘再試，或聯絡管理員手動觸發 keeper',
    NotKycVerified: '此資產為 RWA 市場，需先完成 KYC 驗證才能交易',
    PositionIsHealthy: '此倉位保證金仍充足，不符合清算條件',
    FundingIntervalNotElapsed: 'Funding 結算間隔（8 小時）尚未到，無需手動結算',
    NotPositionAgent: '這個倉位是由另一個 agent session 開的，只有當初開倉的那個 agent 能代為平倉',

    // ── PepeAMM（恆定乘積池：swap 會有滑點，且受 oracle 護欄限制）─────────────
    StaleOraclePrice:
      '兌換池的參考預言機報價已過期（超過 maxOracleAge），為避免被過期價格套利，兌換暫停。請等 keeper 更新價格後再試',
    PriceOutOfBand:
      '這筆兌換會把池價推離預言機報價太遠（超過 maxOracleDeviationBps）。請減少兌換金額，或等其他人先把池子拉回平衡',
    InsufficientLiquidity: '兌換池流動性不足以支撐這筆金額，請減少兌換數量',
    InsufficientInput: '兌換金額太小（扣掉手續費後為 0），請加大金額',
    InsufficientOutput:
      '實際成交量低於你設定的最低可接受數量（滑點保護生效）。價格在你送出後變動了，請重新取得報價再試',
    InsufficientShares: 'LP share 不足，無法移除這麼多流動性',
    EthNotAccepted: '不能直接把 ETH 轉給兌換池。請用 Swap 功能（swapETHForUSDC）或 addLiquidity',
    InvalidOraclePrice: '預言機回報的價格無效（0 或負值），兌換暫停',

    // ── Mock 代幣 ────────────────────────────────────────────────────────────
    FaucetCallerMustBeEOA:
      '水龍頭只開放一般錢包（EOA）領取。你目前是用合約錢包（Safe / ERC-4337 smart account）呼叫，請改用一般 EOA 錢包，或請管理員直接轉幣給你',
    NotMinter:
      'mint 只有合約 owner 或已註冊的 swapRouter 能呼叫。一般使用者請改用水龍頭 faucet() 領取測試幣',

    // ── KYCRegistry（審核制）─────────────────────────────────────────────────
    NoSubmission: '這個地址還沒送出 KYC 申請，無法審核',
    NotVerifier: '只有審核人員（verifier）或合約 owner 能執行 KYC 審核',

    // ── ESG / 激勵 ───────────────────────────────────────────────────────────
    EsgHoldAlreadyClaimed: '此倉位的 ESG 長抱獎勵已領取過囉！',
    AlreadyClaimed: '此獎勵已領取過囉！',
    PositionNotOpen: '倉位必須「仍持有中」才能領獎。已平倉的倉位不符合資格',
    HoldTooShort: '持有時間還沒達到最短持有期（預設 30 天），請再抱一陣子',
    AssetNotHighEsg: '此標的的 ESG 綜合分數未達高分門檻，不符合 ESG 獎勵資格',
    EsgScoreTooLow: '此標的的 ESG 分數低於門檻，不符合獎勵資格',
    SelfCopyNotAllowed: '不能跟單自己',
    PositionIdsNotSorted:
      '倉位 ID 陣列必須嚴格遞增（已自動排序仍失敗代表有重複 ID），請重新整理頁面再試',
    RewardExceedsBudget: '本次發放金額超過質押合約的獎勵預算（rewardBudget），請聯絡管理員調整',

    // ── 預言機 adapter（stale/不完整/低信賴度時會 revert，不再回傳舊值）──────
    PriceIsStale:
      '預言機價格已過期（超過 staleThreshold，預設 1 小時），為安全起見直接拒絕，不會用舊價成交',
    IncompleteRound: 'Chainlink 該輪報價尚未完成（incomplete round），請稍後再試',
    InvalidTimestamp: '預言機回報的時間戳無效，拒絕使用此報價',
    FeedNotSet: '此標的尚未設定 Chainlink / Pyth feed',
    NoLiveSource: '聚合預言機的兩個來源都無法提供有效報價，交易暫停（fail-closed）',
    SingleSourceNotAllowed:
      '聚合預言機只剩單一來源可用，且未開啟 allowSingleSource，交易暫停（fail-closed）',
    PriceDeviationTooHigh: '兩個預言機來源的報價偏離過大，為避免用到錯價，交易暫停',
    InvalidParam: '參數超出合約允許的上下界，請檢查輸入值',
    InvalidPrice: '鏈上價格無效（0），無法結算',
    'user rejected': '你拒絕了交易',
    'User rejected': '你拒絕了交易',
    ACTION_REJECTED: '你拒絕了交易',
    'insufficient funds': 'ETH 不夠付 gas 費',
    OutOfFunds: 'ETH 餘額不足以支付執行費（開倉需附 ETH），請先領取測試 ETH 🚰',
    'execution reverted': '交易執行失敗',
    'nonce too low': 'Nonce 太低，請重試',
  },

  /** 認得出是 revert、但只有「execution reverted」這種沒資訊量的訊息時的說法。 */
  reverted: {
    copy: '領取跟單獎勵失敗 (Reverted)。請確認：1. 您已開始跟單此交易員；2. 您尚未領取過此關係的獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。',
    tier: '等級晉級獎勵領取失敗 (Reverted)。請確認：1. 您的累計交易量已達標該等級門檻；2. 您尚未領取過此等級獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。',
    mining:
      '交易挖礦獎勵領取失敗 (Reverted)。請確認：1. 您是此倉位的持有者；2. 該倉位尚未領取過挖礦獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。',
    checkin:
      '每日簽到失敗 (Reverted)。請確認：1. 您今天尚未簽到過；2. 激勵合約的 PEPE 資金池已充值足夠資金。',
    generic:
      '交易執行失敗 (Reverted)。常見原因：ETH 不足以支付執行費、保證金不足、或鏈上價格過期。請檢查餘額與參數後再試。',
  },

  unrecognised:
    '交易失敗，且錯誤訊息無法辨識。請確認網路與餘額後重試；若持續發生，請開瀏覽器 console 取得原始錯誤回報。',
};
