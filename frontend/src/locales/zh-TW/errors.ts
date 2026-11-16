/**
 * 合約 revert 的說明，以及認不出來時的退路。
 *
 * `contract` 的**順序有意義**：prettyError 會照插入順序逐一做 keyword 比對，順序一
 * 變，某些錯誤就會先撞上另一條較早的規則、拿到不對的訊息。搬進 catalog 時逐字保留
 * 原檔的順序與內容。
 *
 * 合約錯誤代號（StalePrice、maxOracleAge…）刻意留在句子裡不翻——使用者要能把它貼到
 * 搜尋或回報訊息裡（見 docs/adr/0002）。
 */

export const errors = {
  unknown: '未知錯誤',

  contract: {
    // Selectors (0x + 4-byte hex)
    // 公開節點常只回 revert data、ethers 不一定解得出名字：交易所的 RWA／休市閘門也以 selector 對應。
    '0xbb723368': '此資產屬於受管制的 RWA 標的，需先完成 KYC 驗證才能投資',
    '0x4f402872': '這個標的目前休市或暫停（鏈上模式「只能賣出」或「暫停」），不能買進。「只能賣出」時已持有的可以賣出；「暫停」時要等解除才能賣出',
    '0xbb90b0d9': '需要先批准 USDC 給 Swap Router，請點擊 Approve',
    '0xe450d38c': '您的 Web3 錢包 USDC 餘額不足，請先到【入金與兌換】頁面用水龍頭免費領取 USDC 🚰',
    // Keyword matches (case-insensitive)
    ERC20InsufficientBalance:
      '您的 Web3 錢包 USDC 餘額不足，請先到【入金與兌換】頁面用水龍頭免費領取 USDC 🚰',
    'no strategies': '這位策略分享者目前尚未發布任何可跟著投資的策略！',
    FaucetCooldown: '水龍頭 24 小時內只能領一次，請稍後再試',
    NoStrategyPublished: '這位策略分享者尚未發布策略',
    TradingFeeExceedsMargin: '跟著投資的金額太小，買賣手續費超過投入金額，請增加金額',
    InsufficientFreeMargin: '可用的投入金額不足（買進另扣買賣手續費），請先存入更多 USDC 或減少金額',
    MarginTooLow: '投入金額低於最低門檻（10 USDC）',
    InvalidLeverage: '放大倍數必須是 1x / 2x / 5x',
    NotPositionOwner: '只有這筆投資的持有人能操作',
    PositionAlreadyClosed: '這筆投資已經賣出',
    NotCopyTracker: '這個操作只有跟著投資的鏈上程式（CopyTracker）能執行',
    CopyTrackerNotSet: '跟著投資的鏈上程式（CopyTracker）尚未設定，請聯絡管理員',
    'Insufficient execution fee': '附帶的 ETH 不足以支付執行費（金額以鏈上 executionFee 為準），請補充 Base Sepolia ETH',
    AlreadyRegistered: '你已經是策略分享者，不需要重新註冊',
    NotRegistered: '請先註冊為策略分享者',
    EmptyAllocations: '策略不能為空，至少要有一檔標的',
    InvalidWeightSum: '權重總和必須等於 100%',
    ZeroWeight: '權重不能為 0',
    TooFewAssets: '策略至少要配置 3 檔不同的標的',
    DuplicateAsset: '同一標的在策略中只能出現一次',
    WeightExceedsMax: '單一標的權重不能超過 50%',
    CooldownNotElapsed: '取回履約押金的等待期還沒結束',
    NoPendingUnstake: '沒有待處理的取回押金申請',
    BelowMinStake: '履約押金總額會低於最低門檻（100 USDC），請提高金額',
    NotSyncExecutor: '這筆跟著投資指定了別的同步執行者，只有對方或你本人能同步',
    VaultDry: '金庫目前的 USDC 不足以支付這筆贖回，請減少數量或稍後再試',
    ZeroAmount: '金額不能為 0',
    IsPaused: '這個功能目前暫停中，請稍後再試',
    ZeroAgent: 'AI 代理的地址不能是空的',
    ZeroBudget: '總預算要大於 0',
    ZeroLeverage: '放大倍數上限要大於 0',
    InvalidExpiry: '到期時間無效，時數要大於 0',
    InsufficientStake: '履約押金不足',
    AlreadyMined: '這筆投資已申領過投資獎勵，請勿重複申領',
    AlreadyCheckedIn: '您今天已經簽到過囉，明天再來吧！',
    TierAlreadyClaimed: '此等級的晉升獎勵已申領過囉！',
    CopyAlreadyClaimed: '這段跟著投資關係的獎勵已申領過囉！',
    NotFollowing: '您目前沒有跟著這位策略分享者投資！',
    InvalidTier: '無效的等級參數！',
    InsufficientPool: '獎勵程式的 PEPE 資金池餘額不足，請聯絡管理員補充！',
    TierThresholdNotMet: '您的累計投資金額（Notional Volume）未達到此等級的要求！',
    StalePrice: '鏈上價格已過期，自動更新程式（keeper）尚未更新。請稍等幾分鐘再試，或聯絡管理員手動更新',
    NotKycVerified: '此資產屬於受管制的 RWA 標的，需先完成 KYC 驗證才能投資',
    AssetNotActive: '這個標的目前休市或暫停（鏈上模式「只能賣出」或「暫停」），不能買進。「只能賣出」時已持有的可以賣出；「暫停」時要等解除才能賣出',
    AssetHalted: '這個標的目前暫停買賣，買進與賣出都要等解除後才能進行',
    OpenInterestCapExceeded: '這個標的的總投資額已達上限，請減少金額或稍後再試',
    PositionIsHealthy: '這筆投資的投入金額仍充足，不符合自動結清條件',
    FundingIntervalNotElapsed: '持有費用的結算間隔（8 小時）尚未到，無需手動結算',
    NotPositionAgent: '這筆投資是由另一個 AI 代理額度（agent session）買進的，只有當初買進的那個 AI 代理能代為賣出',

    // ── AssetVaultV2（#99：儲備率觀測與破線自動暫停）─────────────────────────
    MintingHalted:
      '鑄造已暫停——鏈上觀測到儲備率跌破門檻，新的買入需要等下一次觀測顯示已恢復。贖回不受影響，可以正常賣出。',
    ReserveRatioTooLow: '這筆買入會讓金庫儲備率低於門檻，已被拒絕。可以嘗試更小的金額，或稍後再試。',
    CapExceeded: '這檔資產已接近發行上限，這筆買入會超過上限。可以嘗試更小的金額，或稍後再試。',
    EnforcedPause: '金庫目前暫停中，暫時無法買進。',

    // ── PepeAMM（恆定乘積池：swap 會有滑點，且受 oracle 護欄限制）─────────────
    StaleOraclePrice:
      '兌換池參考的價格來源報價已過期（超過 maxOracleAge），為避免有人用過期價格套利，兌換暫停。請等自動更新程式（keeper）更新價格後再試',
    PriceOutOfBand:
      '這筆兌換會把池價推離價格來源的報價太遠（超過 maxOracleDeviationBps）。請減少兌換金額，或等其他人先把池子拉回平衡',
    InsufficientLiquidity: '兌換池流動性不足以支撐這筆金額，請減少兌換數量',
    InsufficientInput: '兌換金額太小（扣掉手續費後為 0），請加大金額',
    InsufficientOutput:
      '實際成交量低於你設定的最低可接受數量（滑點保護生效）。價格在你送出後變動了，請重新取得報價再試',
    InsufficientShares: 'LP share 不足，無法移除這麼多流動性',
    EthNotAccepted: '不能直接把 ETH 轉給兌換池。請用 Swap 功能（swapETHForUSDC）或 addLiquidity',
    InvalidOraclePrice: '價格來源回報的價格無效（0 或負值），兌換暫停',
    // 線上舊版 PepeAMM（oracle 定價版）用的是 require 字串，不是 custom error。
    'reserve in pool': '超過池內可兌出庫存，兌換池付不出這麼多。請減少兌換金額',
    'invalid oracle price': '價格來源回報的價格無效（0 或負值），兌換暫停',

    // ── Mock 代幣 ────────────────────────────────────────────────────────────
    FaucetCallerMustBeEOA:
      '水龍頭只開放一般錢包（EOA）領取。你目前是用智慧錢包（Safe / ERC-4337 smart account）呼叫，請改用一般 EOA 錢包，或請管理員直接轉幣給你',
    NotMinter:
      'mint 只有鏈上程式的 owner 或已註冊的 swapRouter 能呼叫。一般使用者請改用水龍頭 faucet() 領幣',

    // ── KYCRegistry（審核制）─────────────────────────────────────────────────
    NoSubmission: '這個地址還沒送出 KYC 申請，無法審核',
    NotVerifier: '只有審核人員（verifier）或鏈上程式的 owner 能執行 KYC 審核',

    // ── ESG / 激勵 ───────────────────────────────────────────────────────────
    EsgHoldAlreadyClaimed: '這筆投資的 ESG 長抱獎勵已領取過囉！',
    AlreadyClaimed: '此獎勵已領取過囉！',
    PositionNotOpen: '這筆投資必須「仍持有中」才能領獎。已賣出的投資不符合資格',
    HoldTooShort: '持有時間還沒達到最短持有期（預設 30 天），請再抱一陣子',
    AssetNotHighEsg: '此標的的 ESG 綜合分數未達高分門檻，不符合 ESG 獎勵資格',
    EsgScoreTooLow: '此標的的 ESG 分數低於門檻，不符合獎勵資格',
    SelfCopyNotAllowed: '不能跟著自己投資',
    StrategyVersionMismatch:
      '策略分享者在你送出前發布了新版策略：為了不讓你用到沒看過的版本，這次沒有執行。請重新整理頁面、確認新版後再送出',
    TraderNotEligible: '這位策略分享者的履約押金不足或正在申請取回，暫時不能接受新的資金（已有的投資不受影響）',
    PositionStillOpen: '有一檔現在賣不掉（價格過期、市場休市或暫停…），整筆已退回、你的投資維持原狀，請稍後再試',
    RecordAlreadyInactive: '這筆紀錄已經結束，請重新整理頁面',
    // ── CopyTracker 自動同步（ADR-024）────────────────────────────────────────
    AlreadySynced: '已經是策略分享者的最新版，不需要同步',
    InsufficientSyncGas: '自動同步油箱的 ETH 不夠付這次同步的執行費（與小費），請先存入油箱',
    InsufficientExecutionFee:
      '附帶的 ETH 不夠付這次買進的執行費（平台的執行費率可能剛調整過），這次沒有執行；請重新整理頁面後再送出',
    InvalidRecipient: '收款地址無效（例如 0x0），請確認地址後再送出',
    SyncCooldown: '還在冷卻時間內（自動同步設定的最短間隔），其他人要等冷卻結束才能代為同步；本人手動同步不受限',
    AutoSyncDisabled: '這筆紀錄沒有開啟自動同步，只有本人能手動同步',
    InvalidSyncConfig: '自動同步設定超出範圍：放大倍數上限需為 1–5×、冷卻至少 1 小時，小費不能超過鏈上程式的上限',
    ExecutionFeeAboveCap:
      '平台的執行費高於你同意的費率（送出時畫面上顯示的，或開啟自動同步時同意的），整筆退回、油箱沒有被動用；重新整理頁面看過新費率後再送出，或重新儲存自動同步設定以同意新費率',
    NothingToRedeploy: '舊的持有賣出後沒有剩下任何投入金額（可能已全部被自動結清），沒有東西可以重新投入',
    SyncDisturbedOtherPositions: '這次賣出連帶動到了你其他的投資（例如觸發自動調降），為了不動用其他資金，同步整筆退回；請稍後再試',
    EthTransferFailed: 'ETH 轉回錢包失敗，油箱餘額沒有變動，請確認收款地址能接收 ETH',
    PositionIdsNotSorted:
      '投資編號必須嚴格遞增（已自動排序仍失敗代表有重複編號），請重新整理頁面再試',
    RewardExceedsBudget: '本次發放金額超過履約押金程式的獎勵預算（rewardBudget），請聯絡管理員調整',

    // ── 預言機 adapter（stale/不完整/低信賴度時會 revert，不再回傳舊值）──────
    PriceIsStale:
      '價格來源的報價已過期（超過 staleThreshold，預設 1 小時），為安全起見直接拒絕，不會用舊價成交',
    IncompleteRound: '價格來源（Chainlink）這一輪報價尚未完成，請稍後再試',
    InvalidTimestamp: '價格來源回報的時間無效，拒絕使用此報價',
    FeedNotSet: '此標的尚未設定價格來源（Chainlink / Pyth）',
    NoLiveSource: '兩個價格來源都無法提供有效報價，買賣暫停',
    SingleSourceNotAllowed:
      '價格來源只剩單一來源可用，且未開啟 allowSingleSource，買賣暫停',
    PriceDeviationTooHigh: '兩個價格來源的報價偏離過大，為避免用到錯價，買賣暫停',
    InvalidParam: '參數超出鏈上程式允許的上下界，請檢查輸入值',
    InvalidPrice: '鏈上價格無效（0），無法結算',
    'user rejected': '你拒絕了交易',
    'User rejected': '你拒絕了交易',
    ACTION_REJECTED: '你拒絕了交易',
    'insufficient funds': 'ETH 不夠付手續費，請先到公開的 Base Sepolia 水龍頭領一點',
    OutOfFunds: 'ETH 餘額不足以支付執行費（買進需附 ETH），請先到公開的 Base Sepolia 水龍頭領少量 ETH',
    'nonce too low': 'Nonce 太低，請重試',
  },

  /** 認得出是 revert、但只有「execution reverted」這種沒資訊量的訊息時的說法。 */
  reverted: {
    copy: '領取跟著投資獎勵失敗 (Reverted)。請確認：1. 您已開始跟著這位策略分享者投資；2. 您尚未領取過這段關係的獎勵；3. 獎勵程式的 PEPE 資金池足夠。',
    tier: '等級晉級獎勵領取失敗 (Reverted)。請確認：1. 您的累計投資金額已達到該等級門檻；2. 您尚未領取過此等級獎勵；3. 獎勵程式的 PEPE 資金池足夠。',
    mining:
      '投資獎勵領取失敗 (Reverted)。請確認：1. 您是這筆投資的持有人；2. 這筆投資尚未領取過獎勵；3. 獎勵程式的 PEPE 資金池足夠。',
    checkin:
      '每日簽到失敗 (Reverted)。請確認：1. 您今天尚未簽到過；2. 獎勵程式的 PEPE 資金池足夠。',
    /** 還不知道合約版本時：不提資金池，也不提點數。 */
    checkinUnknown: '每日簽到失敗 (Reverted)。請確認您今天尚未簽到過。',
    checkinPoints:
      '每日簽到失敗 (Reverted)。請確認您今天尚未簽到過。此版本的簽到記入成就點數，不需要 PEPE 資金池。',
    generic:
      '執行失敗 (Reverted)。常見原因：ETH 不足以支付執行費、投入金額不足、或鏈上價格過期。請檢查餘額與參數後再試。',
    /** #149：採用配置的現貨買進——不能沿用 generic，那句提到保證金。 */
    adopt:
      '買進失敗 (Reverted)。常見原因：ETH 不足以支付手續費、USDC 餘額不足、或鏈上價格過期。請檢查餘額後再試。',
  },

  /** 節點限流或連線失敗：沒有交易被拒絕，也不代表沒有資料。 */
  nodeUnavailable: '鏈上節點暫時沒有回應（可能是流量限制），資料還沒讀到，這不代表沒有資料或操作失敗。請稍後再試。',

  /** 讀取被合約拒絕：沒有交易失敗，但重試也不會改變。 */
  readReverted: '這筆鏈上資料讀不到：鏈上程式拒絕了這次讀取，重試也不會改變。這不代表有操作失敗。',

  unrecognised:
    '送出失敗，且錯誤訊息無法辨識。請確認網路與餘額後重試；若持續發生，請開瀏覽器 console 取得原始錯誤回報。',
};
