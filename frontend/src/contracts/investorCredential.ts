// Qualified-investor credential (SSI access layer for RWA markets).
// docs/SSI_RWA_ACCESS.md; contract: contracts/src/VCKycRegistry.sol.
//
// Single source of truth for the EIP-712 schema and the JSON document shapes,
// shared (like agentAuth.ts / agentAuthStatus.ts) by the issuer service
// (agent/issuer) and the browser (InvestorCredentialPanel). Pure and
// dependency-free: no ethers, no process.env. Hashing (keccak256 of the VC id)
// is done by the callers, which already depend on ethers.
//
// Deliberate deviation from a full VC proof: the EIP-712 signature covers the
// ATTESTATION (subject, type, credentialHash = keccak256(id), statusListIndex,
// validFrom, validUntil, nonce, deadline), not the whole JSON document. Fields
// outside it — `@context`, `type`, `credentialStatus.statusListCredential`,
// `proof.created` — are NOT signed. Verifiers therefore re-derive the attestation
// from the VC and also check the unsigned fields structurally (VC type must match
// the credential type; the status list URL must be `<base>/<issuer>.json` and the
// status id `<url>#<index>`). A swapped status URL can at worst make a status
// check report "no list"; the on-chain registry stays authoritative.
//
// One signature, two uses:
//   • The VC's `proof.proofValue` IS the issuer's EIP-712 signature over a
//     `QualifiedInvestorAttestation` derived field-by-field from the VC.
//   • The same (attestation, signature) pair is what `VCKycRegistry.submitAttestation`
//     verifies on-chain. Tampering with any VC field changes the recovered signer.
//
// Privacy: nothing personal is signed or put on-chain — only the subject's
// address, a credential type id, a hash of the credential id, timestamps and
// a status-list index. Names, ID numbers and proof of wealth stay with the issuer.
//
// Revocation (ADR-016 model, new primary type as DESIGN_BESU.md §3.4 proposes):
// the issuer signs an `InvestorCredentialStatusList` in the SAME registry domain
// (chainId + registry address), listing revoked credential hashes. The agent
// verifier reuses agent/shared/src/vcStatus.ts's replay-protected state store
// and sources; the on-chain `revoke(credentialHash)` is the authoritative copy
// the exchange gate actually reads.

import {
  canonicalRevokedIds,
  isCanonicalRevokedIds,
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
} from './agentAuthStatus'

export { canonicalRevokedIds, isCanonicalRevokedIds, MAX_STATUS_LIST_ENTRIES, MAX_STATUS_LIST_VALIDITY_SEC }

export const VC_KYC_DOMAIN_NAME = 'PepeLabVCKycRegistry'
export const VC_KYC_DOMAIN_VERSION = '1'

/** keccak256 of the type names — must equal VCKycRegistry.KYC_BASIC / QUALIFIED_INVESTOR. */
export const CREDENTIAL_TYPE_IDS = {
  KYC_BASIC: '0x5679edd703448f3cae0bbe94d1ccad62e106ae11f704469eb39cdcd8163854eb',
  QUALIFIED_INVESTOR: '0x1d53ef05d6dfc0f437fe03110c6f2e811eb59bf28caa3d5bf3cdbd1366c96ac8',
} as const

export type CredentialTypeName = keyof typeof CREDENTIAL_TYPE_IDS

export function credentialTypeName(id: string): CredentialTypeName | null {
  const lc = id.toLowerCase()
  for (const [name, hash] of Object.entries(CREDENTIAL_TYPE_IDS)) {
    if (hash === lc) return name as CredentialTypeName
  }
  return null
}

export const isCredentialTypeName = (v: unknown): v is CredentialTypeName =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(CREDENTIAL_TYPE_IDS, v)

export interface TypedField {
  name: string
  type: string
}

export const ATTESTATION_PRIMARY_TYPE = 'QualifiedInvestorAttestation' as const

