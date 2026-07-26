// Agent identity & authorization — W3C Verifiable Credentials (VC) over
// Self-Sovereign Identity (SSI / DID) for "verifiable agent autonomy".
//
// SSI triangle, mapped to this project:
//   • issuer   = the user (their EOA) signs an authorization VC
//   • holder   = the AI agent (its session-key EOA), identified by a DID
//   • verifier = demo-agent / MCP server, which checks the VC signature AND
//                cross-checks it against the on-chain AgentSessionManager
//                session before executing a trade.
//
// DID method: did:pkh (W3C) — derived directly from an EVM address, so no extra
// identity infrastructure is needed: did:pkh:eip155:<chainId>:<address>.
//
// The VC = a "credentialised" view of the on-chain session authorization. It is
// signed with EIP-712 typed data using the existing ethers stack (no heavyweight
// DID/JSON-LD libraries). Verification recovers the issuer address from the
// signature and returns the authorized caps for the verifier to compare against
// the chain. Tampering with any field (caps, agent, sessionId) breaks the
// signature → verification fails → the trade is refused.
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
// Single source of truth for the EIP-712 schema + VC shape, shared with the
// frontend (browser-wallet issuer). Re-exported below so "@pepelab/shared"
// consumers — and the frontend, which imports the same file directly — stay
// byte-for-byte consistent. Mirrors how addresses.ts cross-imports frontend.
import {
  AUTH_DOMAIN,
  AUTH_TYPES,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  type AuthorizationCaps,
  type AuthorizationVC,
} from "../../../frontend/src/contracts/agentAuth";

export {
  AUTH_DOMAIN,
  AUTH_TYPES,
  AUTH_VC_CHAIN_ID,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  authDid,
} from "../../../frontend/src/contracts/agentAuth";
export type { AuthorizationCaps, AuthorizationVC } from "../../../frontend/src/contracts/agentAuth";

const ZERO = "0x0000000000000000000000000000000000000000";

/** did:pkh DID for an EVM address on the agent's chain. */
export function agentDid(address: string, chainId: number = AGENT_CHAIN_ID): string {
  return `did:pkh:eip155:${chainId}:${ethers.getAddress(address)}`;
}

/** Parse a did:pkh DID back to { chainId, address }. Throws on malformed input. */
export function parseDidPkh(did: string): { chainId: number; address: string } {
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(did.trim());
  if (!m) throw new Error(`malformed did:pkh: ${did}`);
  return { chainId: Number(m[1]), address: ethers.getAddress(m[2]) };
}

// EIP-712 domain/types live in the shared agentAuth module (AUTH_DOMAIN /
// AUTH_TYPES) so the frontend signs the exact tuple this file verifies.
const DOMAIN: ethers.TypedDataDomain = AUTH_DOMAIN;
const TYPES: Record<string, ethers.TypedDataField[]> = AUTH_TYPES;

/** A connected-wallet EIP-712 signer (ethers Wallet/Signer or a wagmi adapter). */
export type TypedDataSigner = (
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: ReturnType<typeof buildAuthTypedValue>,
) => Promise<string>;

/**
 * Issue (sign) an authorization VC with a local key wallet (agent-side / tests).
 * `issuer` is the user's wallet (the EOA that created the on-chain session). The
 * credential authorizes `agentAddress` to trade within `sessionId` limited by
 * `caps`. For the browser flow (user signs in MetaMask) use
 * `issueAuthorizationVCWithSigner` instead — same schema, same output.
 */
export async function issueAuthorizationVC(params: {
  issuer: ethers.Wallet | ethers.HDNodeWallet;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
}): Promise<AuthorizationVC> {
  const issuerAddr = await params.issuer.getAddress();
  return issueAuthorizationVCWithSigner({
    issuerAddress: issuerAddr,
    agentAddress: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    signTypedData: (d, t, v) => params.issuer.signTypedData(d, t, v),
  });
}

/**
 * Issue (sign) an authorization VC using a connected-wallet typed-data signer.
 * This is the true SSI path: the user (issuer) signs in their wallet (MetaMask),
 * so the private key never leaves the wallet. The frontend passes its connected
 * signer's `signTypedData`; agent-side `verifyAuthorizationVC` validates the
 * result. Identical schema/output to `issueAuthorizationVC`.
 */
export async function issueAuthorizationVCWithSigner(params: {
  issuerAddress: string;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
  signTypedData: TypedDataSigner;
}): Promise<AuthorizationVC> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const value = buildAuthTypedValue({
    issuer: params.issuerAddress,
    agent: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
  });
  const signature = await params.signTypedData(DOMAIN, TYPES, value);
  return assembleAuthorizationVC({
    issuerAddress: params.issuerAddress,
    agentAddress: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
    signature,
  });
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  issuer?: string;       // recovered issuer address (== signer)
  agent?: string;        // holder agent address
  sessionId?: number;
  caps?: AuthorizationCaps;
}

/**
 * Verify an authorization VC: recover the EIP-712 signer and require it to equal
 * the issuer named in the credential. Returns the authorized agent + caps so the
 * caller (verifier) can cross-check against the on-chain session.
 *
 * Any tampering (caps, agent, sessionId, issuer) changes the recovered address
 * → mismatch → `valid:false`.
 */
export function verifyAuthorizationVC(vc: AuthorizationVC): VerifyResult {
  try {
    if (!vc?.proof?.proofValue) return { valid: false, reason: "missing proof" };

    const issuer = parseDidPkh(vc.issuer).address;
    const agent = parseDidPkh(vc.credentialSubject.id).address;
    const caps = vc.credentialSubject.authorization;
    const sessionId = vc.credentialSubject.sessionId;

    // Reconstruct issuedAt from the proof's created timestamp (signed field).
    const issuedAt = Math.floor(new Date(vc.proof.created).getTime() / 1000);

    const value = buildAuthTypedValue({ issuer, agent, sessionId, caps, issuedAt });
    const recovered = ethers.verifyTypedData(DOMAIN, TYPES, value, vc.proof.proofValue);

    if (recovered === ZERO || ethers.getAddress(recovered) !== ethers.getAddress(issuer)) {
      return {
        valid: false,
        reason: `signature does not match issuer (recovered ${recovered}, expected ${issuer})`,
      };
    }

    // Expiry check (credential-level; the chain session also enforces its own).
    if (caps.expiry * 1000 < Date.now()) {
      return { valid: false, reason: "credential expired", issuer, agent, sessionId, caps };
    }

    return { valid: true, issuer, agent, sessionId, caps };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}
