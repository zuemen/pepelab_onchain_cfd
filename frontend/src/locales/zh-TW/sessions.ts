/**
 * AI Agent Sessions：委派一把有界的 session key 給 agent。
 *
 * 匯出的 MCP 設定裡那句提示是例外：它是 JSON 值，會被整段複製進別人的
 * 設定檔，但它本身是給人讀的句子而不是語法，所以進 catalog。
 */
export const sessions = {
  title: '🤖 AI Agent 委任',
  viewOn: '在 {explorer} 查看 ↗',

  ssi: {
    title: 'SSI 三角：你的錢包就是信任根',
    flow: '流程：連錢包 → 設限額建 session → 簽發授權 VC → 一鍵匯出 agent 設定 → 之後只下口頭交易意圖。',
  },

  wrongNetwork: {
    title: '請切換到 Base Sepolia（chainId 84532）',
    unknownChain: '未知網路',
  },

  create: {
    title: '建立 Session',
    agentAddress: 'Agent 地址（session key）',
    agentPlaceholder: '0x… 或按右側「產生 agent 金鑰」',
    generateKey: '產生 agent 金鑰',
    maxPerTrade: '單筆上限（USDC）',
    totalBudget: '總預算（USDC）',
    maxLeverage: '最大槓桿',
    validFor: '有效期限（小時）',
    creating: '建立中…',
    cta: '建立 Session',
    done: 'Session 已建立 ✓',
    allowedAssets: '允許交易的標的',
    allowedAssetsHint: 'agent 只能在這些標的上開倉（鏈上白名單，createSessionWithAssets）。至少選一檔。',
    noAssetSelected: '請至少選擇一檔允許交易的標的。',
  },

  /** 瀏覽器裡產生的一次性 burner 金鑰。 */
  key: {
    title: '🔑 你的 agent 專用金鑰（burner）',
    clear: '清除',
    addressChip: '地址（會上鏈授權）',
    privateKeyChip: '私鑰（只放本機）',
    /** 私鑰被遮住時，圓點後面接的那一段字。 */
    hiddenSuffix: ' （已隱藏）',
    reveal: '顯示',
    hide: '隱藏',
    copy: '複製',
    copyAddressLabel: 'Agent 地址',
    copyPrivateKeyLabel: 'Agent 私鑰',
    generated: '已產生 agent 專用金鑰（只在本機瀏覽器，請立即保存）',
  },

  list: {
    title: '我的 Session',
    refresh: '↺ 重新整理',
    loading: '載入中…',
    empty: '尚無 session。建立一個來授權 agent。',

    column: {
      id: '#',
      agent: 'Agent',
      spent: '花費 / 預算',
      maxPerTrade: '單筆上限',
      leverage: '槓桿',
      expiry: '到期',
      status: '狀態',
      credential: '憑證',
    },

    status: {
      revoked: '已撤銷',
      expired: '已過期',
      active: '進行中',
    },

    issued: '已核發 ✓',
    export: '匯出 ⤓',
    issueVc: '核發 VC',
    signing: '簽署中…',
    issueVcHint: 'MetaMask 簽發授權 VC',
    issueVcNeedsWallet: '需真實錢包簽署（mock 模式不支援）',
    revoke: '撤銷',
    revoked: 'Session 已撤銷 ✓',
    credentialIssued: '憑證已核發 ✓',
    needsRealWallet: '需連接真實錢包以簽署 VC（mock 模式不支援簽章）',
    vcExpires: 'VC 到期 {date}',
    vcExpired: 'VC 已過期，請重新簽發',
    vcValidity: 'VC 效期（天）',
    vcValidityHint: '新簽發的憑證在這麼多天後到期，且不會晚於 session 到期（預設 {days} 天）。',
  },

  /** 匯出對話框。 */
  export: {
    title: '🔌 連接你的 Agent — Session #{id}',
    close: '關閉',
    closeAria: '關閉',
    intro:
      '把以下兩份貼進你本機的 agent client，之後只需下「口頭交易意圖」，agent 會在 session 限額內憑 VC 代你下單：',

    mcpTitle: 'MCP 設定（Claude Desktop / Code）',
    vcTitle: '授權 VC（下單驗證用）',
    copy: '複製',
    download: '下載 .json',
    copyMcpLabel: 'MCP 設定',
    copyVcLabel: '授權 VC',

    /** 匯出的 MCP 設定裡，私鑰欄位的預設佔位提示。 */
    privateKeyPlaceholder: '0x...   # 貼上你剛產生/保存的 agent 私鑰（放本機，勿外流）',
  },

  copied: '{label} 已複製 ✓',
  copyFailed: '複製失敗（瀏覽器剪貼簿權限）',

  /** v3 委託授權憑證（W3C VC 2.0＋x402 額度＋鏈上錨定），docs/SSI_AGENT_DELEGATION.md。 */
  delegation: {
    open: '委託憑證 v3',
    title: '委託授權憑證 v3（W3C VC 2.0）',
    intro:
      '把這個 session 的額度、資產白名單與 x402 付費上限簽成一張可驗證憑證，再錨定到鏈上：付費 API 就能確認「誰授權了這個代理人、授權到哪裡」（Know Your Agent）。',
    agentDid: '代理人 DID（holder）',
    issuerDid: '簽發者 DID（你）',
    sessionTerms: 'Session 額度（與鏈上逐欄一致）',
    assetsAll: '不限資產',
    assetsCount: '{n} 種資產',
    x402Title: 'x402 付費上限',
    perPeriod: '每期間上限（USDC）',
    periodHours: '期間（小時）',
    total: '總額上限（USDC）',
    endpoints: '允許的付費端點',
    validityDays: '憑證有效天數',
    issue: '以錢包簽發 v3',
    signing: '簽署中…',
    anchor: '錨定到鏈上',
    anchoring: '錨定中…',
    anchored: '已錨定',
    notAnchored: '未錨定',
    superseded: '已被新憑證取代',
    anchorNotDeployed: '這條鏈尚未部署 SessionCredentialAnchor：可以簽發，但無法錨定（啟用錨定要求的付費 API 會拒絕）。',
    statusTitle: '狀態',
    statusActive: '有效',
    statusRevoked: '已撤銷（狀態清單）',
    statusExpired: '已過期',
    statusSessionRevoked: '鏈上 session 已撤銷',
    credentialHash: '憑證雜湊（錨定值）',
    spendTitle: 'x402 花費（signal-api 依憑證累計）',
    spendTotal: '總額 {spent} / {cap} USDC',
    spendPeriod: '本期 {spent} / {cap} USDC',
    spendUnavailable: 'signal-api 未啟用 KYA，或還沒有花費紀錄。',
    showJson: '檢視憑證 JSON',
    hideJson: '收起 JSON',
    download: '下載憑證 .json',
    revoke: '撤銷這張憑證',
    revoking: '撤銷中…',
    revokedDownloaded: '已簽好撤銷清單（sequence {seq}），但尚未確認發佈（已下載）；請交給營運方發佈（npm run vc-status install），發佈後按「確認已發佈」。在那之前憑證仍有效。',
    revokedPublished: '已簽好撤銷清單（sequence {seq}），並確認已發佈到狀態清單目錄。',
    revokeBaseUnavailable:
      '無法取得目前已發佈的狀態清單（{reason}），所以沒有簽署：撤銷清單必須接在已發佈的那份之後，否則驗證端會拒收、撤銷不會生效。請設定 VITE_VC_STATUS_URL，或匯入目前的清單後再試。',
    statusRevokePending: '撤銷待發佈（sequence {seq}，尚未生效）',
    revokePendingNote: '撤銷清單已簽好，但還沒確認發佈：在驗證端看到新清單之前，這張憑證仍然有效。要立即擋下付費 API，可以先「解除錨定」。',
    revokeAgain: '重新簽署撤銷清單',
    confirmPublished: '確認已發佈',
    confirmingPublished: '確認中…',
    revocationConfirmed: '已在狀態清單目錄確認撤銷，憑證已失效。',
    revocationNotYetPublished: '狀態清單目錄還沒有這筆撤銷，憑證仍然有效。',
    importHint: '讀不到已發佈的狀態清單（需要設定 VITE_VC_STATUS_URL，且狀態主機要開放 CORS 讓本站讀取）。可以匯入目前發佈中的那一份（.json），撤銷會接在它之後；若從來沒有發佈過，請明確確認後以 sequence 1 簽署。',
    confirmNoList: '目前沒有任何已發佈的清單（第一次撤銷）',
    confirmNoListPrompt:
      '讀不到已發佈的狀態清單（{reason}）。確定這個簽發者從來沒有發佈過狀態清單？撤銷會以 sequence 1 簽出。若其實已有發佈中的清單，驗證端會拒收這份，撤銷不會生效——不確定時請改用匯入。',
    importList: '匯入目前的狀態清單',
    importedList: '已匯入 sequence {seq}',
    importFailed: '匯入失敗：{reason}',
    unanchor: '解除錨定',
    unanchoring: '解除中…',
    unanchoredToast: '已解除錨定：要求錨定的付費 API 會立即拒收這張憑證',
    anchorProblem: {
      anchor_no_code: '設定的錨定位址在這條鏈上沒有合約，交易不會送出。',
      anchor_wrong_manager: '錨定合約綁定的 session manager 與這張憑證不同，交易不會送出。',
      anchor_unreadable: '無法讀取錨定合約，交易不會送出。',
    },
    revokeWithSession: '同時撤銷這個 session 的 v3 委託憑證？會再請錢包簽一次狀態清單。',
    issuedToast: 'v3 委託憑證已簽發',
    anchoredToast: '憑證已錨定到鏈上',
    close: '關閉',
    formError: {
      bad_usdc: 'USDC 金額格式不正確（最多 6 位小數）',
      bad_period: '期間必須大於 0 小時',
      period_over_total: '每期間上限不可大於總額上限',
      no_endpoints: '至少要允許一個付費端點',
      session_expired: 'session 已到期，無法簽發',
    },
  },

  sessionManager: 'AgentSessionManager: {address}',

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** #36：十段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    introBefore:
      '委派一把有界 session key 給 agent：限單筆保證金、總預算、最大槓桿與到期。 Agent 只能在限額內經 AgentSessionManager 代你開/平倉，永不持有你的主錢包私鑰。 每個 agent 具 ',
    introMid: ' 身分，授權可憑證化為 ',
    introAfter: ' 供下單前驗簽 （SSI / 可驗證自主交易，見 docs/AGENT_IDENTITY_VC_SSI.md）。',

    roleIssuerBefore: '🖊️ ',
    roleIssuerBold: 'Issuer＝你',
    roleIssuerAfter: '：用 MetaMask 簽發授權 VC（私鑰不離開錢包）',
    roleHolderBefore: '🤖 ',
    roleHolderBold: 'Holder＝agent',
    roleHolderAfter: '：持 VC + session key 代你下單',
    roleVerifierBefore: '✅ ',
    roleVerifierBold: 'Verifier＝MCP/合約',
    roleVerifierAfter: '：下單前驗簽 + 鏈上 session 交叉比對',

    wrongNetBefore: 'AI Agent Sessions 部署在 ',
    wrongNetMid: ' 測試網。你目前連到的是',
    wrongNetAfter: '，請在 MetaMask 切換到 Base Sepolia 後重整本頁。',

    keyNoteBold1: 'agent 用一把獨立的 session key，不是你的主錢包',
    keyNoteMid1: '：',
    keyNoteBold2: '地址',
    keyNoteMid2: ' → 拿來授權下面這個 session；',
    keyNoteBold3: '私鑰',
    keyNoteAfter:
      ' → 放進 agent 的 MCP 設定 + 一點 ETH 付 gas。 沒有現成的就按「產生 agent 金鑰」在瀏覽器產生一把全新 burner。',

    burnerWarnBefore: '這是一把獨立的 burner 金鑰，只受你下面設的 session 限額拘束。請存到本機 agent 設定，',
    burnerWarnBold: '別放主錢包資產',
    burnerWarnAfter: '。本頁只顯示這一次，且不會上傳或寫入伺服器。',

    step1Before: '把 ',
    step1Bold: 'MCP 設定',
    step1Mid1: '貼進 Claude Desktop/Code 的 ',
    step1Mid2: '，並把 ',
    step1After: ' 換成你本機 agent 的 session key。',
    step2Before: '把 ',
    step2Bold: '授權 VC',
    step2Mid1: '存成檔案，agent 下單時以 ',
    step2Mid2: ' 指向它（或 MCP ',
    step2Mid3: ' 的 ',
    step2After: '）。',
    step3: '完成後直接對 agent 說：「幫我用 3x 槓桿做多 sBTC、保證金 200」即可，無需再報帳號/位址。',

    addrKeyBold1: '地址',
    addrKeyMid1: '（',
    addrKeyMid2: '）＝已上鏈授權的 agent，放在 session / VC 裡；',
    addrKeyBold2: '私鑰',
    addrKeyAfter: '＝對應這個地址、只放本機 agent 設定的 ',
    addrKeyTail: '。兩者是同一把 key 的公開/秘密兩面。',

    includeKeyBefore: '把我剛產生的 agent 私鑰填進 ',
    includeKeyAfter: '（含真鑰，請只在自己機器使用）',
    /** 嵌入私鑰的風險說明：預設不嵌入，勾選前後都看得到。 */
    includeKeyRiskTitle: '預設不嵌入私鑰',
    includeKeyRisk:
      '匯出的設定檔預設只放佔位字串。勾選後，下方 JSON 會含這把 agent 的明文私鑰：任何拿到這個檔案（或看到你螢幕、剪貼簿、雲端同步資料夾）的人，都能在 session 的額度與期限內以你的授權下單。只在你自己的機器上使用，不要貼進聊天、工單或版本控制；外流時請立即撤銷 session。',
    includeKeyOnWarning: '目前的設定檔含明文私鑰。複製或下載後請妥善保管，用完即刪。',

    placeholderAfter:
      ' 為佔位 — 貼上你保存的 agent 私鑰即可（在本頁用「產生 agent 金鑰」產生的，可勾選自動填入）。',

    finalWarnBefore: 'agent 私鑰只放你本機的 agent 設定，',
    finalWarnBold1: '勿外流',
    finalWarnMid1: '。私鑰只存在你瀏覽器記憶體（不寫伺服器、不入庫）； 預設匯出的 ',
    finalWarnMid2: ' 為佔位字串，只有你',
    finalWarnBold2: '明確勾選「填入私鑰」',
    finalWarnAfter: '時才會含真鑰——此時請勿把這份 JSON 貼到任何他人/公開處。',
  },
};
