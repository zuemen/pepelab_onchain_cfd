// Agent DELEGATION credential (VC v3) + x402 Know-Your-Agent presentation — the
// single source of truth for the v3 EIP-712 schema and the W3C VC 2.0 document
// shape, shared (like agentAuth.ts / agentAuthStatus.ts) by:
//   • frontend (issuer): the session user signs the credential in their wallet;
//   • agent/shared (holder + verifier): delegation.ts signs presentations and
//     verifies credentials; signal-api uses it for x402 KYA.
// Pure and dependency-free (no ethers / viem / process.env) so both the Vite build
// and the agent's tsc build can import it. Hashing (EIP-712 digest) is done by the
// caller with its own library: ethers.TypedDataEncoder.hash / viem hashTypedData.
//
// ── What changes from v2 (agentAuth.ts) ─────────────────────────────────────
//   • Document: W3C VC Data Model 2.0 (`@context` .../ns/credentials/v2,
//     `validFrom`/`validUntil`, `credentialStatus`), type AgentDelegationCredential.
//   • Signed content: the whole on-chain session (sessionManager, sessionId, per-trade
//     cap, budget, leverage, expiry, asset allow-list — raw on-chain units, so the
//     verifier compares with `sessions(id)` by exact equality) PLUS an x402 spending
//     allowance (per-period cap, total cap, allowed paid endpoints).
//   • Domain: name 'PepeLabAgentDelegation', version '3', chainId = the session's
//     chain, verifyingContract = the AgentSessionManager.
//   • Proof: `EthereumEip712Signature2021` (W3C CCG draft,
//     https://w3c-ccg.github.io/ethereum-eip712-signature-2021-spec/) with the
//     `eip712` property (domain + primaryType + types) so any verifier can rebuild
//     the typed data. Like v2, the message is a flat typed projection of the
//     credential (not the JSON-LD document); every semantic field of the JSON is
//     covered, and the verifier rebuilds the projection from the JSON.
//   • Credential id (jti) = `nonce`, the same rule as v2, so the ADR-016 status list
//     and the agent's nonce/supersession store treat v3 exactly like v2.
//   • credentialHash = EIP-712 digest of the typed data. It is what the session user
//     anchors on chain (SessionCredentialAnchor) and what x402 spend is keyed by.
//
// v2 stays verifiable unchanged; nothing in agentAuth.ts is modified by v3.

import type { TypedField } from './agentAuth'

export const DELEGATION_VC_VERSION = 3
export const DELEGATION_PRIMARY_TYPE = 'AgentDelegationCredential' as const
const DELEGATION_DOMAIN_NAME = 'PepeLabAgentDelegation'

/** Default x402 allowance period: one day. */
export const DEFAULT_X402_PERIOD_SEC = 24 * 3600
/** Paid endpoints of signal-api (x402). An allowance may list any subset. */
export const X402_DEFAULT_ENDPOINTS: readonly string[] = ['GET /signals/*', 'GET /oracle/*']
/** USDC has 6 decimals; x402 amounts in the credential are atomic units. */
export const X402_USDC_DECIMALS = 6

/** HTTP header that carries the agent's Verifiable Presentation on x402 calls. */
export const AGENT_PRESENTATION_HEADER = 'X-Agent-Presentation'
/** Response header advertising that the seller requires KYA. */
export const AGENT_KYA_HEADER = 'X-Agent-KYA'
/** Response header with the credential's x402 spend after this request (atomic USDC). */
export const AGENT_KYA_SPEND_HEADER = 'X-Agent-KYA-Spend'

/** v3 EIP-712 domain: bound to the session's chain and AgentSessionManager deployment. */
export function delegationDomain(
  chainId: number,
  sessionManager: string,
): { name: string; version: string; chainId: number; verifyingContract: string } {
  return { name: DELEGATION_DOMAIN_NAME, version: '3', chainId, verifyingContract: sessionManager }
}

