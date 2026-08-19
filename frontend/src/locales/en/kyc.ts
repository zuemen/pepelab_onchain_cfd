import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/kyc.ts`。
 */
export const kyc: Catalog['kyc'] = {
  title: 'Submit KYC Application',
  titleAwaitingReview: 'KYC Application Under Review',
  subtitle: 'Trading stock / bond synthetic assets requires KYC review',
  closeAria: 'Close',

  /** 這個視窗最重要的一句話：送出 ≠ 通過，所以兩種狀態各自是完整的一段。 */
  noticeTitle: 'This is "submitting an application," not instant approval',
  noticeTitleAwaitingReview: '✅ Application submitted, awaiting review',
  noticeBody:
    "Submitting leaves a pending application on-chain (KYCSubmitted) — approval only happens once a reviewer calls approveKYC. You still can't trade regulated assets before it's approved.",
  noticeBodyAwaitingReview:
    'Your KYC application is recorded on-chain (KYCSubmitted). Regulated assets unlock once a reviewer approves it (approveKYC); until then, the contract still blocks your orders (NotKycVerified). You can close this dialog now and come back later — refresh to check the status.',

  demoTitle: 'Demo KYC — no real personal data is stored',
  demoBody:
    "This is an academic demo system. The name and nationality you enter are stored on the smart contract purely as a proof-of-concept — don't enter real personal information.",

  nameLabel: 'Name (for demo purposes)',
  namePlaceholder: 'e.g. Demo User',
  nameRequired: 'Enter a name',
  nationalityLabel: 'Nationality',
  /** 下拉選項是「代號 — 國名」。代號是資料，國名是文字。 */
  nationalityOption: '{code} — {name}',

  cancel: 'Cancel',
  close: 'Close',
  submit: 'Submit KYC Application',
  submitting: 'Submitting…',

  country: {
    TW: 'Taiwan',
    US: 'United States',
    JP: 'Japan',
    KR: 'South Korea',
    HK: 'Hong Kong',
    SG: 'Singapore',
    GB: 'United Kingdom',
    DE: 'Germany',
    FR: 'France',
    CA: 'Canada',
    AU: 'Australia',
    NZ: 'New Zealand',
    CH: 'Switzerland',
    SE: 'Sweden',
    NL: 'Netherlands',
    BE: 'Belgium',
    IT: 'Italy',
    ES: 'Spain',
    PT: 'Portugal',
    AT: 'Austria',
    DK: 'Denmark',
    NO: 'Norway',
    FI: 'Finland',
    IE: 'Ireland',
    CN: 'China',
    IN: 'India',
    BR: 'Brazil',
    MX: 'Mexico',
    TH: 'Thailand',
    MY: 'Malaysia',
    ID: 'Indonesia',
    PH: 'Philippines',
    VN: 'Vietnam',
    PL: 'Poland',
    CZ: 'Czech Republic',
    IL: 'Israel',
    ZA: 'South Africa',
    AE: 'United Arab Emirates',
    SA: 'Saudi Arabia',
    OTHER: 'Other',
  },
};