/** Field order must match VCKycRegistry.ATTESTATION_TYPEHASH (checked by tests on both sides). */
export const ATTESTATION_TYPES: Record<string, TypedField[]> = {
  QualifiedInvestorAttestation: [
    { name: 'subject', type: 'address' },
    { name: 'credentialType', type: 'bytes32' },
    { name: 'credentialHash', type: 'bytes32' },
    { name: 'statusListIndex', type: 'uint256' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

/** The exact Solidity type string (contracts/src/VCKycRegistry.sol). */
export const ATTESTATION_TYPE_STRING =
  'QualifiedInvestorAttestation(address subject,bytes32 credentialType,bytes32 credentialHash,uint256 statusListIndex,uint64 issuedAt,uint64 expiresAt,uint256 nonce,uint256 deadline)'

export const INVESTOR_STATUS_LIST_PRIMARY_TYPE = 'InvestorCredentialStatusList' as const

export const INVESTOR_STATUS_LIST_TYPES: Record<string, TypedField[]> = {
  InvestorCredentialStatusList: [
    { name: 'issuer', type: 'address' },
    { name: 'sequence', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'revokedBefore', type: 'uint256' },
    { name: 'revoked', type: 'bytes32[]' },
  ],
}

export interface VcKycDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}

export function vcKycDomain(chainId: number, registry: string): VcKycDomain {
  return { name: VC_KYC_DOMAIN_NAME, version: VC_KYC_DOMAIN_VERSION, chainId, verifyingContract: registry }
}

export const investorDid = (chainId: number, address: string): string =>
  `did:pkh:eip155:${chainId}:${address}`

/** Parse did:pkh:eip155:<chainId>:<0x address>. Returns null when malformed (no checksum check here). */
export function parseInvestorDid(did: unknown): { chainId: number; address: string } | null {
  if (typeof did !== 'string') return null
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(did.trim())
  if (!m) return null
  return { chainId: Number(m[1]), address: m[2] }
}

/** Default VC validity and attestation submission window. */
export const DEFAULT_INVESTOR_VC_VALIDITY_DAYS = 365
export const DEFAULT_ATTESTATION_SUBMIT_WINDOW_DAYS = 30

/** Matches VCKycRegistry.MAX_CLOCK_SKEW. */
export const MAX_ATTESTATION_CLOCK_SKEW_SEC = 300

export const INVESTOR_STATUS_TYPE = 'PepeLabInvestorStatusList2026' as const

/** Values are kept JSON-safe: uint256 fields as decimal strings, uint64 timestamps as numbers. */
export interface AttestationValue {
  subject: string
  credentialType: string
  credentialHash: string
  statusListIndex: string
  issuedAt: number
  expiresAt: number
  nonce: string
  deadline: string
}

export interface InvestorCredential {
  '@context': string[]
  id: string
  type: string[]
  issuer: string
  validFrom: string
  validUntil: string
  credentialSubject: {
    id: string
    credentialType: CredentialTypeName
  }
  credentialStatus: {
    id: string
    type: typeof INVESTOR_STATUS_TYPE
    statusPurpose: 'revocation'
    statusListIndex: string
    /** Where the issuer publishes its signed status list (`<base>/<issuer lowercase>.json`). */
    statusListCredential: string
  }
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'assertionMethod'
    verificationMethod: string
    proofValue: string
    eip712Domain: VcKycDomain
    primaryType: typeof ATTESTATION_PRIMARY_TYPE
    /** Fields of the signed attestation that are not otherwise in the VC. */
    attestation: {
      credentialHash: string
      nonce: string
      deadline: string
    }
  }
}

export const VC_CONTEXTS = [
  'https://www.w3.org/ns/credentials/v2',
  'https://w3id.org/security/suites/eip712sig-2021/v1',
]

const isoSec = (sec: number): string => new Date(sec * 1000).toISOString()

/** ISO-8601 → whole unix seconds, or null when unparsable / not on a whole second. */
export function isoToSec(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || ms % 1000 !== 0) return null
  return ms / 1000
}

/** W3C `type` entry per credential type (KYC_BASIC is not a QualifiedInvestorCredential). */
export const VC_TYPE_BY_CREDENTIAL: Record<CredentialTypeName, string> = {
  KYC_BASIC: 'KycBasicCredential',
  QUALIFIED_INVESTOR: 'QualifiedInvestorCredential',
}

