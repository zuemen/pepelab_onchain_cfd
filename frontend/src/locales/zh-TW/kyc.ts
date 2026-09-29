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

  demoTitle: '⚠️ 這是學術展示系統',
  demoBody:
    '這不是真的合規流程。送出時姓名與國籍不會以明文上鏈：前端會產生隨機 salt，只把 keccak256(salt ‖ 姓名) 與 keccak256(salt ‖ 國籍) 兩個雜湊寫進公開合約。salt 與原始資料只留在你這一端，審核員需要你線下出示才能比對。仍建議填假名。',

  nameLabel: '姓名（只以加鹽雜湊上鏈，建議填假名）',
  namePlaceholder: '例如：路人甲',
  nameRequired: '請輸入姓名',
  nationalityLabel: '國籍',
  /** 下拉選項是「代號 — 國名」。代號是資料，國名是文字。 */
  nationalityOption: '{code} — {name}',

  /** 揭露：舊版把明文寫上鏈，那些資料刪不掉。 */
  legacyPlaintextNotice:
    '注意：在這次更新之前送出的 KYC 申請，姓名與國籍是以明文寫進公開的區塊鏈，這些舊資料已永久公開、無法刪除。',

  /** 送出後顯示的使用者端收據。salt 只存在使用者這一端。 */
  receipt: {
    title: '請保存以下資料（審核時需要出示）',
    savedLocally:
      '姓名與國籍只以加鹽雜湊上鏈。salt 與兩個雜湊已存在這台瀏覽器的本機儲存空間（不含姓名與國籍明文），但清除網站資料就會消失——請另外抄下或截圖保存。遺失 salt 將無法向審核員證明雜湊對應的內容。',
    notSaved:
      '姓名與國籍只以加鹽雜湊上鏈。這台瀏覽器無法寫入本機儲存空間，請立刻抄下以下 salt 與雜湊——關掉視窗後就找不回來。',
    salt: 'Salt（請保密）',
    nameHash: '姓名雜湊（已上鏈）',
    nationalityHash: '國籍雜湊（已上鏈）',
    txHash: '交易 hash',
    /** tx.wait() 失敗但交易已送出：收據保留。 */
    confirmFailed: '交易已送出，但等待確認時發生錯誤——交易可能已經上鏈。收據已保留，請用交易 hash 到區塊瀏覽器確認狀態，確認前不要重送。',
    hideMine: '收起收據',
    viewMineCount: '查看我的收據（{count}）',
    pendingStoredAt: '{time} 送出前保存、但沒有拿到交易 hash 的收據（交易可能沒有送出，請到區塊瀏覽器確認）：',
    storedAt: '這台瀏覽器於 {time} 保存的收據（只有 salt 與雜湊，沒有姓名與國籍明文）：',
    scheme: '雜湊方式：keccak256(salt ‖ 正規化值)；正規化姓名「{name}」，國籍代碼「{code}」。',
  },

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
