/**
 * 合格投資人憑證（VC）→ RWA 市場資格。docs/SSI_RWA_ACCESS.md。
 * 驗證邏輯的原因代碼（VC_BAD_SIGNATURE 等）是穩定鍵，技術細節（reason）維持英文原文。
 */
export const investorVc = {
  pageTitle: '投資人資格憑證',
  title: '合格投資人憑證',
  typeLabel: {
    KYC_BASIC: '基本 KYC',
    QUALIFIED_INVESTOR: '合格投資人',
  },
  disabled: '此部署尚未啟用 VC 准入。RWA 市場的資格仍由現行 KYC 流程審核。',
  intro:
    'RWA 市場（例如 sAAPL）開倉需要有效的合格投資人資格。上傳發證機構給你的憑證（VC），驗證後送上鏈登記。鏈上只記錄地址、類型、到期日與憑證雜湊，不含任何個人資料。',
  mineVerified: '你的錢包已具 RWA 市場資格；合格投資人憑證到期：{date}',
  mineNotVerified: '你的錢包目前沒有有效的 RWA 市場資格（未登記、已到期或已撤銷）。',
  upload: '上傳 VC 檔案',
  verify: '本地驗證',
  pasteLabel: '或貼上憑證 JSON',
  invalid: '憑證驗不過（{code}）：{reason}',
  chainReadFailed: '讀不到鏈上登錄：{reason}',
  submitFailed: '送出失敗：{reason}',
  chip: {
    signatureOk: '簽章有效',
    active: '未撤銷',
    revoked: '已撤銷',
    unknown: '撤銷狀態不明',
    issuerTrusted: '發證者受信任',
    issuerUntrusted: '發證者未受信任',
  },
  holder: '持有人：{address}',
  issuer: '發證者：{address}',
  validity: '有效期：{from} → {to}（送出期限 {deadline}）',
  submit: '送出資格證明上鏈',
  submitting: '送出中…',
  tx: '交易：{hash}',
  status: {
    notJson: '不是合法的 JSON',
    listInvalid: '狀態清單驗不過（{code}）：{reason}',
    revoked: '發證者已撤銷這張憑證（清單 sequence {sequence}）',
    active: '狀態清單 sequence {sequence}：未撤銷',
    noList: '發證者沒有發佈狀態清單（沒有撤銷）',
    noStatus: 'VC 沒有可用的 credentialStatus',
    badUrl: '狀態清單網址不可用（只接受 https 或本機）：{url}',
    httpError: '狀態清單讀取失敗：HTTP {status}',
    tooLarge: '狀態清單過大',
    fetchFailed: '狀態清單讀取失敗：{reason}',
  },
  blocker: {
    wrongChain: '請切換到 chainId {chainId}',
    untrusted: '發證者不在此登錄的受信任清單（合約會以 UntrustedIssuer 拒絕）',
    revokedOnChain: '這張憑證已在鏈上撤銷',
    submitted: '這張憑證已經登記過',
    nonce: '憑證的 nonce（{vc}）不等於鏈上目前值（{chain}），請發證者重新簽發',
    deadline: '已超過送出期限（deadline），請發證者重新簽發',
  },
};