export const statusListUrlFor = (baseUrl: string, issuer: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${issuer.toLowerCase()}.json`

/** Inverse of statusListUrlFor: the base URL, or null when `url` is not `<base>/<issuer>.json`. */
export function statusListBaseOf(url: string, issuer: string): string | null {
  const suffix = `/${issuer.toLowerCase()}.json`
  if (!url.endsWith(suffix)) return null
  const base = url.slice(0, -suffix.length)
  return base.length > 0 && !base.endsWith('/') ? base : null
}

export function buildAttestationValue(p: {
  subject: string
  credentialType: CredentialTypeName
  credentialHash: string
  statusListIndex: number | string | bigint
  issuedAt: number
  expiresAt: number
  nonce: number | string | bigint
  deadline: number | string | bigint
}): AttestationValue {
  return {
    subject: p.subject,
    credentialType: CREDENTIAL_TYPE_IDS[p.credentialType],
    credentialHash: p.credentialHash.toLowerCase(),
    statusListIndex: BigInt(p.statusListIndex).toString(),
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    nonce: BigInt(p.nonce).toString(),
    deadline: BigInt(p.deadline).toString(),
  }
}

/** Assemble the W3C VC 2.0 document around an issuer signature over `value`. */
export function assembleInvestorCredential(p: {
  id: string
  issuer: string
  value: AttestationValue
  credentialType: CredentialTypeName
  domain: VcKycDomain
  signature: string
  statusBaseUrl: string
  created?: string
}): InvestorCredential {
  const issuerDid = investorDid(p.domain.chainId, p.issuer)
  const listUrl = statusListUrlFor(p.statusBaseUrl, p.issuer)
  return {
    '@context': [...VC_CONTEXTS],
    id: p.id,
    type: ['VerifiableCredential', VC_TYPE_BY_CREDENTIAL[p.credentialType]],
    issuer: issuerDid,
    validFrom: isoSec(p.value.issuedAt),
    validUntil: isoSec(p.value.expiresAt),
    credentialSubject: {
      id: investorDid(p.domain.chainId, p.value.subject),
      credentialType: p.credentialType,
    },
    credentialStatus: {
      id: `${listUrl}#${p.value.statusListIndex}`,
      type: INVESTOR_STATUS_TYPE,
      statusPurpose: 'revocation',
      statusListIndex: p.value.statusListIndex,
      statusListCredential: listUrl,
    },
    proof: {
      type: 'EthereumEip712Signature2021',
      created: p.created ?? isoSec(p.value.issuedAt),
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue: p.signature,
      eip712Domain: { ...p.domain },
      primaryType: ATTESTATION_PRIMARY_TYPE,
      attestation: {
        credentialHash: p.value.credentialHash,
        nonce: p.value.nonce,
        deadline: p.value.deadline,
      },
    },
  }
}

export type CredentialParse =
  | {
      ok: true
      issuer: string
      domain: VcKycDomain
      value: AttestationValue
      credentialType: CredentialTypeName
      signature: string
    }
  | { ok: false; reason: string }

/**
 * Re-derive (domain, attestation value, signature) from a VC document. Structural
 * only — the caller still has to (1) recover the signer and compare it with
 * `issuer`, and (2) check `value.credentialHash == keccak256(utf8(vc.id))`.
 */