/** v3 EIP-712 types (`EIP712Domain` omitted — ethers/viem add it). */
export const DELEGATION_TYPES: Record<string, TypedField[]> = {
  AgentDelegationCredential: [
    { name: 'issuer', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'sessionManager', type: 'address' },
    { name: 'sessionId', type: 'uint256' },
    { name: 'maxMarginPerTrade', type: 'uint256' },
    { name: 'totalMarginBudget', type: 'uint256' },
    { name: 'maxLeverage', type: 'uint256' },
    { name: 'sessionExpiry', type: 'uint256' },
    { name: 'allowedAssets', type: 'bytes32[]' },
    { name: 'x402', type: 'X402Allowance' },
    { name: 'validFrom', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
  X402Allowance: [
    { name: 'maxPerPeriod', type: 'uint256' },
    { name: 'periodSeconds', type: 'uint256' },
    { name: 'maxTotal', type: 'uint256' },
    { name: 'endpoints', type: 'string[]' },
  ],
}

/** x402 spending allowance. Amounts are atomic USDC (6 decimals) as decimal strings. */
export interface X402Allowance {
  /** Max x402 spend within one period (atomic USDC). */
  maxPerPeriod: string
  /** Period length in seconds (fixed windows: floor(now / periodSeconds)). */
  periodSeconds: number
  /** Max x402 spend over the credential's lifetime (atomic USDC). */
  maxTotal: string
  /** Allowed paid endpoints, `METHOD /path` with `*` matching one path segment. */
  endpoints: string[]
}

/** Every signed field of a v3 credential (the EIP-712 message, JSON-friendly). */
export interface DelegationFields {
  issuer: string
  agent: string
  sessionManager: string
  sessionId: number
  /** Raw on-chain units (collateral token decimals), decimal string — equals sessions(id).maxMarginPerTrade. */
  maxMarginPerTrade: string
  /** Raw on-chain units, decimal string — equals sessions(id).totalMarginBudget. */
  totalMarginBudget: string
  maxLeverage: number
  /** Unix seconds — equals sessions(id).expiry. */
  sessionExpiry: number
  /** bytes32 asset ids; canonical order (lowercase, unique, sorted). Empty = unrestricted. */
  allowedAssets: string[]
  x402: X402Allowance
  /** Unix seconds. */
  validFrom: number
  /** Unix seconds. Never later than sessionExpiry. */
  validUntil: number
  /** bytes32, unique per credential (jti). */
  nonce: string
}

export interface DelegationCredentialStatus {
  id: string
  /** ADR-016 issuer-signed status list (jti-keyed, adapted from W3C Bitstring Status List). */
  type: 'PepeLabCredentialStatusList2026'
  statusPurpose: 'revocation'
  /** The credential's jti (= credentialSubject.nonce): ADR-016 lists are keyed by jti, not a bit index. */
  statusListIndex: string
  /** Where the issuer's list lives: `<VC_STATUS_URL>/<issuer lowercase>.json`, or a urn when not published over HTTP. */
  statusListCredential: string
}

export interface DelegationCredential {
  '@context': string[]
  id: string
  type: string[]
  /** did:pkh of the session user (issuer). */
  issuer: string
  validFrom: string
  validUntil: string
  credentialSubject: {
    /** did:pkh of the agent (holder). */
    id: string
    sessionManager: string
    sessionId: number
    session: {
      maxMarginPerTrade: string
      totalMarginBudget: string
      maxLeverage: number
      expiry: number
      allowedAssets: string[]
    }
    x402: X402Allowance & { currency: 'USDC'; decimals: number }
    nonce: string
  }
  credentialStatus: DelegationCredentialStatus
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'assertionMethod'
    verificationMethod: string
    proofValue: string
    eip712: {
      domain: { name: string; version: string; chainId: number; verifyingContract: string }
      primaryType: typeof DELEGATION_PRIMARY_TYPE
      types: Record<string, TypedField[]>
    }
  }
}

/** did:pkh for an EVM address on `chainId`. */
export const didPkh = (address: string, chainId: number): string => `did:pkh:eip155:${chainId}:${address}`

/** Canonical asset list: lowercase, unique, sorted. The signed list and the chain are compared in this form. */
export function canonicalAssets(ids: readonly string[]): string[] {
  return [...new Set(ids.map((s) => s.toLowerCase()))].sort()
}

/** Duck-type check: is this a v3 delegation credential (vs a v1/v2 authorization VC)? */
export function isDelegationCredential(vc: unknown): vc is DelegationCredential {
  const v = vc as Partial<DelegationCredential> | null
  return (
    !!v &&
    Array.isArray(v.type) &&
    v.type.includes(DELEGATION_PRIMARY_TYPE) &&
    v.proof?.eip712?.domain?.version === '3'
  )
}

/** Default status pointer: HTTP when the status directory is published, else a urn. */
export function defaultStatusListCredential(
  issuer: string,
  sessionManager: string,
  statusBaseUrl?: string,
): string {
  const base = statusBaseUrl?.trim().replace(/\/+$/, '')
  return base
    ? `${base}/${issuer.toLowerCase()}.json`
    : `urn:pepelab:vc-status:${sessionManager.toLowerCase()}:${issuer.toLowerCase()}`
}

/** The exact EIP-712 value (uint256 as BigInt, as ethers v6 / viem expect). */
export function buildDelegationTypedValue(f: DelegationFields) {
  return {
    issuer: f.issuer,
    agent: f.agent,
    sessionManager: f.sessionManager,
    sessionId: BigInt(f.sessionId),
    maxMarginPerTrade: BigInt(f.maxMarginPerTrade),
    totalMarginBudget: BigInt(f.totalMarginBudget),
    maxLeverage: BigInt(f.maxLeverage),
    sessionExpiry: BigInt(f.sessionExpiry),
    allowedAssets: canonicalAssets(f.allowedAssets),
    x402: {
      maxPerPeriod: BigInt(f.x402.maxPerPeriod),
      periodSeconds: BigInt(f.x402.periodSeconds),
      maxTotal: BigInt(f.x402.maxTotal),
      endpoints: [...f.x402.endpoints],
    },
    validFrom: BigInt(f.validFrom),
    validUntil: BigInt(f.validUntil),
    nonce: f.nonce,
  }
}

/** Assemble the W3C VC 2.0 document from its signed fields and the issuer's signature. */
export function assembleDelegationCredential(p: {
  fields: DelegationFields
  chainId: number
  signature: string
  /** Default: urn pointer (see defaultStatusListCredential). */
  statusListCredential?: string
}): DelegationCredential {
  const f = p.fields
  const issuerDid = didPkh(f.issuer, p.chainId)
  const statusList = p.statusListCredential ?? defaultStatusListCredential(f.issuer, f.sessionManager)
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://pepelab.xyz/credentials/agent-delegation/v3',
    ],
    id: `urn:pepelab:agent-delegation:${f.nonce.toLowerCase()}`,
    type: ['VerifiableCredential', DELEGATION_PRIMARY_TYPE],
    issuer: issuerDid,
    validFrom: new Date(f.validFrom * 1000).toISOString(),
    validUntil: new Date(f.validUntil * 1000).toISOString(),
    credentialSubject: {
      id: didPkh(f.agent, p.chainId),
      sessionManager: f.sessionManager,
      sessionId: f.sessionId,
      session: {
        maxMarginPerTrade: f.maxMarginPerTrade,
        totalMarginBudget: f.totalMarginBudget,
        maxLeverage: f.maxLeverage,
        expiry: f.sessionExpiry,
        allowedAssets: canonicalAssets(f.allowedAssets),
      },
      x402: { ...f.x402, endpoints: [...f.x402.endpoints], currency: 'USDC', decimals: X402_USDC_DECIMALS },
      nonce: f.nonce,
    },
    credentialStatus: {
      id: `${statusList}#${f.nonce.toLowerCase()}`,
      type: 'PepeLabCredentialStatusList2026',
      statusPurpose: 'revocation',
      statusListIndex: f.nonce.toLowerCase(),
      statusListCredential: statusList,
    },
    proof: {
      type: 'EthereumEip712Signature2021',
      created: new Date(f.validFrom * 1000).toISOString(),
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue: p.signature,
      eip712: {
        domain: delegationDomain(p.chainId, f.sessionManager),
        primaryType: DELEGATION_PRIMARY_TYPE,
        types: DELEGATION_TYPES,
      },
    },
  }
}

