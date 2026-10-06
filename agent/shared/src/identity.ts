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
//
// Versions (schema lives in frontend/src/contracts/agentAuth.ts):
//   v2 — domain binds `verifyingContract` (session manager), struct adds
//        `validUntil` + `nonce`. Issued by the frontend and `issueAuthorizationVC`.
//   v3 — AgentDelegationCredential (W3C VC 2.0, x402 allowance, on-chain anchor). Schema in
//        frontend/src/contracts/agentDelegation.ts; sign/verify/present in ./delegation.ts.
//        Additive: nothing in this file's v1/v2 path changes, and v2 keeps verifying.
//   v1 — legacy; verifies with a warning until LEGACY_VC_SUNSET_ISO, then rejected.
//        v1 has no nonce, but still takes part in supersession (vcNonce.ts), and once a
//        v2 VC was accepted for an (issuer, sessionId), v1 is refused for it.
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
import { getSessionManagerAddress } from "./provider.ts";
// Single source of truth for the EIP-712 schema + VC shape, shared with the
// frontend (browser-wallet issuer). Re-exported below so "@pepelab/shared"
// consumers — and the frontend, which imports the same file directly — stay
// byte-for-byte consistent. Mirrors how addresses.ts cross-imports frontend.
import {
  AUTH_DOMAIN,
  AUTH_TYPES,
  AUTH_TYPES_V2,
  AUTH_VC_CHAIN_ID,
  LEGACY_VC_SUNSET_ISO,
  authDomainV2,
  authVcVersion,
  buildAuthTypedValue,
  buildAuthTypedValueV2,
  assembleAuthorizationVC,
  defaultValidUntil,
  newAuthNonce,
  type AuthorizationCaps,
  type AuthorizationVC,
} from "../../../frontend/src/contracts/agentAuth";

export {
  AUTH_DOMAIN,
  AUTH_TYPES,
  AUTH_TYPES_V2,
  AUTH_VC_CHAIN_ID,
  AUTH_VC_VERSION,
  AUTH_VC_VERSION_LEGACY,
  AUTH_VC_VERSION_DELEGATION,
  LEGACY_VC_SUNSET_ISO,
  DEFAULT_VC_VALIDITY_SEC,
  authDomainV2,
  authVcVersion,
  buildAuthTypedValue,
  buildAuthTypedValueV2,
  assembleAuthorizationVC,
  defaultValidUntil,
  newAuthNonce,
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

const TYPES_V1: Record<string, ethers.TypedDataField[]> = AUTH_TYPES;
const TYPES_V2: Record<string, ethers.TypedDataField[]> = AUTH_TYPES_V2;

/** A connected-wallet EIP-712 signer (ethers Wallet/Signer or a wagmi adapter). */
export type TypedDataSigner = (
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, any>,
) => Promise<string>;

export interface IssueOptions {
  /** Session manager address for the v2 domain. Default: SESSION_MANAGER_ADDRESS env. */
  verifyingContract?: string;
  /** Credential expiry (unix s). Default: min(issuedAt + 30d, caps.expiry). */
  validUntil?: number;
  /** bytes32 nonce. Default: fresh random. */
  nonce?: string;
  /** Issue a legacy v1 VC (tests / migration only). */
  legacyV1?: boolean;
  /** Override issuedAt (unix s; tests only). */
  issuedAt?: number;
}

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
} & IssueOptions): Promise<AuthorizationVC> {
  const issuerAddr = await params.issuer.getAddress();
  return issueAuthorizationVCWithSigner({
    ...params,
    issuerAddress: issuerAddr,
    signTypedData: (d, t, v) => params.issuer.signTypedData(d, t, v),
  });
}

/**
 * Issue (sign) an authorization VC using a connected-wallet typed-data signer.
 * This is the true SSI path: the user (issuer) signs in their wallet (MetaMask),
 * so the private key never leaves the wallet. Defaults to the v2 format.
 */
export async function issueAuthorizationVCWithSigner(params: {
  issuerAddress: string;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
  signTypedData: TypedDataSigner;
} & IssueOptions): Promise<AuthorizationVC> {
  const issuedAt = params.issuedAt ?? Math.floor(Date.now() / 1000);
  const base = {
    issuer: params.issuerAddress,
    agent: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
  };
  if (params.legacyV1) {
    const signature = await params.signTypedData(AUTH_DOMAIN, TYPES_V1, buildAuthTypedValue(base));
    return assembleAuthorizationVC({ ...base, issuerAddress: base.issuer, agentAddress: base.agent, signature });
  }
  const verifyingContract = params.verifyingContract ?? getSessionManagerAddress();
  if (!ethers.isAddress(verifyingContract) || verifyingContract.toLowerCase() === ZERO) {
    throw new Error("v2 VC 需要 verifyingContract（session manager 位址）；請傳入或設定 SESSION_MANAGER_ADDRESS");
  }
  const validUntil = params.validUntil ?? defaultValidUntil(issuedAt, params.caps.expiry);
  const nonce = params.nonce ?? newAuthNonce();
  const value = buildAuthTypedValueV2({ ...base, validUntil, nonce });
  const signature = await params.signTypedData(authDomainV2(verifyingContract), TYPES_V2, value);
  return assembleAuthorizationVC({
    ...base,
    issuerAddress: base.issuer,
    agentAddress: base.agent,
    signature,
    v2: { validUntil, nonce, verifyingContract: ethers.getAddress(verifyingContract) },
  });
}

