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

  demoTitle: '⚠️ This is an academic demo',
  demoBody:
    "This is not a real compliance flow. Your name and nationality are NOT written on-chain in plain text: the app generates a random salt and only writes keccak256(salt ‖ name) and keccak256(salt ‖ nationality) to the public contract. The salt and your raw details stay on your side; a reviewer needs you to present them off-chain to compare. A made-up name is still recommended.",

  nameLabel: 'Name (only a salted hash goes on-chain; a made-up name is recommended)',
  namePlaceholder: 'e.g. Jane Doe',
  nameRequired: 'Enter a name',
  nationalityLabel: 'Nationality',
  /** 下拉選項是「代號 — 國名」。代號是資料，國名是文字。 */
  nationalityOption: '{code} — {name}',

  legacyPlaintextNotice:
    'Note: KYC applications submitted before this update wrote the name and nationality to the public blockchain in plain text. That older data is permanently public and cannot be deleted.',

  receipt: {
    title: 'Save the following (you will need it for review)',
    savedLocally:
      "Your name and nationality went on-chain only as salted hashes. The salt and the two hashes (not your name or nationality) are saved in this browser's local storage, but clearing site data will erase them — copy them down or take a screenshot. Without the salt you cannot prove to a reviewer what the hashes contain.",
    notSaved:
      "Your name and nationality went on-chain only as salted hashes. This browser could not write to local storage, so copy the salt and hashes below right now — they cannot be recovered once this dialog is closed.",
    salt: 'Salt (keep private)',
    nameHash: 'Name hash (on-chain)',
    nationalityHash: 'Nationality hash (on-chain)',
    txHash: 'Transaction hash',
    confirmFailed: 'The transaction was sent, but waiting for confirmation failed — it may already be on-chain. The receipt has been kept; check the transaction hash on a block explorer before resubmitting.',
    viewMine: 'View my receipt',
    hideMine: 'Hide receipt',
    storedAt: 'Receipt saved in this browser at {time} (salt and hashes only, no name or nationality):',
    scheme: 'Hash scheme: keccak256(salt ‖ normalized value); normalized name "{name}", nationality code "{code}".',
  },

  cancel: 'Cancel',
  close: 'Close',
  submit: 'Submit KYC Application',
  submitting: 'Submitting…',

  /** See `../zh-TW/kyc.ts` for why this is a separate key group from the modal copy. */
  status: {
    cardTitle: 'KYC Verification Status',
    verifiedTitle: 'Verified',
    verifiedBody: 'You can trade regulated RWA assets (e.g. sAAPL, sTSLA).',
    pendingTitle: 'Under review',
    pendingBody: 'Your application has been submitted and is awaiting reviewer approval — no need to resubmit.',
    unverifiedTitle: 'Not verified',
    unverifiedBody: 'Trading regulated RWA assets (e.g. sAAPL, sTSLA) requires KYC verification first.',
    unverifiedAction: 'Submit KYC Application',
    notRequiredTitle: 'No verification required on this chain',
    notRequiredBody: 'This chain has no KYC gate deployed — no verification is needed to trade any asset.',
    unknownTitle: 'Cannot confirm',
    unknownBody: "Reading your on-chain verification status failed. This doesn't mean you're unverified — please try again.",
    unknownAction: 'Retry',
  },

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
