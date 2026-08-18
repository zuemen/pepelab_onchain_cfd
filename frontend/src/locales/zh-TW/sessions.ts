/**
 * AI Agent Sessions：委派一把有界的 session key 給 agent。
 *
 * 這一頁的解說文字幾乎全部在句中夾 `<b>` 或 `<code>`（SSI 三角、地址 vs 私鑰、
 * 匯出步驟、私鑰警告），那十段留在原地交給 #36。搬進來的是標題、表單、表格、
 * 按鈕與 toast——也就是使用者操作時真的會按到的字。
 *
 * 匯出的 MCP 設定裡那句提示是例外中的例外：它是 JSON 值，會被整段複製進別人的
 * 設定檔，但它本身是給人讀的句子而不是語法，所以進 catalog。
 */
export const sessions = {
  title: '🤖 AI Agent Sessions',
  viewOn: 'View on {explorer} ↗',

  ssi: {
    title: 'SSI 三角：你的錢包就是信任根',
    flow: '流程：連錢包 → 設限額建 session → 簽發授權 VC → 一鍵匯出 agent 設定 → 之後只下口頭交易意圖。',
  },

  wrongNetwork: {
    title: '請切換到 Base Sepolia（chainId 84532）',
    unknownChain: '未知網路',
  },

  create: {
    title: 'Create Session',
    agentAddress: 'Agent address (session key)',
    agentPlaceholder: '0x… 或按右側 Generate agent key',
    generateKey: 'Generate agent key',
    maxPerTrade: 'Max / trade (mUSDC)',
    totalBudget: 'Total budget (mUSDC)',
    maxLeverage: 'Max leverage',
    validFor: 'Valid for (hours)',
    creating: 'Creating…',
    cta: 'Create Session',
    done: 'Session created ✓',
  },

  /** 瀏覽器裡產生的一次性 burner 金鑰。 */
  key: {
    title: '🔑 你的 agent 專用金鑰（burner）',
    clear: '清除',
    addressChip: '地址（會上鏈授權）',
    privateKeyChip: '私鑰（只放本機）',
    /** 私鑰被遮住時，圓點後面接的那一段字。 */
    hiddenSuffix: ' （已隱藏）',
    reveal: 'Reveal',
    hide: 'Hide',
    copy: 'Copy',
    copyAddressLabel: 'Agent address',
    copyPrivateKeyLabel: 'Agent private key',
    generated: '已產生 agent 專用金鑰（只在本機瀏覽器，請立即保存）',
  },

  list: {
    title: 'My Sessions',
    refresh: '↺ Refresh',
    loading: 'Loading…',
    empty: '尚無 session。建立一個來授權 agent。',

    column: {
      id: '#',
      agent: 'Agent',
      spent: 'Spent / Budget',
      maxPerTrade: 'Max/trade',
      leverage: 'Lev',
      expiry: 'Expiry',
      status: 'Status',
      credential: 'Credential',
    },

    status: {
      revoked: 'Revoked',
      expired: 'Expired',
      active: 'Active',
    },

    issued: 'Issued ✓',
    export: 'Export ⤓',
    issueVc: 'Issue VC',
    signing: 'Signing…',
    issueVcHint: 'MetaMask 簽發授權 VC',
    issueVcNeedsWallet: '需真實錢包簽署（mock 模式不支援）',
    revoke: 'Revoke',
    revoked: 'Session revoked ✓',
    credentialIssued: 'Credential issued ✓',
    needsRealWallet: '需連接真實錢包以簽署 VC（mock 模式不支援簽章）',
  },

  /** 匯出對話框。 */
  export: {
    title: '🔌 Connect your Agent — Session #{id}',
    close: 'Close',
    closeAria: 'close',
    intro:
      '把以下兩份貼進你本機的 agent client，之後只需下「口頭交易意圖」，agent 會在 session 限額內憑 VC 代你下單：',

    mcpTitle: 'MCP 設定（Claude Desktop / Code）',
    vcTitle: '授權 VC（下單驗證用）',
    copy: 'Copy',
    download: 'Download .json',
    copyMcpLabel: 'MCP config',
    copyVcLabel: 'Authorization VC',

    /** 匯出的 MCP 設定裡，私鑰欄位的預設佔位提示。 */
    privateKeyPlaceholder: '0x...   # 貼上你剛產生/保存的 agent 私鑰（放本機，勿外流）',
  },

  copied: '{label} copied ✓',
  copyFailed: '複製失敗（瀏覽器剪貼簿權限）',

  sessionManager: 'AgentSessionManager: {address}',

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',
};
