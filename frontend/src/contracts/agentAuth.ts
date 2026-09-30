// Agent authorization VC — the SINGLE SOURCE OF TRUTH for the EIP-712 schema and
// W3C VC shape, shared by both sides of the SSI triangle:
//   • frontend (issuer): the user signs this typed data in MetaMask (browser
//     wallet); the private key never leaves the wallet.
//   • agent stack (verifier): agent/shared/src/identity.ts imports + re-exports
//     this module and reconstructs the exact same tuple in verifyAuthorizationVC.
//
// Both must agree byte-for-byte or verification fails — so the schema lives here,
// in a pure, dependency-free module (no ethers, no process.env) that both the
// Vite browser build and the agent's tsc build can import. (Mirrors how
// agent/shared/src/addresses.ts already cross-imports frontend/src/contracts.)
//
// NOTE: EIP-712 `address` fields hash by their 20-byte value, so address casing
// is irrelevant to the signature — callers may pass checksummed or lowercase.
//
// ── Versions ────────────────────────────────────────────────────────────────
//   v2 (current, issued by the frontend from 2026-09-30):
//     • domain adds `verifyingContract` = the AgentSessionManager address, so a
//       signature for one deployment cannot be replayed against another.
//     • the signed struct adds `validUntil` (credential-level expiry, may be
//       shorter than the on-chain session) and `nonce` (bytes32, the VC's jti).
//     • the VC carries `proof.eip712Domain` so the verifier can rebuild the domain.
//   v1 (legacy): domain {name, version:'1', chainId}, no validUntil / nonce.
//     Still verifiable, with a warning, until LEGACY_VC_SUNSET_ISO; rejected after.

/** Canonical chain for agent authorization VCs (Base Sepolia). */
export const AUTH_VC_CHAIN_ID = 84532

export const AUTH_VC_VERSION = 2
export const AUTH_VC_VERSION_LEGACY = 1

/**
 * Deprecation schedule for v1 (legacy) VCs:
 *   2026-09-30  v2 issuance ships; v1 still verifies, every use logs a warning.
 *   2026-12-31  last day v1 is accepted (UTC end of day). After this the agent
 *               rejects v1 with reason LEGACY_VC_SUNSET — users re-issue in /sessions.
 */
export const LEGACY_VC_SUNSET_ISO = '2026-12-31T23:59:59Z'

/** Default credential validity for new VCs (capped at the session expiry). */
export const DEFAULT_VC_VALIDITY_SEC = 7 * 24 * 3600

/** One EIP-712 field (matches ethers' TypedDataField / viem's typed-data field). */
export interface TypedField {
  name: string
  type: string
}

const DOMAIN_NAME = 'PepeLabAgentAuthorization'

/** v1 (legacy) EIP-712 domain. Kept only so old VCs still verify. */
export const AUTH_DOMAIN: { name: string; version: string; chainId: number } = {
  name: DOMAIN_NAME,
  version: '1',
  chainId: AUTH_VC_CHAIN_ID,
}

/** v2 EIP-712 domain: bound to the AgentSessionManager deployment. */
export function authDomainV2(verifyingContract: string): {
  name: string
  version: string
  chainId: number
  verifyingContract: string
} {
  return { name: DOMAIN_NAME, version: '2', chainId: AUTH_VC_CHAIN_ID, verifyingContract }
}

const V1_FIELDS: TypedField[] = [
  { name: 'issuer', type: 'address' },
  { name: 'agent', type: 'address' },
  { name: 'sessionId', type: 'uint256' },
  { name: 'maxMarginPerTrade', type: 'string' },
  { name: 'totalBudget', type: 'string' },
  { name: 'maxLeverage', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'issuedAt', type: 'uint256' },
]

/** v1 (legacy) EIP-712 types. `EIP712Domain` is omitted (ethers/viem add it automatically). */
export const AUTH_TYPES: Record<string, TypedField[]> = {
  AgentTradingAuthorization: V1_FIELDS,
}