export function attestationFromCredential(doc: unknown): CredentialParse {
  const bad = (reason: string): CredentialParse => ({ ok: false, reason })
  const d = doc as Partial<InvestorCredential> | null
  if (!d || typeof d !== 'object') return bad('not a JSON object')
  if (!Array.isArray(d.type) || !d.type.includes('VerifiableCredential')) {
    return bad('type does not include VerifiableCredential')
  }
  if (!Array.isArray(d['@context']) || d['@context'][0] !== VC_CONTEXTS[0]) {
    return bad('first @context must be the W3C VC 2.0 context')
  }
  if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 256) return bad('missing id (jti)')
  const issuerDid = parseInvestorDid(d.issuer)
  if (!issuerDid) return bad('issuer is not did:pkh:eip155')
  const subjectDid = parseInvestorDid(d.credentialSubject?.id)
  if (!subjectDid) return bad('credentialSubject.id is not did:pkh:eip155')
  const ctype = d.credentialSubject?.credentialType
  if (!isCredentialTypeName(ctype)) return bad('credentialSubject.credentialType is not supported')
  if (!d.type.includes(VC_TYPE_BY_CREDENTIAL[ctype]) || d.type.some((x) => x !== 'VerifiableCredential' && x !== VC_TYPE_BY_CREDENTIAL[ctype])) {
    return bad(`type must be [VerifiableCredential, ${VC_TYPE_BY_CREDENTIAL[ctype]}] for ${ctype}`)
  }
  const issuedAt = isoToSec(d.validFrom)
  const expiresAt = isoToSec(d.validUntil)
  if (issuedAt === null || expiresAt === null) return bad('validFrom/validUntil must be ISO times on whole seconds')
  const p = d.proof
  if (!p || p.type !== 'EthereumEip712Signature2021' || typeof p.proofValue !== 'string') {
    return bad('missing proof or wrong proof.type')
  }
  if (p.primaryType !== ATTESTATION_PRIMARY_TYPE) return bad('wrong proof.primaryType')
  const dom = p.eip712Domain
  if (
    !dom ||
    dom.name !== VC_KYC_DOMAIN_NAME ||
    dom.version !== VC_KYC_DOMAIN_VERSION ||
    typeof dom.chainId !== 'number' ||
    typeof dom.verifyingContract !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(dom.verifyingContract)
  ) {
    return bad('wrong proof.eip712Domain')
  }
  if (issuerDid.chainId !== dom.chainId || subjectDid.chainId !== dom.chainId) {
    return bad('DID chainId differs from eip712Domain.chainId')
  }
  const a = p.attestation
  const st = d.credentialStatus
  if (!a || !/^0x[0-9a-fA-F]{64}$/.test(String(a.credentialHash))) return bad('malformed proof.attestation.credentialHash')
  if (!/^\d{1,78}$/.test(String(a.nonce)) || !/^\d{1,78}$/.test(String(a.deadline))) {
    return bad('proof.attestation.nonce/deadline must be decimal integer strings')
  }
  if (!st || st.type !== INVESTOR_STATUS_TYPE || !/^\d{1,78}$/.test(String(st.statusListIndex))) {
    return bad('malformed credentialStatus')
  }
  // statusListCredential is unsigned: it must at least be `<base>/<issuer lowercase>.json` for THIS issuer,
  // and the status id must point at this credential's index.
  const listUrl = String(st.statusListCredential ?? '')
  const base = statusListBaseOf(listUrl, issuerDid.address)
  if (base === null || statusListUrlFor(base, issuerDid.address) !== listUrl) {
    return bad('credentialStatus.statusListCredential is not <base>/<issuer>.json for this issuer')
  }
  if (st.id !== `${listUrl}#${st.statusListIndex}`) return bad('credentialStatus.id must be <statusListCredential>#<index>')
  const value: AttestationValue = {
    subject: subjectDid.address,
    credentialType: CREDENTIAL_TYPE_IDS[ctype],
    credentialHash: String(a.credentialHash).toLowerCase(),
    statusListIndex: String(st.statusListIndex),
    issuedAt,
    expiresAt,
    nonce: String(a.nonce),
    deadline: String(a.deadline),
  }
  return {
    ok: true,
    issuer: issuerDid.address,
    domain: { ...dom },
    value,
    credentialType: ctype,
    signature: p.proofValue,
  }
}

// ── Status list (ADR-016 structure, investor primary type) ─────────────────

export interface InvestorStatusListFields {
  issuer: string
  sequence: number
  issuedAt: number
  validUntil: number
  revokedBefore: number
  /** Revoked credential hashes (keccak256 of the VC id), canonical: lowercase, strictly ascending. */
  revoked: string[]
}

