import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/kyc.ts`。搬移階段逐字複製原文。
 */
export const kyc: Catalog['kyc'] = {
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

  demoTitle: 'Demo KYC — 不會儲存真實個資',
  demoBody:
    '此為學術展示系統。填入的姓名與國籍僅儲存在智能合約上作為 PoC 示範，請勿填入真實個人資訊。',

  nameLabel: '姓名（示範用）',
  namePlaceholder: 'e.g. Demo User',
  nameRequired: '請輸入姓名',
  nationalityLabel: '國籍',
  /** 下拉選項是「代號 — 國名」。代號是資料，國名是文字。 */
  nationalityOption: '{code} — {name}',

  cancel: '取消',
  close: '關閉',
  submit: '送出 KYC 申請',
  submitting: '送出中…',

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
