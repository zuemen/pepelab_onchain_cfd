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

/** Canonical chain for agent authorization VCs (Base Sepolia). */
export const AUTH_VC_CHAIN_ID = 84532

/** One EIP-712 field (matches ethers' TypedDataField / viem's typed-data field). */
export interface TypedField {
  name: string
  type: string
}

/** EIP-712 typed-data domain. Shared, must not diverge between issuer/verifier. */
export const AUTH_DOMAIN: { name: string; version: string; chainId: number } = {
  name: 'PepeLabAgentAuthorization',
  version: '1',
  chainId: AUTH_VC_CHAIN_ID,
}

/** EIP-712 types. `EIP712Domain` is omitted (ethers/viem add it automatically). */
export const AUTH_TYPES: Record<string, TypedField[]> = {
  AgentTradingAuthorization: [
    { name: 'issuer', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'sessionId', type: 'uint256' },
    { name: 'maxMarginPerTrade', type: 'string' },
    { name: 'totalBudget', type: 'string' },
    { name: 'maxLeverage', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
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
  }
  proof: {
    type: 'EthereumEip712Signature2021'
    created: string
    proofPurpose: 'assertionMethod'
    verificationMethod: string // <issuerDid>#blockchainAccountId
    proofValue: string         // 0x… EIP-712 signature
  }
}

/** did:pkh DID for an EVM address on the auth chain (W3C did:pkh, eip155). */
export const authDid = (address: string): string =>
  `did:pkh:eip155:${AUTH_VC_CHAIN_ID}:${address}`

/**
 * Build the exact EIP-712 value tuple to sign. Returned BigInt fields are what
 * ethers v6 signTypedData / a wallet's signTypedData expect for uint256.
 * Verification reconstructs this same tuple — keep it the only place it's built.
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

/**
 * Assemble the W3C VC given a signature and the `issuedAt` used when signing.
 * `proof.created` encodes `issuedAt` so the verifier can reconstruct it exactly.
 */
export function assembleAuthorizationVC(p: {
  issuerAddress: string
  agentAddress: string
  sessionId: number
  caps: AuthorizationCaps
  issuedAt: number
  signature: string
}): AuthorizationVC {
  const issuerDid = authDid(p.issuerAddress)
  const iso = new Date(p.issuedAt * 1000).toISOString()
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://pepelab.xyz/credentials/agent-authorization/v1',
    ],
    type: ['VerifiableCredential', 'AgentTradingAuthorization'],
    issuer: issuerDid,
    issuanceDate: iso,
    expirationDate: new Date(p.caps.expiry * 1000).toISOString(),
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
}