export interface InvestorStatusList extends Omit<InvestorStatusListFields, 'issuer'> {
  type: ['InvestorCredentialStatusList']
  issuer: string // did:pkh
  proof: {
    type: 'EthereumEip712Signature2021'
    proofValue: string
    eip712Domain: VcKycDomain
  }
}

export function buildInvestorStatusListValue(f: InvestorStatusListFields): Record<string, unknown> {
  return {
    issuer: f.issuer,
    sequence: f.sequence,
    issuedAt: f.issuedAt,
    validUntil: f.validUntil,
    revokedBefore: f.revokedBefore,
    revoked: [...f.revoked],
  }
}

export function assembleInvestorStatusList(
  p: InvestorStatusListFields & { domain: VcKycDomain; signature: string }
): InvestorStatusList {
  return {
    type: ['InvestorCredentialStatusList'],
    issuer: investorDid(p.domain.chainId, p.issuer),
    sequence: p.sequence,
    issuedAt: p.issuedAt,
    validUntil: p.validUntil,
    revokedBefore: p.revokedBefore,
    revoked: [...p.revoked],
    proof: { type: 'EthereumEip712Signature2021', proofValue: p.signature, eip712Domain: { ...p.domain } },
  }
}

// ── Verification (shared by agent and browser; crypto is injected) ──────────
//
// The schema stays dependency-free: callers pass their ethers v6 functions.
// agent/issuer/investorVc.ts and src/lib/pepefi/investorCredentialCheck.ts are
// thin wrappers, so the browser and the issuer service run the SAME checks.

