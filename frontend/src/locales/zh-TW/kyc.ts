/**
 * KYC 申請視窗。
 *
 * 國名整份進 catalog。它們是給人讀的名稱而不是代號——ISO 兩碼（TW、US…）才是
 * 代號，那部分留在元件裡當 key，翻譯的是右邊那一半。
 */
export const kyc = {
  title: '送出 KYC 申請',
  titleAwaitingReview: 'KYC 申請審核中',
  subtitle: '交易股票 / 債券類合成資產需要通過 KYC 審核',
  closeAria: '關閉',

  /** 這個視窗最重要的一句話：送出 ≠ 通過，所以兩種狀態各自是完整的一段。 */
  noticeTitle: '這是「送出申請」，不是即時通過',
  noticeTitleAwaitingReview: '✅ 申請已送出，等待審核',
  noticeBody:
    '送出後會在鏈上留下一筆待審申請（KYCSubmitted），需由審核人員核准（approveKYC）才會通過。核准前仍無法交易受管制標的。',
  noticeBodyAwaitingReview:
    '你的 KYC 申請已上鏈記錄（KYCSubmitted）。審核人員核准（approveKYC）後，受管制標的才會解鎖；在那之前下單仍會被合約擋下（NotKycVerified）。可以先關掉這個視窗，稍後回來重新整理查看狀態。',

  demoTitle: '⚠️ 你填的姓名會永久公開在區塊鏈上',
  demoBody:
    '這是學術展示系統，不是真的合規流程。送出後，姓名與國籍會寫進公開的智能合約，任何人都讀得到、永遠刪不掉。請勿填入真實姓名——填一個假名即可。',

  nameLabel: '姓名（請填假名，會永久公開上鏈）',
  namePlaceholder: '例如：路人甲',
  nameRequired: '請輸入姓名',
  nationalityLabel: '國籍',
  /** 下拉選項是「代號 — 國名」。代號是資料，國名是文字。 */
  nationalityOption: '{code} — {name}',

  cancel: '取消',
  close: '關閉',
  submit: '送出 KYC 申請',
  submitting: '送出中…',

  /**
   * Portfolio 頁常駐的驗證狀態卡。跟 Modal 分開一組 key，因為讀者情境不同：
   * Modal 是「我正要填表」，這裡是「我隨時想知道自己站在哪」——五態每一態
   * 都要給出「發生了什麼」與「接下來能做什麼」，不是同一句話換個顏色。
   */
  status: {
    cardTitle: 'KYC 驗證狀態',
    verifiedTitle: '已通過驗證',
    verifiedBody: '你可以交易受管制的 RWA 標的（如 sAAPL、sTSLA）。',
    pendingTitle: '審核中',
    pendingBody: '申請已送出，正在等待審核員核准，無需重新送出。',
    unverifiedTitle: '尚未驗證',
    unverifiedBody: '交易受管制的 RWA 標的（如 sAAPL、sTSLA）前，需要先通過 KYC 驗證。',
    unverifiedAction: '送出 KYC 申請',
    notRequiredTitle: '此鏈無需驗證',
    notRequiredBody: '目前連線的鏈上沒有部署 KYC 閘門，交易任何標的都不需要驗證。',
    unknownTitle: '無法確認',
    unknownBody: '讀取鏈上驗證狀態失敗，暫時無法確認狀態。這不代表「未通過」，請稍後重試。',
    unknownAction: '重新讀取',
  },

  country: {
    TW: '台灣',
    US: '美國',
    JP: '日本',
    KR: '韓國',
    HK: '香港',
    SG: '新加坡',
    GB: '英國',
    DE: '德國',
    FR: '法國',
    CA: '加拿大',
    AU: '澳大利亞',
    NZ: '紐西蘭',
    CH: '瑞士',
    SE: '瑞典',
    NL: '荷蘭',
    BE: '比利時',
    IT: '義大利',
    ES: '西班牙',
    PT: '葡萄牙',
    AT: '奧地利',
    DK: '丹麥',
    NO: '挪威',
    FI: '芬蘭',
    IE: '愛爾蘭',
    CN: '中國',
    IN: '印度',
    BR: '巴西',
    MX: '墨西哥',
    TH: '泰國',
    MY: '馬來西亞',
    ID: '印尼',
    PH: '菲律賓',
    VN: '越南',
    PL: '波蘭',
    CZ: '捷克',
    IL: '以色列',
    ZA: '南非',
    AE: '阿聯酋',
    SA: '沙烏地阿拉伯',
    OTHER: '其他',
  },
};
