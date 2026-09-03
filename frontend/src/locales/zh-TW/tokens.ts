/**
 * 代幣化資產（Tokenized Assets）頁：V1／V2 金庫切換、健康度、買賣對話框。
 *
 * V1/V2 差異對照表整份搬進來——那是一張給人讀的比較表，不是設定。表格右兩欄
 * 的內容多半是合約與函式名（SafeERC20、ReentrancyGuard、UUPS proxy），逐字保留，
 * 它們和合約錯誤代號同一類。
 *
 */
export const tokens = {
  /** TradingView 外嵌圖表區。報價基準刻意寫死 Coinbase 現貨,見元件註解。 */
  chart: {
    title: '市場行情',
    source: '報價來源：Coinbase 現貨（{symbol}）· 由 TradingView 提供圖表',
    btc: '比特幣',
    eth: '以太幣',
    unavailable: '圖表由 TradingView 外部載入,若此處空白代表外部資源未載入,不影響下方的買賣功能。',
  },
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

    oracle: '預言機',
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
    /** #99：儲備率過期時顯示這個而不是一個樂觀數字，比照 kyc.ts 的 unknownTitle。 */
    reserveRatioUnknown: '無法確認',
    reserveRatioNote: '金庫 USDC 儲備 / 已發行代幣總值。低於下限時 mint 會被拒絕。',
    reserveRatioNoteStale: '至少一項資產的價格已過期，此數字可能被低估負債、讀起來比實際樂觀——視為「未知」而非「健康」，在有新報價之前。',
    status: '運作狀態',
    paused: '已暫停',
    running: '運作中',
    /** #99：AssetVaultV2_3.mintingHalted() 的鎖存狀態，與 paused（PAUSER_ROLE 手動）是不同的鎖。 */
    mintingHalted: '鑄造已暫停',
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
    // issue #100 ②：Simple Mode 的詞彙——開倉/平倉 → 買進/贖回。贖回是金庫實際
    // 執行的動作（redeem），不是把代幣賣給別人。見 frontend/CONTEXT.md 的詞彙表。
    buy: '買進',
    sell: '贖回',
    addToWallet: '➕ 加入 MetaMask',
  },

  /** 買賣對話框。 */
  dialog: {
    buyTitle: '買進 {symbol}',
    sellTitle: '贖回 {symbol}',
    buyAmountLabel: '支付 USDC 金額',
    sellAmountLabel: '贖回 {symbol} 數量',
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
    bought: '已買進 {symbol} ✓ — 代幣已進入你的錢包',
    sold: '已贖回 {symbol} ✓ — USDC 已退回錢包',
    noWallet: '找不到錢包擴充功能',
  },

  /**
   * issue #100 ①③④：資產身世卡、「誰負責什麼」、時間尺度。
   * 逐檔的事實（識別碼、碳強度數字、出處網址）在 lib/pepefi/assetMeta.ts；
   * 這裡是那張卡上的顯示字串（比照 esg.ts 把每檔一句話的理由放 catalog）。
   */
  provenance: {
    sectionTitle: '資產身世',
    underlyingLabel: '追蹤標的',
    referenceIdLabel: '參考識別碼',
    priceSourceLabel: '價格來源',
    priceFeedName: {
      coingecko: 'CoinGecko 現貨',
      yahoo: 'Yahoo Finance chart',
    },
    freshnessLabel: '價格新鮮度',
    disclaimer: '本代幣以合成價格追蹤上述標的，不代表對該標的的所有權、股東權利或任何請求權。',

    carbonTitle: '碳強度',
    carbonTier: {
      unrated: '未評等',
      low: '低碳',
      mid: '中碳',
      high: '高碳',
    },
    carbonBasis: {
      revenue: 'tCO2e ／ 每百萬美元營收',
      absolute: '絕對年排放量基準（不與營收基準同尺度）',
      qualitative: '依類別組成質性判定，非計算值',
    },
    carbonUnratedNote: '目前沒有未過期的碳見證資料，此資產一律以最保守級計價。',
    observedLabel: '上次見證',
    nextDueLabel: '下次見證',
    sourceLabel: '出處',
    caveatLabel: '已知限制',

    kycTitle: '為什麼需要 KYC',
    kycReason: '這個資產追蹤在受監管市場掛牌的證券。開立槓桿部位前會檢查 KYC 狀態；直接買進與贖回代幣不受影響。',
    kycNotGated: '這個資產不追蹤受監管證券，不需要 KYC。',

    heldDaysLabel: '你已持有',
    heldDaysValue: '{n} 天',
    sinceLabel: '自 {date} 起見證',

    /** 逐檔一句話的標的說明、碳資料出處名稱、已知限制。數字與網址在 assetMeta.ts。 */
    assets: {
      sBTC: {
        underlying: '比特幣主網的原生資產，以工作量證明挖礦產生。',
        carbonSource: 'Cambridge CBECI — 2025 Digital Mining Industry Report',
        carbonCaveat: '絕對年排放量約 39.8 Mt CO2e，與一個中等國家的全年排放量相當；絕對基準，不與股票的營收基準同尺度。',
      },
      sETH: {
        underlying: '以太坊主網的原生資產，2022 年合併後改為權益證明。',
        carbonSource: 'Cambridge — 2026 Ethereum climate-footprint report',
        carbonCaveat: '權益證明後絕對年排放量約 2,370 tCO2e，比本表中任一家公司的 Scope 1 都小；絕對基準，不與股票同尺度。',
      },
      sAAPL: {
        underlying: '在 NASDAQ 掛牌的 Apple Inc. 普通股。',
        carbonSource: 'Apple Environmental Progress Report 2024（經 Tracenable）· FY2024',
        carbonCaveat: 'Scope 1+2（市場法），不含 Scope 3；對 Apple 而言 Scope 3 是 Scope 1+2 的十餘倍。',
      },
      sTSLA: {
        underlying: '在 NASDAQ 掛牌的 Tesla, Inc. 普通股。',
        carbonSource: 'Tesla Impact Report 2024（經 Tracenable）· FY2024',
        carbonCaveat: 'Scope 1+2（市場法），不含 Scope 3。',
      },
      sGOLD: {
        underlying: 'COMEX 黃金近月期貨結算的現貨黃金價格（XAU/USD）。',
        carbonSource: 'S&P Global Market Intelligence — Greenhouse gas and gold mines',
        carbonCaveat: '0.85 tCO2e／盎司（2019 全球平均開採排放），產業年排放超過 100 Mt CO2e；每盎司基準，不與股票的營收基準同尺度。',
      },
      sBOND: {
        underlying: '在 NASDAQ 掛牌的 iShares USD Green Bond ETF（BGRN），持有依 Green Bond Principles 篩選的投資等級綠色債券。',
        carbonSource: 'iShares BGRN Fact Sheet + 持股揭露',
        carbonCaveat: '定性判為低碳——投資等級綠色債券基金依 Green Bond Principles 的准入標準，結構性地低於未篩選的債券指數（比照 sICLN）。逐檔避免排放量的真數字需自 BGRN Impact Report 取得（發行方 host 對自動抓取回 403，待真人下載，見碳資料表）。',
      },
      sNVDA: {
        underlying: '在 NASDAQ 掛牌的 NVIDIA Corporation 普通股。',
        carbonSource: 'NVIDIA Sustainability Report 2025（經 Tracenable）· FY2025',
        carbonCaveat: 'Scope 2（市場法）為零，是 100% 再生能源憑證／PPA 採購的結果，不代表資料中心實體用電為零；不含 Scope 3。',
      },
      sMSFT: {
        underlying: '在 NASDAQ 掛牌的 Microsoft Corporation 普通股。',
        carbonSource: 'Microsoft 2025 Environmental Sustainability Report（經 DitchCarbon 交叉核對）· FY2025',
        carbonCaveat: 'Scope 1+2（市場法），不含 Scope 3。',
      },
      sGOOGL: {
        underlying: '在 NASDAQ 掛牌的 Alphabet Inc. Class A 普通股。',
        carbonSource: 'Alphabet Environmental Report 2025（涵蓋 FY2024，經 Tracenable）',
        carbonCaveat: 'Scope 1+2（市場法），不含 Scope 3。',
      },
      sICLN: {
        underlying: 'iShares Global Clean Energy ETF，持有全球再生能源發電與設備公司。',
        carbonSource: 'iShares ICLN Fact Sheet + 持股（stockanalysis.com）',
        carbonCaveat: '依前十大持股的產業組成質性判為低碳，非逐檔碳強度計算。',
      },
      sESGU: {
        underlying: 'iShares ESG Aware MSCI USA ETF，經 ESG 篩選的美國大型股組合。',
        carbonSource: 'iShares ESGU Fact Sheet + 持股（stockanalysis.com）',
        carbonCaveat: '僅約 24% 持股涵蓋率的加權部分估計，其餘約 76% 未反映，可能顯著改變此數字。',
      },
    },
  },

  /** issue #100 ③：誰提供價格、誰見證碳資料、誰營運儲備、誰稽核程式。 */
  who: {
    title: '誰負責什麼',
    intro: 'RWA 的價值在於知道誰在線上。匿名是加密的價值，不是 RWA 的。',
    priceRole: '價格',
    priceWho: 'keeper 從 CoinGecko／Yahoo Finance 取價，寫進 GuardedOracle（多 keeper、單次偏差上限）。過期報價不寫上鏈。',
    carbonRole: '碳資料見證',
    carbonWho: '碳強度取自發行方的公開申報（永續報告、10-K），來源網址與擷取日期記錄於 docs/data/carbon-intensity.md。',
    reserveRole: '儲備營運',
    reserveWho: 'AssetVault 營運方持有 USDC 儲備；儲備率由 keeper 定期寫成鏈上觀測事件，跌破門檻自動暫停鑄造。',
    auditRole: '程式稽核',
    auditWho: '合約經逐次稽核，修補紀錄見 docs/；所有部署位址可在區塊瀏覽器查證。',
    disclosureTitle: '誠實聲明',
    disclosure: 'demo 中的碳見證由專案團隊自行安排，尚非機構獨立性。多方見證與歧見可見減輕但不解決「資料本身是否屬實」。',
  },

  /** #36：四段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    diffNoteBefore: '兩套實作並存於鏈上，V1 保留作為對照組。詳見 ',
    diffNoteMid: ' 與',
    diffNoteAfter: '。',

    introBefore: '本頁展示',
    introBold1: '代幣化資產（ERC-20）',
    introMid1: '。與交易頁的合成持倉不同，這裡買入的資產會以 ERC-20 token 形式',
    /**
     * SHOW_PERPETUALS 關閉時的版本。原句拿「交易頁的合成持倉」當對照，但旗標關著
     * 的時候那個東西在畫面上不存在——用一個看不到的概念解釋看得到的概念，只會讓
     * 讀的人去找它。
     */
    introMid1Spot: '。買入的資產會以 ERC-20 token 形式',
    introBold2: '出現在你的錢包中',
    introMid2: '，可加入 MetaMask 檢視、可轉帳給他人。 買賣以 ',
    introAfter: ' 結算，價格取自鏈上 oracle（無滑價）。',

    /** #99：ratioIsStale() 的讀者。買入因此暫停——過期的資產會被
     *  outstandingValueDetailed() 排除在負債之外，讓儲備率（連帶 mintingHalted
     *  的觸發條件）比實際樂觀，所以擋的是「整個金庫」的買入，不只是那一項過期
     *  的資產。賣出不受影響：個別資產若自己的價格過期，redeem 送出時會被合約
     *  以 StalePrice 擋下，走的是另一條路徑，與這裡的儲備率無關。 */
    staleRatioBold: '儲備率無法確認',
    staleRatioBody:
      '——至少一項已發行資產的價格已過期，儲備率的計算會低估負債、讀起來比實際樂觀。上方數字在有新報價之前不代表金庫是否足額——買入已暫停以策安全。贖回不受影響：無關資產的過期價格不該擋住你賣出。',

    /** #99：AssetVaultV2_3 observeReserve() 鎖存的破線狀態，只擋新的 mint。 */
    mintingHaltedBold: '鑄造已暫停',
    mintingHaltedBody:
      '——鏈上觀測到儲備率跌破門檻（市場價格波動即可觸發，不代表有人操作）。新的買入已暫停，直到下一次觀測顯示已恢復。贖回不受影響，任何時候都可以賣出。',

    vaultDryBefore: '提示：賣出由金庫的 USDC 儲備支付。若儲備不足會顯示「vault dry」， 需由管理者呼叫 ',
    vaultDryAfter: ' 補充。',
  },
};