/** v2 EIP-712 types: v1 fields + validUntil + nonce. */
export const AUTH_TYPES_V2: Record<string, TypedField[]> = {
  AgentTradingAuthorization: [
    ...V1_FIELDS,
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/** Authorization caps — mirror the on-chain AgentSessionManager session fields. */
export interface AuthorizationCaps {
  /** Max margin per single trade (USDC, human units). */
  maxMarginPerTrade: string
  /** Total margin budget over the session (USDC, human units). */
  totalBudget: string
  /** Max leverage allowed. */
  maxLeverage: number
  /** Unix expiry (seconds). */
  expiry: number
}

export interface AuthorizationVC {
  '@context': string[]
  type: string[]
  issuer: string          // did:pkh of the user (issuer)
  issuanceDate: string    // ISO
  expirationDate: string  // ISO
  credentialSubject: {
    id: string            // did:pkh of the agent (holder)
    sessionId: number
    authorization: AuthorizationCaps
    /** v2: credential-level expiry (unix seconds). */
    validUntil?: number
    /** v2: 0x-prefixed bytes32, unique per credential (jti). */
    nonce?: string
  }
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'assertionMethod'
    verificationMethod: string // <issuerDid>#blockchainAccountId
    proofValue: string         // 0x… EIP-712 signature
    /** v2: the domain fields the verifier must rebuild (absent ⇒ legacy v1). */
    eip712Domain?: { version: '2'; verifyingContract: string }
  }
}

/** did:pkh DID for an EVM address on the auth chain (W3C did:pkh, eip155). */
export const authDid = (address: string): string =>
  `did:pkh:eip155:${AUTH_VC_CHAIN_ID}:${address}`

/** Version of a VC: 2 when it carries the v2 domain marker, else legacy 1. */
export const authVcVersion = (vc: Pick<AuthorizationVC, 'proof'>): 1 | 2 =>
  vc?.proof?.eip712Domain?.version === '2' ? 2 : 1

/** Fresh random bytes32 nonce (browser + Node ≥ 19 both expose globalThis.crypto). */
export function newAuthNonce(): string {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto
  if (!c?.getRandomValues) throw new Error('secure random source unavailable')
  const bytes = c.getRandomValues(new Uint8Array(32))
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Default validUntil: issuedAt + DEFAULT_VC_VALIDITY_SEC, never past the session expiry. */
export const defaultValidUntil = (issuedAt: number, sessionExpiry: number): number =>
  Math.min(issuedAt + DEFAULT_VC_VALIDITY_SEC, sessionExpiry)

/**
 * Build the exact v1 (legacy) EIP-712 value tuple. Returned BigInt fields are what
 * ethers v6 signTypedData / a wallet's signTypedData expect for uint256.
 */
export function buildAuthTypedValue(p: {
  issuer: string
  agent: string
  sessionId: number
  caps: AuthorizationCaps
  issuedAt: number
}) {
  return {
    issuer: p.issuer,
    agent: p.agent,
    sessionId: BigInt(p.sessionId),
    maxMarginPerTrade: p.caps.maxMarginPerTrade,
    totalBudget: p.caps.totalBudget,
    maxLeverage: BigInt(p.caps.maxLeverage),
    expiry: BigInt(p.caps.expiry),
    issuedAt: BigInt(p.issuedAt),
  }
}

/** Build the exact v2 EIP-712 value tuple (v1 fields + validUntil + nonce). */
export function buildAuthTypedValueV2(p: {
  issuer: string
  agent: string
  sessionId: number
  caps: AuthorizationCaps
  issuedAt: number
  validUntil: number
  nonce: string
}) {
  return {
    ...buildAuthTypedValue(p),
    validUntil: BigInt(p.validUntil),
    nonce: p.nonce,
  }
}

/**
 * Assemble the W3C VC given a signature and the `issuedAt` used when signing.
 * `proof.created` encodes `issuedAt` so the verifier can reconstruct it exactly.
 * Pass `v2` for the current format; omitting it produces a legacy v1 VC (tests only).
 */
export function assembleAuthorizationVC(p: {
  issuerAddress: string
  agentAddress: string
  sessionId: number
  caps: AuthorizationCaps
  issuedAt: number
  signature: string
  v2?: { validUntil: number; nonce: string; verifyingContract: string }
}): AuthorizationVC {
  const issuerDid = authDid(p.issuerAddress)
  const iso = new Date(p.issuedAt * 1000).toISOString()
  const vc: AuthorizationVC = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      p.v2
        ? 'https://pepelab.xyz/credentials/agent-authorization/v2'
        : 'https://pepelab.xyz/credentials/agent-authorization/v1',
    ],
    type: ['VerifiableCredential', 'AgentTradingAuthorization'],
    issuer: issuerDid,
    issuanceDate: iso,
    expirationDate: new Date(
      (p.v2 ? Math.min(p.v2.validUntil, p.caps.expiry) : p.caps.expiry) * 1000,
    ).toISOString(),
    credentialSubject: {
      id: authDid(p.agentAddress),
      sessionId: p.sessionId,
      authorization: p.caps,
    },
    proof: {
      type: 'EthereumEip712Signature2021',
      created: iso,
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue: p.signature,
    },
  }
  if (p.v2) {
    vc.credentialSubject.validUntil = p.v2.validUntil
    vc.credentialSubject.nonce = p.v2.nonce
    vc.proof.eip712Domain = { version: '2', verifyingContract: p.v2.verifyingContract }
  }
  return vc
}
