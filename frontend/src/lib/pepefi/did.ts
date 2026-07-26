// Agent identity (SSI) — did:pkh derivation for display. Mirrors
// agent/shared/src/identity.ts so the frontend can show the same DID the
// agent stack uses. Pure string derivation, no dependencies / no VC needed.

/** did:pkh DID for an EVM address (W3C did:pkh, eip155 namespace). */
export const agentDid = (address: string, chainId = 84532): string =>
  `did:pkh:eip155:${chainId}:${address}`

/** Compact DID for tight table cells: did:pkh:eip155:84532:0x1234…abcd */
export const shortDid = (address: string, chainId = 84532): string =>
  `did:pkh:eip155:${chainId}:${address.slice(0, 6)}…${address.slice(-4)}`