export interface VerifyOptions {
  /** 目前時間（ms），測試用。 */
  now?: number;
  /** v2：要求 VC 的 verifyingContract 等於這個位址（write.ts 傳 session manager）。 */
  expectedVerifyingContract?: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  /** 穩定原因代碼（valid=false 時）。 */
  reasonCode?:
    | "VC_MALFORMED"
    | "VC_WRONG_CHAIN"
    | "VC_BAD_SIGNATURE"
    | "VC_EXPIRED"
    | "VC_WRONG_VERIFYING_CONTRACT"
    | "VC_VERSION_INCONSISTENT"
    | "VC_ISSUED_IN_FUTURE"
    | "LEGACY_VC_SUNSET";
  issuer?: string;       // recovered issuer address (== signer)
  agent?: string;        // holder agent address
  sessionId?: number;
  caps?: AuthorizationCaps;
  /** 1 = legacy, 2 = current. */
  version?: 1 | 2;
  issuedAt?: number;
  validUntil?: number;
  nonce?: string;
  verifyingContract?: string;
  /** EIP-712 digest（簽章內容的摘要），nonce 一次性檢查用來綁定 nonce 與內容。 */
  digest?: string;
  warnings?: string[];
}

const warnedLegacy = new Set<string>();

/** issuedAt 可容忍的未來時鐘誤差（秒）。 */
export const MAX_CLOCK_SKEW_SEC = 300;

/**
 * Verify an authorization VC: recover the EIP-712 signer and require it to equal
 * the issuer named in the credential. Returns the authorized agent + caps so the
 * caller (verifier) can cross-check against the on-chain session.
 *
 * Any tampering (caps, agent, sessionId, issuer, validUntil, nonce, verifyingContract)
 * changes the recovered address → mismatch → `valid:false`.
 *
 * Nonce 一次性檢查需要本地狀態，不在這個純函式裡做 —— 見 vcNonce.ts（write.ts 在
 * 鏈上交叉比對通過後呼叫）。
 */