const DID_RE = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/

/**
 * Rebuild the signed fields from a credential document (the verifier side). Throws on
 * any malformed field. Address checksums are NOT normalised here (EIP-712 hashes the
 * 20-byte value); the verifier compares addresses case-insensitively.
 */
export function delegationFieldsFromCredential(vc: DelegationCredential): { fields: DelegationFields; chainId: number } {
  const iss = DID_RE.exec(String(vc.issuer ?? ''))
  const sub = DID_RE.exec(String(vc.credentialSubject?.id ?? ''))
  if (!iss || !sub) throw new Error('issuer / credentialSubject.id must be did:pkh:eip155')
  if (iss[1] !== sub[1]) throw new Error('issuer and holder DIDs are on different chains')
  const chainId = Number(iss[1])
  const cs = vc.credentialSubject
  const s = cs.session
  const x = cs.x402
  const uintStr = (v: unknown, name: string): string => {
    const t = String(v ?? '')
    if (!/^\d{1,78}$/.test(t)) throw new Error(`${name} must be a non-negative integer string`)
    return t
  }
  const uintNum = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`)
    return v
  }
  const secs = (iso: unknown, name: string): number => {
    const ms = Date.parse(String(iso ?? ''))
    if (!Number.isFinite(ms) || ms % 1000 !== 0) throw new Error(`${name} must be an ISO date on a whole second`)
    return ms / 1000
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(cs.nonce ?? ''))) throw new Error('credentialSubject.nonce must be bytes32')
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(cs.sessionManager ?? ''))) throw new Error('sessionManager must be an address')
  if (!Array.isArray(s?.allowedAssets) || !s.allowedAssets.every((a) => /^0x[0-9a-fA-F]{64}$/.test(String(a))))
    throw new Error('session.allowedAssets must be bytes32[]')
  if (!Array.isArray(x?.endpoints) || !x.endpoints.every((e) => typeof e === 'string' && e.length > 0 && e.length <= 128))
    throw new Error('x402.endpoints must be non-empty strings')
  const fields: DelegationFields = {
    issuer: iss[2],
    agent: sub[2],
    sessionManager: cs.sessionManager,
    sessionId: uintNum(cs.sessionId, 'sessionId'),
    maxMarginPerTrade: uintStr(s.maxMarginPerTrade, 'maxMarginPerTrade'),
    totalMarginBudget: uintStr(s.totalMarginBudget, 'totalMarginBudget'),
    maxLeverage: uintNum(s.maxLeverage, 'maxLeverage'),
    sessionExpiry: uintNum(s.expiry, 'session.expiry'),
    allowedAssets: [...s.allowedAssets],
    x402: {
      maxPerPeriod: uintStr(x.maxPerPeriod, 'x402.maxPerPeriod'),
      periodSeconds: uintNum(x.periodSeconds, 'x402.periodSeconds'),
      maxTotal: uintStr(x.maxTotal, 'x402.maxTotal'),
      endpoints: [...x.endpoints],
    },
    validFrom: secs(vc.validFrom, 'validFrom'),
    validUntil: secs(vc.validUntil, 'validUntil'),
    nonce: cs.nonce,
  }
  return { fields, chainId }
}

/**
 * Does `METHOD /path` match one of the allowance patterns? Pattern = `METHOD /seg/seg`,
 * where a `*` segment matches exactly one non-empty path segment. Method and literal
 * segments compare case-sensitively for the path (paths are normalised by the server)
 * and case-insensitively for the method.
 */
export function matchX402Endpoint(patterns: readonly string[], method: string, path: string): string | null {
  const segs = path.split('/').filter(Boolean)
  for (const p of patterns) {
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(p.trim())
    if (!m || m[1].toUpperCase() !== method.toUpperCase()) continue
    const ps = m[2].split('/').filter(Boolean)
    if (ps.length !== segs.length) continue
    if (ps.every((q, i) => (q === '*' ? segs[i].length > 0 : q === segs[i]))) return p
  }
  return null
}

// ── Verifiable Presentation for x402 (Know Your Agent) ──────────────────────

export const PRESENTATION_PRIMARY_TYPE = 'AgentX402Presentation' as const

/** Presentation domain: chain of the holder DID. No verifyingContract (it binds a request, not a contract). */
export function presentationDomain(chainId: number): { name: string; version: string; chainId: number } {
  return { name: 'PepeLabAgentPresentation', version: '1', chainId }
}

/**
 * What the agent (holder) signs per paid request. `paymentNonce` is the EIP-3009 nonce of
 * the x402 payment authorization in the same request and `payer` its `from`: the payment
 * itself is single-use on chain, so a presentation cannot be detached and replayed with a
 * different payment, and the server additionally refuses a second presentation for the
 * same (payer, paymentNonce).
 */
export const PRESENTATION_TYPES: Record<string, TypedField[]> = {
  AgentX402Presentation: [
    { name: 'holder', type: 'address' },
    { name: 'credentialHash', type: 'bytes32' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'paymentNonce', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'created', type: 'uint256' },
  ],
}

export interface PresentationFields {
  holder: string
  credentialHash: string
  method: string
  path: string
  paymentNonce: string
  payer: string
  /** Unix seconds. */
  created: number
}

export interface AgentX402Presentation {
  '@context': string[]
  type: string[]
  /** did:pkh of the agent. */
  holder: string
  verifiableCredential: DelegationCredential[]
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'authentication'
    verificationMethod: string
    /** = paymentNonce (Data Integrity `challenge`). */
    challenge: string
    /** = `METHOD /path` (Data Integrity `domain`). */
    domain: string
    proofValue: string
    credentialHash: string
    payer: string
    eip712: { domain: { name: string; version: string; chainId: number }; primaryType: typeof PRESENTATION_PRIMARY_TYPE }
  }
}

export function buildPresentationTypedValue(f: PresentationFields) {
  return {
    holder: f.holder,
    credentialHash: f.credentialHash,
    method: f.method.toUpperCase(),
    path: f.path,
    paymentNonce: f.paymentNonce,
    payer: f.payer,
    created: BigInt(f.created),
  }
}

export function assemblePresentation(p: {
  credential: DelegationCredential
  fields: PresentationFields
  chainId: number
  signature: string
}): AgentX402Presentation {
  const holderDid = didPkh(p.fields.holder, p.chainId)
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiablePresentation', 'AgentX402Presentation'],
    holder: holderDid,
    verifiableCredential: [p.credential],
    proof: {
      type: 'EthereumEip712Signature2021',
      created: new Date(p.fields.created * 1000).toISOString(),
      proofPurpose: 'authentication',
      verificationMethod: `${holderDid}#blockchainAccountId`,
      challenge: p.fields.paymentNonce,
      domain: `${p.fields.method.toUpperCase()} ${p.fields.path}`,
      proofValue: p.signature,
      credentialHash: p.fields.credentialHash,
      payer: p.fields.payer,
      eip712: { domain: presentationDomain(p.chainId), primaryType: PRESENTATION_PRIMARY_TYPE },
    },
  }
}

// base64url(JSON) — header-safe encoding, works in browsers and Node ≥ 16 (btoa/atob + TextEncoder).
export function encodeHeaderJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeHeaderJson<T = unknown>(s: string): T {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