export interface Eip712Crypto {
  /** keccak256(utf8(text)) */
  id(text: string): string
  /** checksum; throws on invalid */
  getAddress(address: string): string
  verifyTypedData(
    domain: VcKycDomain,
    types: Record<string, TypedField[]>,
    value: Record<string, unknown>,
    signature: string
  ): string
  hashTypedData(domain: VcKycDomain, types: Record<string, TypedField[]>, value: Record<string, unknown>): string
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const isSafeUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
/** Same as ADR-016: revokedBefore may lead the list's issuedAt by clock skew + 1 s. */
export const INVESTOR_REVOKE_ALL_LEAD_SEC = MAX_ATTESTATION_CLOCK_SKEW_SEC + 1

export type InvestorVcReason =
  | 'VC_MALFORMED'
  | 'VC_BAD_SIGNATURE'
  | 'VC_HASH_MISMATCH'
  | 'VC_WRONG_DOMAIN'
  | 'VC_EXPIRED'
  | 'VC_ISSUED_IN_FUTURE'
  | 'VC_UNTRUSTED_ISSUER'

export interface VerifiedInvestorCredential {
  valid: true
  issuer: string
  subject: string
  credentialType: CredentialTypeName
  credentialHash: string
  issuedAt: number
  expiresAt: number
  deadline: number
  nonce: string
  domain: VcKycDomain
  value: AttestationValue
  signature: string
  digest: string
}

export type InvestorVcVerifyResult =
  | VerifiedInvestorCredential
  | { valid: false; reasonCode: InvestorVcReason; reason: string }

export interface VerifyInvestorVcOptions {
  /** now, in MILLISECONDS */
  now?: number
  expectedChainId?: number
  expectedRegistry?: string
  /** Optional local allow-list; the on-chain trustedIssuer is authoritative. */
  trustedIssuers?: string[]
}

/** Structure, jti hash, EIP-712 signature (signer must be the issuer), domain, validity. Pure. */
export function verifyInvestorCredentialWith(
  c: Eip712Crypto,
  doc: unknown,
  opts: VerifyInvestorVcOptions = {}
): InvestorVcVerifyResult {
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  const bad = (reasonCode: InvestorVcReason, reason: string): InvestorVcVerifyResult => ({
    valid: false,
    reasonCode,
    reason,
  })
  const parsed = attestationFromCredential(doc)
  if (!parsed.ok) return bad('VC_MALFORMED', parsed.reason)
  const { domain, value, signature } = parsed
  let issuer: string
  let subject: string
  let registry: string
  try {
    issuer = c.getAddress(parsed.issuer)
    subject = c.getAddress(value.subject)
    registry = c.getAddress(domain.verifyingContract)
  } catch (e) {
    return bad('VC_MALFORMED', `malformed address: ${(e as Error).message}`)
  }
  const id = (doc as InvestorCredential).id
  if (c.id(id).toLowerCase() !== value.credentialHash) {
    return bad('VC_HASH_MISMATCH', 'proof.attestation.credentialHash != keccak256(VC id)')
  }
  const canonical: AttestationValue = { ...value, subject }
  const canonicalDomain: VcKycDomain = { ...domain, verifyingContract: registry }
  let recovered: string
  try {
    recovered = c.verifyTypedData(canonicalDomain, ATTESTATION_TYPES, { ...canonical }, signature)
  } catch (e) {
    return bad('VC_BAD_SIGNATURE', `signature does not recover: ${(e as Error).message}`)
  }
  if (recovered === ZERO_ADDRESS || c.getAddress(recovered) !== issuer) {
    return bad('VC_BAD_SIGNATURE', `signature recovers ${recovered}, not the issuer ${issuer}`)
  }
  if (opts.expectedChainId !== undefined && domain.chainId !== opts.expectedChainId) {
    return bad('VC_WRONG_DOMAIN', `VC is bound to chainId ${domain.chainId}, verifier expects ${opts.expectedChainId}`)
  }
  if (opts.expectedRegistry && c.getAddress(opts.expectedRegistry) !== registry) {
    return bad('VC_WRONG_DOMAIN', `VC is bound to registry ${registry}, verifier expects ${c.getAddress(opts.expectedRegistry)}`)
  }
  if (opts.trustedIssuers && !opts.trustedIssuers.map((a) => c.getAddress(a)).includes(issuer)) {
    return bad('VC_UNTRUSTED_ISSUER', `issuer ${issuer} is not on the trusted list`)
  }
  if (value.expiresAt <= value.issuedAt) return bad('VC_MALFORMED', 'validUntil must be after validFrom')
  if (value.issuedAt > nowSec + MAX_ATTESTATION_CLOCK_SKEW_SEC) return bad('VC_ISSUED_IN_FUTURE', 'validFrom is in the future')
  if (value.expiresAt <= nowSec) {
    return bad('VC_EXPIRED', `VC expired at ${new Date(value.expiresAt * 1000).toISOString()}`)
  }
  return {
    valid: true,
    issuer,
    subject,
    credentialType: parsed.credentialType,
    credentialHash: value.credentialHash,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    deadline: Number(value.deadline),
    nonce: value.nonce,
    domain: canonicalDomain,
    value: canonical,
    signature,
    digest: c.hashTypedData(canonicalDomain, ATTESTATION_TYPES, { ...canonical }),
  }
}

export type InvestorListReason =
  | 'STATUS_LIST_MALFORMED'
  | 'STATUS_LIST_BAD_SIGNATURE'
  | 'STATUS_LIST_WRONG_ISSUER'
  | 'STATUS_LIST_WRONG_DOMAIN'
  | 'STATUS_LIST_EXPIRED'
  | 'STATUS_LIST_ISSUED_IN_FUTURE'
  | 'STATUS_LIST_VALIDITY_TOO_LONG'
  | 'STATUS_LIST_TOO_LARGE'

/** Field-compatible with agent/shared/src/vcStatus.ts VerifiedStatusList (+ chainId). */
export interface VerifiedInvestorStatusList extends InvestorStatusListFields {
  verifyingContract: string
  digest: string
  chainId: number
}

export type InvestorListVerifyResult =
  | { valid: true; list: VerifiedInvestorStatusList }
  | { valid: false; reasonCode: InvestorListReason; reason: string }

/** Same rules as ADR-016 §4.1, bound to the registry domain (chainId + registry). Pure. */
export function verifyInvestorStatusListWith(
  c: Eip712Crypto,
  doc: unknown,
  opts: { now?: number; expectedIssuer?: string; expectedChainId?: number; expectedRegistry?: string } = {}
): InvestorListVerifyResult {
  const nowMs = opts.now ?? Date.now()
  const bad = (reasonCode: InvestorListReason, reason: string): InvestorListVerifyResult => ({
    valid: false,
    reasonCode,
    reason,
  })
  try {
    const d = doc as Partial<InvestorStatusList> | null
    if (!d || typeof d !== 'object' || !Array.isArray(d.type) || !d.type.includes('InvestorCredentialStatusList')) {
      return bad('STATUS_LIST_MALFORMED', 'not an InvestorCredentialStatusList')
    }
    const dom = d.proof?.eip712Domain
    if (
      !d.proof?.proofValue ||
      !dom ||
      typeof dom.chainId !== 'number' ||
      typeof dom.verifyingContract !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(dom.verifyingContract)
    ) {
      return bad('STATUS_LIST_MALFORMED', 'missing proof or eip712Domain')
    }
    const { sequence, issuedAt, validUntil, revokedBefore, revoked } = d
    if (![sequence, issuedAt, validUntil, revokedBefore].every(isSafeUint)) {
      return bad('STATUS_LIST_MALFORMED', 'sequence/issuedAt/validUntil/revokedBefore must be non-negative integers')
    }
    if (!isCanonicalRevokedIds(revoked)) {
      return bad('STATUS_LIST_MALFORMED', 'revoked must be lowercase bytes32, strictly ascending')
    }
    if (revoked.length > MAX_STATUS_LIST_ENTRIES) {
      return bad('STATUS_LIST_TOO_LARGE', `${revoked.length} revoked entries exceed the limit`)
    }
    const did = parseInvestorDid(d.issuer)
    if (!did) return bad('STATUS_LIST_MALFORMED', 'issuer is not did:pkh:eip155')
    if (did.chainId !== dom.chainId) {
      return bad('STATUS_LIST_WRONG_DOMAIN', 'issuer DID chainId differs from the domain')
    }
    if (dom.name !== VC_KYC_DOMAIN_NAME || dom.version !== VC_KYC_DOMAIN_VERSION) {
      return bad('STATUS_LIST_WRONG_DOMAIN', 'wrong eip712Domain name/version')
    }
    const issuer = c.getAddress(did.address)
    const registry = c.getAddress(dom.verifyingContract)
    const domain = vcKycDomain(dom.chainId, registry)
    const fields: InvestorStatusListFields = {
      issuer,
      sequence: sequence as number,
      issuedAt: issuedAt as number,
      validUntil: validUntil as number,
      revokedBefore: revokedBefore as number,
      revoked: revoked as string[],
    }
    const value = buildInvestorStatusListValue(fields)
    const recovered = c.verifyTypedData(domain, INVESTOR_STATUS_LIST_TYPES, value, d.proof.proofValue)
    if (recovered === ZERO_ADDRESS || c.getAddress(recovered) !== issuer) {
      return bad('STATUS_LIST_BAD_SIGNATURE', `signature does not match the issuer (recovers ${recovered})`)
    }
    if (opts.expectedIssuer && c.getAddress(opts.expectedIssuer) !== issuer) {
      return bad('STATUS_LIST_WRONG_ISSUER', `list issuer ${issuer} is not the VC issuer`)
    }
    if (opts.expectedChainId !== undefined && opts.expectedChainId !== dom.chainId) {
      return bad('STATUS_LIST_WRONG_DOMAIN', `list is bound to chainId ${dom.chainId}, verifier expects ${opts.expectedChainId}`)
    }
    if (opts.expectedRegistry && c.getAddress(opts.expectedRegistry) !== registry) {
      return bad('STATUS_LIST_WRONG_DOMAIN', `list is bound to registry ${registry}, not the one this verifier uses`)
    }
    if (fields.validUntil <= fields.issuedAt || fields.revokedBefore > fields.issuedAt + INVESTOR_REVOKE_ALL_LEAD_SEC) {
      return bad('STATUS_LIST_MALFORMED', 'validUntil must be after issuedAt; revokedBefore must not exceed issuedAt + 301 s')
    }
    if (fields.validUntil - fields.issuedAt > MAX_STATUS_LIST_VALIDITY_SEC) {
      return bad('STATUS_LIST_VALIDITY_TOO_LONG', 'list validity exceeds 90 days')
    }
    if (fields.issuedAt * 1000 > nowMs + MAX_ATTESTATION_CLOCK_SKEW_SEC * 1000) {
      return bad('STATUS_LIST_ISSUED_IN_FUTURE', 'list issuedAt is in the future')
    }
    if (fields.validUntil * 1000 <= nowMs) return bad('STATUS_LIST_EXPIRED', 'list expired; the issuer must re-sign it')
    const digest = c.hashTypedData(domain, INVESTOR_STATUS_LIST_TYPES, value)
    return { valid: true, list: { ...fields, verifyingContract: registry, digest, chainId: dom.chainId } }
  } catch (err) {
    return bad('STATUS_LIST_MALFORMED', (err as Error).message)
  }
}

/** Is this credential covered by a (verified) list? Mirrors vcStatus.ts isCredentialRevoked. */
export function isInvestorCredentialRevoked(
  vc: { credentialHash: string; issuedAt: number },
  list: { revoked: readonly string[]; revokedBefore: number }
): boolean {
  return list.revoked.includes(vc.credentialHash.toLowerCase()) || vc.issuedAt < list.revokedBefore
}

/** Minimal ABI (human-readable, ethers) for the frontend and the issuer CLI. */
export const VC_KYC_REGISTRY_ABI = [
  'function submitAttestation((address subject,bytes32 credentialType,bytes32 credentialHash,uint256 statusListIndex,uint64 issuedAt,uint64 expiresAt,uint256 nonce,uint256 deadline) a, bytes signature) returns (address)',
  'function revoke(bytes32 credentialHash)',
  'function revokeAllBefore(uint64 timestamp)',
  'function isVerified(address user) view returns (bool)',
  'function hasValidCredential(address user, bytes32 credentialType) view returns (bool)',
  'function credentialOf(address user, bytes32 credentialType) view returns ((address issuer,uint64 issuedAt,uint64 expiresAt,bytes32 credentialHash,uint64 epoch) record, bool valid)',
  'function trustEpoch(address issuer, bytes32 credentialType) view returns (uint64)',
  'function nonces(address subject) view returns (uint256)',
  'function requiredType() view returns (bytes32)',
  'function trustedIssuer(address issuer, bytes32 credentialType) view returns (bool)',
  'function revoked(address issuer, bytes32 credentialHash) view returns (bool)',
  'function revokedBefore(address issuer) view returns (uint64)',
  'function credentialUsed(bytes32 credentialHash) view returns (bool)',
  'function attestationDigest((address subject,bytes32 credentialType,bytes32 credentialHash,uint256 statusListIndex,uint64 issuedAt,uint64 expiresAt,uint256 nonce,uint256 deadline) a) view returns (bytes32)',
  'event AttestationSubmitted(address indexed subject, bytes32 indexed credentialType, address indexed issuer, bytes32 credentialHash, uint256 statusListIndex, uint64 issuedAt, uint64 expiresAt, address submitter)',
  'event CredentialRevoked(address indexed issuer, bytes32 indexed credentialHash, address revokedBy)',
  'error UntrustedIssuer(address issuer, bytes32 credentialType)',
  'error InvalidSignature()',
  'error AttestationDeadlinePassed(uint256 deadline)',
  'error CredentialExpired(uint64 expiresAt)',
  'error IssuedInFuture(uint64 issuedAt)',
  'error InvalidValidity()',
  'error BadNonce(uint256 expected, uint256 got)',
  'error CredentialAlreadyUsed(bytes32 credentialHash)',
  'error CredentialIsRevoked(bytes32 credentialHash)',
  'error UnsupportedCredentialType(bytes32 credentialType)',
  'error NotAuthorizedToRevoke(address caller)',
  'error WouldReplaceLongerCredential(uint64 currentExpiresAt, uint64 newExpiresAt)',
  'error ZeroAddress()',
] as const
