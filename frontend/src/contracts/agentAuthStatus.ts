// Agent authorization VC — credential STATUS LIST (revocation), ADR-016.
//
// Single source of truth for the status-list EIP-712 schema and document shape,
// shared (like agentAuth.ts) by the browser issuer and the agent verifier
// (agent/shared/src/vcStatus.ts re-exports and verifies it). Pure and
// dependency-free: no ethers, no process.env.
//
// Model (W3C Bitstring Status List, adapted):
//   • The ISSUER of the VC (the user's wallet) signs the list — same wallet, same
//     EIP-712 domain as the v2 VC (`authDomainV2(sessionManager)`), different
//     primary type, so a list signature can never be confused with a VC.
//   • One list per issuer per deployment. A VC needs no `credentialStatus`
//     pointer: the verifier looks the list up by the VC's issuer, so every v2
//     (and legacy v1) VC already in circulation is covered without a v3 format.
//   • Entries are credential ids (jti): v2 → `credentialSubject.nonce`;
//     v1 → its EIP-712 digest. `revokedBefore` revokes every credential of this
//     issuer with issuedAt < revokedBefore (the "revoke everything" switch).
//   • `sequence` is strictly increasing per issuer; verifiers remember the
//     highest one they accepted, so an older list cannot be replayed to
//     "revive" a revoked credential. `issuedAt` / `validUntil` bound how long a
//     list may be trusted at all.

import { authDid, authDomainV2, AUTH_VC_CHAIN_ID, type TypedField } from './agentAuth'

export const STATUS_LIST_PRIMARY_TYPE = 'AgentCredentialStatusList' as const

/** Default list validity (the issuer re-signs before it lapses; see ADR-016 §4). */
export const DEFAULT_STATUS_LIST_VALIDITY_DAYS = 30
export const DEFAULT_STATUS_LIST_VALIDITY_SEC = DEFAULT_STATUS_LIST_VALIDITY_DAYS * 24 * 3600
/** Verifiers reject lists valid for longer than this (bounds the stale-list window). */
export const MAX_STATUS_LIST_VALIDITY_SEC = 90 * 24 * 3600
/** Verifiers reject lists with more revoked ids than this. */
export const MAX_STATUS_LIST_ENTRIES = 1000

/** EIP-712 types for the status list. `EIP712Domain` omitted (ethers/viem add it). */
export const STATUS_LIST_TYPES: Record<string, TypedField[]> = {
  AgentCredentialStatusList: [
    { name: 'issuer', type: 'address' },
    { name: 'sequence', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'revokedBefore', type: 'uint256' },
    { name: 'revoked', type: 'bytes32[]' },
  ],
}

/** Same domain as the v2 VC: bound to chain + AgentSessionManager deployment. */
export const statusListDomain = authDomainV2

export interface CredentialStatusList {
  '@context': string[]
  type: string[]
  /** did:pkh of the issuer (must equal the issuer of the VCs it covers). */
  issuer: string
  /** Strictly increasing per issuer. */
  sequence: number
  /** unix seconds */
  issuedAt: number
  /** unix seconds; the list is not trusted after this. */
  validUntil: number
  /** unix seconds; every credential of this issuer with issuedAt < revokedBefore is revoked. 0 = none. */
  revokedBefore: number
  /** Revoked credential ids (jti), lowercase 0x-bytes32, strictly ascending. */
  revoked: string[]
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'assertionMethod'
    verificationMethod: string
    proofValue: string
    eip712Domain: { version: '2'; verifyingContract: string }
  }
}

const BYTES32 = /^0x[0-9a-f]{64}$/

/** Lowercase, de-duplicate and sort ids (the only form verifiers accept). Throws on a non-bytes32 id. */
export function canonicalRevokedIds(ids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of ids) {
    const id = String(raw).trim().toLowerCase()
    if (!BYTES32.test(id)) throw new Error(`revoked id must be a 0x-prefixed bytes32: ${raw}`)
    out.add(id)
  }
  return [...out].sort()
}

/** True when `ids` is already canonical (lowercase bytes32, strictly ascending). */
export function isCanonicalRevokedIds(ids: unknown): ids is string[] {
  if (!Array.isArray(ids)) return false
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'string' || !BYTES32.test(ids[i])) return false
    if (i > 0 && !(ids[i - 1] < ids[i])) return false
  }
  return true
}

export interface StatusListFields {
  issuer: string
  sequence: number
  issuedAt: number
  validUntil: number
  revokedBefore: number
  revoked: string[]
}

/** The exact EIP-712 value tuple (uint256 as BigInt, as ethers / wallets expect). */
export function buildStatusListTypedValue(p: StatusListFields) {
  return {
    issuer: p.issuer,
    sequence: BigInt(p.sequence),
    issuedAt: BigInt(p.issuedAt),
    validUntil: BigInt(p.validUntil),
    revokedBefore: BigInt(p.revokedBefore),
    revoked: [...p.revoked],
  }
}

/** Assemble the list document from its signed fields and signature. */
export function assembleStatusList(
  p: StatusListFields & { issuerAddress: string; signature: string; verifyingContract: string },
): CredentialStatusList {
  const issuerDid = authDid(p.issuerAddress)
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://pepelab.xyz/credentials/agent-authorization-status/v1',
    ],
    type: ['AgentCredentialStatusList'],
    issuer: issuerDid,
    sequence: p.sequence,
    issuedAt: p.issuedAt,
    validUntil: p.validUntil,
    revokedBefore: p.revokedBefore,
    revoked: [...p.revoked],
    proof: {
      type: 'EthereumEip712Signature2021',
      created: new Date(p.issuedAt * 1000).toISOString(),
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue: p.signature,
      eip712Domain: { version: '2', verifyingContract: p.verifyingContract },
    },
  }
}

export { AUTH_VC_CHAIN_ID }
