import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/investorVc.ts`。
 */
export const investorVc: Catalog['investorVc'] = {
  pageTitle: 'Investor credentials',
  title: 'Qualified-investor credential',
  typeLabel: {
    KYC_BASIC: 'Basic KYC',
    QUALIFIED_INVESTOR: 'Qualified investor',
  },
  disabled: 'Credential-based access is not enabled on this deployment. RWA market eligibility is still reviewed by the existing KYC process.',
  checking: 'Checking whether this deployment\'s KYC registry is a credential-based (VC) registry…',
  probeFailed: 'Could not determine this deployment\'s KYC registry type (RPC read failed). Please refresh later.',
  goToCredential: 'Get access with a qualified-investor credential',
  connectWallet: 'Connect your wallet to determine this deployment\'s KYC registry type.',
  checkingShort: 'Checking KYC method…',
  unknownRetry: 'Could not determine the KYC method — retry',
  intro:
    'Opening RWA markets (e.g. sAAPL) requires a valid qualified-investor status. Upload the verifiable credential (VC) your issuing institution gave you, verify it, then register it on-chain. The chain only stores your address, the credential type, its expiry and a hash of the credential — no personal data.',
  mineVerified: 'Your wallet is eligible for RWA markets (requires: {type}); credential expires {date}',
  mineNotVerified: 'Your wallet has no valid RWA market eligibility (requires: {type}; not registered, expired or revoked).',
  upload: 'Upload VC file',
  verify: 'Verify locally',
  pasteLabel: 'Or paste the credential JSON',
  invalid: 'Credential rejected ({code}): {reason}',
  chainReadFailed: 'Could not read the on-chain registry: {reason}',
  submitFailed: 'Submission failed: {reason}',
  chip: {
    signatureOk: 'Signature valid',
    active: 'Not revoked',
    revoked: 'Revoked',
    unknown: 'Revocation status unknown',
    issuerTrusted: 'Issuer trusted',
    issuerUntrusted: 'Issuer not trusted',
  },
  holder: 'Holder: {address}',
  issuer: 'Issuer: {address}',
  validity: 'Valid {from} → {to} (submit by {deadline})',
  submit: 'Submit attestation on-chain',
  submitting: 'Submitting…',
  tx: 'Transaction: {hash}',
  status: {
    notJson: 'Not valid JSON',
    listInvalid: 'Status list rejected ({code}): {reason}',
    revoked: 'The issuer has revoked this credential (list sequence {sequence})',
    active: 'Status list sequence {sequence}: not revoked',
    noList: 'The issuer has not published a status list (nothing revoked)',
    noStatus: 'The VC has no usable credentialStatus',
    badUrl: 'Status list URL not allowed (https or localhost only): {url}',
    httpError: 'Could not read the status list: HTTP {status}',
    tooLarge: 'Status list too large',
    fetchFailed: 'Could not read the status list: {reason}',
  },
  blocker: {
    wrongChain: 'Switch to chainId {chainId}',
    untrusted: 'The issuer is not trusted by this registry (the contract would revert with UntrustedIssuer)',
    revokedOnChain: 'This credential has been revoked on-chain',
    submitted: 'This credential is already registered',
    nonce: 'Credential nonce ({vc}) does not match the on-chain value ({chain}); ask the issuer to re-issue',
    deadline: 'Submission deadline passed; ask the issuer to re-issue',
  },
};