export function verifyAuthorizationVC(vc: AuthorizationVC, opts: VerifyOptions = {}): VerifyResult {
  const nowMs = opts.now ?? Date.now();
  try {
    if (!vc?.proof?.proofValue) return { valid: false, reasonCode: "VC_MALFORMED", reason: "missing proof" };

    const issuerDid = parseDidPkh(vc.issuer);
    const agentDidParsed = parseDidPkh(vc.credentialSubject.id);
    const issuer = issuerDid.address;
    const agent = agentDidParsed.address;
    const caps = vc.credentialSubject.authorization;
    const sessionId = vc.credentialSubject.sessionId;

    // DID 的 chainId 必須綁定（稽核 四·Low）：EIP-712 簽的是「地址」，不是完整 DID，
    // 所以把 `did:pkh:eip155:84532:0x…` 改成 `eip155:1:0x…` 以前照樣 valid:true，
    // 而 vcId（proofValue 的摘要）也不變 —— 一張 Base Sepolia 的授權會被讀成
    // 主網身分。這裡明確要求兩個 DID 都在本 VC schema 綁定的鏈上。
    if (issuerDid.chainId !== AUTH_VC_CHAIN_ID) {
      return {
        valid: false,
        reasonCode: "VC_WRONG_CHAIN",
        reason: `issuer DID 的 chainId(${issuerDid.chainId}) 非本 VC schema 綁定的鏈(${AUTH_VC_CHAIN_ID})`,
      };
    }
    if (agentDidParsed.chainId !== AUTH_VC_CHAIN_ID) {
      return {
        valid: false,
        reasonCode: "VC_WRONG_CHAIN",
        reason: `holder DID 的 chainId(${agentDidParsed.chainId}) 非本 VC schema 綁定的鏈(${AUTH_VC_CHAIN_ID})`,
      };
    }

    // Reconstruct issuedAt from the proof's created timestamp (signed field).
    const issuedAt = Math.floor(new Date(vc.proof.created).getTime() / 1000);
    const version = authVcVersion(vc);
    const base = { issuer, agent, sessionId, caps, issuedAt };

    let domain: ethers.TypedDataDomain;
    let types: Record<string, ethers.TypedDataField[]>;
    let value: Record<string, unknown>;
    let validUntil: number | undefined;
    let nonce: string | undefined;
    let verifyingContract: string | undefined;

    if (version === 2) {
      const vcAddr = vc.proof.eip712Domain!.verifyingContract;
      if (!ethers.isAddress(vcAddr)) {
        return { valid: false, reasonCode: "VC_MALFORMED", reason: "eip712Domain.verifyingContract 不是合法地址" };
      }
      verifyingContract = ethers.getAddress(vcAddr);
      validUntil = Number(vc.credentialSubject.validUntil);
      nonce = String(vc.credentialSubject.nonce ?? "");
      if (!Number.isFinite(validUntil) || validUntil <= 0 || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
        return { valid: false, reasonCode: "VC_MALFORMED", reason: "v2 VC 缺少合法的 validUntil / nonce" };
      }
      domain = authDomainV2(verifyingContract);
      types = TYPES_V2;
      value = buildAuthTypedValueV2({ ...base, validUntil, nonce });
    } else {
      // 帶了 v2 欄位卻沒有 v2 domain 標記 → 版本不一致，拒絕（不猜）。
      if (vc.credentialSubject.nonce !== undefined || vc.credentialSubject.validUntil !== undefined) {
        return { valid: false, reasonCode: "VC_VERSION_INCONSISTENT", reason: "VC 帶 nonce/validUntil 但沒有 v2 domain 標記" };
      }
      domain = AUTH_DOMAIN;
      types = TYPES_V1;
      value = buildAuthTypedValue(base);
    }

    const recovered = ethers.verifyTypedData(domain, types, value, vc.proof.proofValue);
    if (recovered === ZERO || ethers.getAddress(recovered) !== ethers.getAddress(issuer)) {
      return {
        valid: false,
        reasonCode: "VC_BAD_SIGNATURE",
        reason: `signature does not match issuer (recovered ${recovered}, expected ${issuer})`,
      };
    }
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    const ok = { issuer, agent, sessionId, caps, version, issuedAt, validUntil, nonce, verifyingContract, digest };

    if (
      version === 2 &&
      opts.expectedVerifyingContract &&
      ethers.getAddress(opts.expectedVerifyingContract) !== verifyingContract
    ) {
      return {
        valid: false,
        reasonCode: "VC_WRONG_VERIFYING_CONTRACT",
        reason: `VC 綁定的 session manager(${verifyingContract}) 非本 agent 使用的(${ethers.getAddress(opts.expectedVerifyingContract)})`,
        ...ok,
      };
    }

    // issuedAt 不可在未來：取代規則以 issuedAt 最新者為準，未來時間戳的 VC 會永遠「最新」、
    // 讓使用者之後重簽的 VC 都被判成舊的。容忍 300 秒時鐘誤差。
    if (issuedAt * 1000 > nowMs + MAX_CLOCK_SKEW_SEC * 1000) {
      return {
        valid: false,
        reasonCode: "VC_ISSUED_IN_FUTURE",
        reason: `VC issuedAt(${new Date(issuedAt * 1000).toISOString()}) 晚於現在 ${MAX_CLOCK_SKEW_SEC} 秒以上`,
        ...ok,
      };
    }

    // 淘汰期限先判（比「過期」更能說明該怎麼處理：重新簽發 v2）。
    if (version === 1 && nowMs > Date.parse(LEGACY_VC_SUNSET_ISO)) {
      return {
        valid: false,
        reasonCode: "LEGACY_VC_SUNSET",
        reason: `v1（舊格式）VC 已於 ${LEGACY_VC_SUNSET_ISO} 停止接受，請在 /sessions 重新簽發`,
        ...ok,
      };
    }

    // Expiry check (credential-level; the chain session also enforces its own).
    if (caps.expiry * 1000 < nowMs) {
      return { valid: false, reasonCode: "VC_EXPIRED", reason: "credential expired", ...ok };
    }
    if (validUntil !== undefined && validUntil * 1000 < nowMs) {
      return { valid: false, reasonCode: "VC_EXPIRED", reason: `credential expired (validUntil ${new Date(validUntil * 1000).toISOString()})`, ...ok };
    }

    if (version === 1) {
      const warning =
        `LEGACY_VC_V1：此 VC 為舊格式（無 verifyingContract / validUntil / nonce），` +
        `仍可使用至 ${LEGACY_VC_SUNSET_ISO}，之後將被拒絕；請在 /sessions 重新簽發 v2。`;
      const key = vc.proof.proofValue;
      if (!warnedLegacy.has(key)) {
        warnedLegacy.add(key);
        console.warn(`[vc] ⚠ ${warning}`);
      }
      return { valid: true, ...ok, warnings: [warning] };
    }

    return { valid: true, ...ok };
  } catch (err) {
    return { valid: false, reasonCode: "VC_MALFORMED", reason: (err as Error).message };
  }
}
