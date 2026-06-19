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

/** Authorization caps — mirror the on-chain AgentSessionManager session fields. */
export interface AuthorizationCaps {
  /** Max margin per single trade (USDC, human units). */
  maxMarginPerTrade: string;
  /** Total margin budget over the session (USDC, human units). */
  totalBudget: string;
  /** Max leverage allowed. */
  maxLeverage: number;
  /** Unix expiry (seconds). */
  expiry: number;
}

export interface AuthorizationVC {
  "@context": string[];
  type: string[];
  issuer: string;          // did:pkh of the user
  issuanceDate: string;    // ISO
  expirationDate: string;  // ISO
  credentialSubject: {
    id: string;            // did:pkh of the agent (holder)
    sessionId: number;
    authorization: AuthorizationCaps;
  };
  proof: {
    type: "EthereumEip712Signature2021";
    created: string;
    proofPurpose: "assertionMethod";
    verificationMethod: string; // <issuerDid>#blockchainAccountId
    proofValue: string;         // 0x… EIP-712 signature
  };
}

// EIP-712 domain/types — the canonical signed payload. Verification reconstructs
// this exact tuple from the VC and recovers the signer.
const DOMAIN = {
  name: "PepeLabAgentAuthorization",
  version: "1",
  chainId: AGENT_CHAIN_ID,
};

const TYPES: Record<string, ethers.TypedDataField[]> = {
  AgentTradingAuthorization: [
    { name: "issuer", type: "address" },
    { name: "agent", type: "address" },
    { name: "sessionId", type: "uint256" },
    { name: "maxMarginPerTrade", type: "string" },
    { name: "totalBudget", type: "string" },
    { name: "maxLeverage", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
  ],
};

function typedValue(p: {
  issuer: string;
  agent: string;
  sessionId: number;
  caps: AuthorizationCaps;
  issuedAt: number;
}) {
  return {
    issuer: ethers.getAddress(p.issuer),
    agent: ethers.getAddress(p.agent),
    sessionId: BigInt(p.sessionId),
    maxMarginPerTrade: p.caps.maxMarginPerTrade,
    totalBudget: p.caps.totalBudget,
    maxLeverage: BigInt(p.caps.maxLeverage),
    expiry: BigInt(p.caps.expiry),
    issuedAt: BigInt(p.issuedAt),
  };
}

/**
 * Issue (sign) an authorization VC. `issuer` is the user's wallet (the EOA that
 * created the on-chain session). The credential authorizes `agentAddress` to
 * trade within `sessionId` limited by `caps`.
 */
export async function issueAuthorizationVC(params: {
  issuer: ethers.Wallet | ethers.HDNodeWallet;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
}): Promise<AuthorizationVC> {
  const issuerAddr = await params.issuer.getAddress();
  const issuedAt = Math.floor(Date.now() / 1000);

  const value = typedValue({
    issuer: issuerAddr,
    agent: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
  });
  const signature = await params.issuer.signTypedData(DOMAIN, TYPES, value);

  const issuerDid = agentDid(issuerAddr);
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://pepelab.xyz/credentials/agent-authorization/v1",
    ],
    type: ["VerifiableCredential", "AgentTradingAuthorization"],
    issuer: issuerDid,
    issuanceDate: new Date(issuedAt * 1000).toISOString(),
    expirationDate: new Date(params.caps.expiry * 1000).toISOString(),
    credentialSubject: {
      id: agentDid(params.agentAddress),
      sessionId: params.sessionId,
      authorization: params.caps,
    },
    proof: {
      type: "EthereumEip712Signature2021",
      created: new Date(issuedAt * 1000).toISOString(),
      proofPurpose: "assertionMethod",
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue: signature,
    },
  };
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

    const value = typedValue({ issuer, agent, sessionId, caps, issuedAt });
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
