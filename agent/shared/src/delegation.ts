// Agent DELEGATION credential (VC v3) — issue, hash, verify, cross-check with the
// chain, and the x402 Know-Your-Agent (KYA) Verifiable Presentation.
//
// SSI roles (docs/SSI_AGENT_DELEGATION.md):
//   • issuer   = the session user (EOA), signs the v3 credential with EIP-712 in their wallet
//   • holder   = the agent (session key), did:pkh:eip155:<chainId>:<address>
//   • verifier = write path (demo-agent / MCP, before trading) and signal-api (x402 KYA,
//                before accepting a payment)
//
// Schema = frontend/src/contracts/agentDelegation.ts (single source of truth, shared with
// the browser issuer). This module adds what needs a crypto library (ethers): hashing,
// signing, signature recovery, and the comparison with AgentSessionManager.
//
// v3 and the existing machinery:
//   • revocation: ADR-016 status list, jti = credentialSubject.nonce (same as v2). To reuse
//     vcStatus.ts / vcNonce.ts unchanged, `delegationAsVerifyResult` projects a v3 result
//     onto the v2-shaped VerifyResult (version 2 = "nonce-bearing" generation there).
//   • v2 VCs keep verifying through identity.ts → verifyAuthorizationVC; nothing there changes.
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
import { MAX_CLOCK_SKEW_SEC, type TypedDataSigner, type VerifyResult } from "./identity.ts";
import {
  AGENT_PRESENTATION_HEADER,
  AUTH_VC_CHAIN_ID,
  DEFAULT_X402_PERIOD_SEC,
  DELEGATION_TYPES,
  DELEGATION_VC_VERSION,
  PRESENTATION_PRIMARY_TYPE,
  PRESENTATION_TYPES,
  X402_DEFAULT_ENDPOINTS,
  assembleDelegationCredential,
  assemblePresentation,
  buildDelegationTypedValue,
  buildPresentationTypedValue,
  canonicalAssets,
  decodeHeaderJson,
  delegationDomain,
  delegationFieldsFromCredential,
  encodeHeaderJson,
  isDelegationCredential,
  matchX402Endpoint,
  newAuthNonce,
  presentationDomain,
  type AgentX402Presentation,
  type DelegationCredential,
  type DelegationFields,
  type X402Allowance,
} from "../../../frontend/src/contracts/agentAuth";

export {
  AGENT_KYA_HEADER,
  AGENT_KYA_SPEND_HEADER,
  AGENT_PRESENTATION_HEADER,
  DEFAULT_X402_PERIOD_SEC,
  DELEGATION_PRIMARY_TYPE,
  DELEGATION_TYPES,
  DELEGATION_VC_VERSION,
  PRESENTATION_PRIMARY_TYPE,
  PRESENTATION_TYPES,
  X402_DEFAULT_ENDPOINTS,
  X402_USDC_DECIMALS,
  assembleDelegationCredential,
  assemblePresentation,
  buildDelegationTypedValue,
  buildPresentationTypedValue,
  canonicalAssets,
  decodeHeaderJson,
  defaultStatusListCredential,
  delegationDomain,
  delegationFieldsFromCredential,
  encodeHeaderJson,
  isDelegationCredential,
  matchX402Endpoint,
  presentationDomain,
} from "../../../frontend/src/contracts/agentAuth";
export type {
  AgentX402Presentation,
  DelegationCredential,
  DelegationCredentialStatus,
  DelegationFields,
  PresentationFields,
  X402Allowance,
} from "../../../frontend/src/contracts/agentAuth";

const ZERO = "0x0000000000000000000000000000000000000000";
const TYPES = DELEGATION_TYPES as Record<string, ethers.TypedDataField[]>;
const VP_TYPES = PRESENTATION_TYPES as Record<string, ethers.TypedDataField[]>;

// ── Hash ─────────────────────────────────────────────────────────────────────

/**
 * credentialHash = EIP-712 digest of the v3 typed data. Anchored on chain by the session
 * user (SessionCredentialAnchor) and used as the x402 spend key. Any field change → new hash.
 */
export function delegationCredentialHash(fields: DelegationFields, chainId: number): string {
  return ethers.TypedDataEncoder.hash(
    delegationDomain(chainId, fields.sessionManager),
    TYPES,
    buildDelegationTypedValue(fields),
  ).toLowerCase();
}

/** credentialHash of a credential document (throws if malformed). */
export function credentialHashOf(vc: DelegationCredential): string {
  const { fields, chainId } = delegationFieldsFromCredential(vc);
  return delegationCredentialHash(fields, chainId);
}

// ── On-chain session view ────────────────────────────────────────────────────

export const SESSION_VIEW_ABI = [
  "function sessions(uint256) view returns (address user, address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 spentMargin, uint256 maxLeverage, uint256 expiry, bool revoked)",
  "function allowedAssets(uint256) view returns (bytes32[])",
] as const;

export const SESSION_ANCHOR_ABI = [
  "function anchor(uint256 sessionId, bytes32 credentialHash)",
  "function unanchor(uint256 sessionId, bytes32 credentialHash)",
  "function isAnchored(uint256 sessionId, bytes32 credentialHash) view returns (bool)",
  "function anchorStatus(uint256 sessionId, bytes32 credentialHash) view returns (bool recorded, bool sessionLive, address user, uint256 since)",
  "function currentCredential(uint256 sessionId) view returns (bytes32)",
  "function anchorCount(uint256 sessionId) view returns (uint256)",
  "function sessionManager() view returns (address)",
  "event CredentialAnchored(uint256 indexed sessionId, address indexed user, bytes32 indexed credentialHash, bytes32 previousHash, uint256 version)",
  "event CredentialUnanchored(uint256 indexed sessionId, address indexed user, bytes32 indexed credentialHash)",
] as const;

/** What a verifier reads from AgentSessionManager for one session. */
export interface OnchainSession {
  user: string;
  agent: string;
  maxMarginPerTrade: bigint;
  totalMarginBudget: bigint;
  maxLeverage: bigint;
  expiry: bigint;
  revoked: boolean;
  /** bytes32[]; empty = unrestricted. */
  allowedAssets: string[];
}

/** Read `sessions(id)` + `allowedAssets(id)`. */
export async function readOnchainSession(
  runner: ethers.ContractRunner,
  sessionManager: string,
  sessionId: number,
): Promise<OnchainSession> {
  const mgr = new ethers.Contract(sessionManager, SESSION_VIEW_ABI, runner);
  const [s, assets] = await Promise.all([mgr.sessions(sessionId), mgr.allowedAssets(sessionId) as Promise<string[]>]);
  return {
    user: ethers.getAddress(String(s.user)),
    agent: ethers.getAddress(String(s.agent)),
    maxMarginPerTrade: BigInt(s.maxMarginPerTrade),
    totalMarginBudget: BigInt(s.totalMarginBudget),
    maxLeverage: BigInt(s.maxLeverage),
    expiry: BigInt(s.expiry),
    revoked: Boolean(s.revoked),
    allowedAssets: [...assets].map(String),
  };
}

// ── Issue ────────────────────────────────────────────────────────────────────

export interface DelegationSessionTerms {
  maxMarginPerTrade: bigint | string;
  totalMarginBudget: bigint | string;
  maxLeverage: bigint | number;
  expiry: bigint | number;
  allowedAssets: readonly string[];
}

/** Session terms as the chain reports them (use with readOnchainSession). */
export function termsFromOnchain(s: OnchainSession): DelegationSessionTerms {
  return {
    maxMarginPerTrade: s.maxMarginPerTrade,
    totalMarginBudget: s.totalMarginBudget,
    maxLeverage: s.maxLeverage,
    expiry: s.expiry,
    allowedAssets: s.allowedAssets,
  };
}

/** Default x402 allowance: 0.10 USDC per day, 1 USDC total, both paid endpoints. */
export function defaultX402Allowance(over: Partial<X402Allowance> = {}): X402Allowance {
  return {
    maxPerPeriod: over.maxPerPeriod ?? "100000",
    periodSeconds: over.periodSeconds ?? DEFAULT_X402_PERIOD_SEC,
    maxTotal: over.maxTotal ?? "1000000",
    endpoints: over.endpoints ? [...over.endpoints] : [...X402_DEFAULT_ENDPOINTS],
  };
}

export interface IssueDelegationParams {
  issuerAddress: string;
  agentAddress: string;
  sessionManager: string;
  sessionId: number;
  session: DelegationSessionTerms;
  x402?: Partial<X402Allowance>;
  /** Chain of the session (DIDs + domain). Default AGENT_CHAIN_ID. */
  chainId?: number;
  /** Unix seconds. Default now. */
  validFrom?: number;
  /** Unix seconds. Default min(validFrom + 30 days, session expiry). */
  validUntil?: number;
  nonce?: string;
  /** credentialStatus.statusListCredential (default: urn; pass `<VC_STATUS_URL>/<issuer>.json` when published). */
  statusListCredential?: string;
}

/** Build the signed fields (validates the obvious mistakes before a wallet prompt). */
export function buildDelegationFields(p: IssueDelegationParams): DelegationFields {
  const validFrom = p.validFrom ?? Math.floor(Date.now() / 1000);
  const expiry = Number(p.session.expiry);
  const validUntil = p.validUntil ?? Math.min(validFrom + 30 * 24 * 3600, expiry);
  if (!ethers.isAddress(p.sessionManager) || p.sessionManager.toLowerCase() === ZERO)
    throw new Error("v3 委託憑證需要 sessionManager（AgentSessionManager 位址）");
  if (validUntil <= validFrom) throw new Error("validUntil 必須晚於 validFrom");
  if (validUntil > expiry) throw new Error("validUntil 不可晚於鏈上 session 到期時間");
  const x402 = defaultX402Allowance(p.x402);
  if (BigInt(x402.maxPerPeriod) > BigInt(x402.maxTotal)) throw new Error("x402.maxPerPeriod 不可大於 maxTotal");
  if (!(x402.periodSeconds > 0)) throw new Error("x402.periodSeconds 必須 > 0");
  return {
    issuer: ethers.getAddress(p.issuerAddress),
    agent: ethers.getAddress(p.agentAddress),
    sessionManager: ethers.getAddress(p.sessionManager),
    sessionId: p.sessionId,
    maxMarginPerTrade: BigInt(p.session.maxMarginPerTrade).toString(),
    totalMarginBudget: BigInt(p.session.totalMarginBudget).toString(),
    maxLeverage: Number(p.session.maxLeverage),
    sessionExpiry: expiry,
    allowedAssets: canonicalAssets(p.session.allowedAssets),
    x402,
    validFrom,
    validUntil,
    nonce: p.nonce ?? newAuthNonce(),
  };
}

/** Issue (sign) a v3 credential with a connected-wallet typed-data signer. */
export async function issueDelegationCredentialWithSigner(
  p: IssueDelegationParams & { signTypedData: TypedDataSigner },
): Promise<{ credential: DelegationCredential; credentialHash: string }> {
  const chainId = p.chainId ?? AGENT_CHAIN_ID;
  const fields = buildDelegationFields(p);
  const signature = await p.signTypedData(
    delegationDomain(chainId, fields.sessionManager),
    TYPES,
    buildDelegationTypedValue(fields),
  );
  const credential = assembleDelegationCredential({
    fields,
    chainId,
    signature,
    statusListCredential: p.statusListCredential,
  });
  return { credential, credentialHash: delegationCredentialHash(fields, chainId) };
}

/** Issue with a local key wallet (tests / PoC). The browser flow uses the wallet signer. */
export async function issueDelegationCredential(
  p: Omit<IssueDelegationParams, "issuerAddress"> & { issuer: ethers.Wallet | ethers.HDNodeWallet },
): Promise<{ credential: DelegationCredential; credentialHash: string }> {
  return issueDelegationCredentialWithSigner({
    ...p,
    issuerAddress: p.issuer.address,
    signTypedData: (d, t, v) => p.issuer.signTypedData(d, t, v),
  });
}

// ── Verify ───────────────────────────────────────────────────────────────────

export type DelegationReason =
  | "VC_MALFORMED"
  | "VC_WRONG_CHAIN"
  | "VC_BAD_SIGNATURE"
  | "VC_EXPIRED"
  | "VC_NOT_YET_VALID"
  | "VC_WRONG_VERIFYING_CONTRACT"
  | "VC_VALIDITY_EXCEEDS_SESSION"
  | "VC_STATUS_POINTER_MISMATCH"
  | "VC_X402_ALLOWANCE_INVALID";

export interface DelegationVerifyResult {
  valid: boolean;
  reasonCode?: DelegationReason;
  reason?: string;
  version: 3;
  chainId?: number;
  fields?: DelegationFields;
  issuer?: string;
  agent?: string;
  sessionId?: number;
  credentialHash?: string;
}

export interface VerifyDelegationOptions {
  /** ms; tests. */
  now?: number;
  /** Require domain.verifyingContract (= credentialSubject.sessionManager) to equal this. */
  expectedSessionManager?: string;
  /** Chains whose DIDs are accepted. Default: env DELEGATION_VC_CHAIN_IDS, else [AGENT_CHAIN_ID, AUTH_VC_CHAIN_ID]. */
  acceptedChainIds?: number[];
}

/** Accepted DID chains: env DELEGATION_VC_CHAIN_IDS (comma list) or [AGENT_CHAIN_ID, 84532]. */
export function acceptedDelegationChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.DELEGATION_VC_CHAIN_IDS?.trim();
  if (raw) {
    const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length) return ids;
  }
  return [...new Set([AGENT_CHAIN_ID, AUTH_VC_CHAIN_ID])];
}

/**
 * Verify a v3 credential's signature and self-consistency (pure; no chain, no status).
 * Callers then run `checkCredentialStatus(delegationAsVerifyResult(r), …)` and
 * `compareDelegationWithSession(r.fields, onchain)` — see verifyDelegationForWrite.
 */
export function verifyDelegationCredential(vc: DelegationCredential, opts: VerifyDelegationOptions = {}): DelegationVerifyResult {
  const nowMs = opts.now ?? Date.now();
  const bad = (reasonCode: DelegationReason, reason: string, extra: Partial<DelegationVerifyResult> = {}): DelegationVerifyResult => ({
    valid: false,
    reasonCode,
    reason,
    version: 3,
    ...extra,
  });
  try {
    if (!isDelegationCredential(vc)) return bad("VC_MALFORMED", "不是 v3 AgentDelegationCredential");
    if (!vc.proof?.proofValue || !/^0x[0-9a-fA-F]+$/.test(vc.proof.proofValue)) return bad("VC_MALFORMED", "缺少 proof.proofValue");
    const { fields, chainId } = delegationFieldsFromCredential(vc);
    const accepted = opts.acceptedChainIds ?? acceptedDelegationChainIds();
    if (!accepted.includes(chainId)) {
      return bad("VC_WRONG_CHAIN", `DID 的 chainId(${chainId}) 不在本驗證端接受的鏈 [${accepted.join(", ")}]`);
    }
    const d = vc.proof.eip712?.domain;
    if (!d || Number(d.chainId) !== chainId || String(d.verifyingContract).toLowerCase() !== fields.sessionManager.toLowerCase()) {
      return bad("VC_MALFORMED", "proof.eip712.domain 與 DID 的鏈或 credentialSubject.sessionManager 不一致");
    }
    const domain = delegationDomain(chainId, fields.sessionManager);
    const value = buildDelegationTypedValue(fields);
    const recovered = ethers.verifyTypedData(domain, TYPES, value, vc.proof.proofValue);
    if (recovered === ZERO || ethers.getAddress(recovered) !== ethers.getAddress(fields.issuer)) {
      return bad("VC_BAD_SIGNATURE", `簽章與 issuer 不符（recovered ${recovered}，issuer ${fields.issuer}）`);
    }
    const credentialHash = ethers.TypedDataEncoder.hash(domain, TYPES, value).toLowerCase();
    const ok: Partial<DelegationVerifyResult> = {
      chainId,
      fields,
      issuer: ethers.getAddress(fields.issuer),
      agent: ethers.getAddress(fields.agent),
      sessionId: fields.sessionId,
      credentialHash,
    };
    if (opts.expectedSessionManager && ethers.getAddress(opts.expectedSessionManager) !== ethers.getAddress(fields.sessionManager)) {
      return bad(
        "VC_WRONG_VERIFYING_CONTRACT",
        `憑證綁定的 session manager(${fields.sessionManager}) 非本驗證端使用的(${ethers.getAddress(opts.expectedSessionManager)})`,
        ok,
      );
    }
    if (String(vc.credentialStatus?.statusListIndex ?? "").toLowerCase() !== fields.nonce.toLowerCase()) {
      return bad("VC_STATUS_POINTER_MISMATCH", "credentialStatus.statusListIndex 必須等於 credentialSubject.nonce（jti）", ok);
    }
    if (fields.validUntil > fields.sessionExpiry) {
      return bad("VC_VALIDITY_EXCEEDS_SESSION", "validUntil 晚於鏈上 session 到期時間", ok);
    }
    const x = fields.x402;
    if (!(x.periodSeconds > 0) || BigInt(x.maxPerPeriod) > BigInt(x.maxTotal) || x.endpoints.length === 0) {
      return bad("VC_X402_ALLOWANCE_INVALID", "x402 額度不合法（periodSeconds 須 > 0、maxPerPeriod ≤ maxTotal、endpoints 不可為空）", ok);
    }
    if (fields.validFrom * 1000 > nowMs + MAX_CLOCK_SKEW_SEC * 1000) {
      return bad("VC_NOT_YET_VALID", `validFrom(${vc.validFrom}) 尚未到`, ok);
    }
    if (fields.validUntil * 1000 < nowMs) {
      return bad("VC_EXPIRED", `credential expired (validUntil ${vc.validUntil})`, ok);
    }
    return { valid: true, version: 3, ...ok };
  } catch (err) {
    return bad("VC_MALFORMED", (err as Error).message);
  }
}

/**
 * Project a v3 result onto the v2-shaped VerifyResult so the ADR-016 status checker
 * (vcStatus.ts) and the nonce/supersession store (vcNonce.ts) handle it unchanged:
 * both key v2 by `nonce` (jti) and v3 uses the same jti rule. `version: 2` there means
 * "nonce-bearing credential generation", and v3 is one.
 */
export function delegationAsVerifyResult(r: DelegationVerifyResult): VerifyResult {
  const f = r.fields;
  return {
    valid: r.valid,
    version: 2,
    issuer: r.issuer,
    agent: r.agent,
    sessionId: r.sessionId,
    issuedAt: f?.validFrom,
    validUntil: f?.validUntil,
    nonce: f?.nonce,
    verifyingContract: f ? ethers.getAddress(f.sessionManager) : undefined,
    digest: r.credentialHash,
    caps: f
      ? {
          maxMarginPerTrade: f.maxMarginPerTrade,
          totalBudget: f.totalMarginBudget,
          maxLeverage: f.maxLeverage,
          expiry: f.sessionExpiry,
        }
      : undefined,
  };
}

export type SessionMismatchCode =
  | "SESSION_USER_MISMATCH"
  | "SESSION_AGENT_MISMATCH"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "SESSION_TERMS_MISMATCH"
  | "SESSION_ASSETS_MISMATCH";

/**
 * Field-by-field comparison of the credential with `sessions(id)` (+ allowedAssets):
 * issuer = user, agent = agent, exact caps (raw units), expiry, canonical asset set,
 * and the session must be live. Returns null when everything matches.
 */
export function compareDelegationWithSession(
  f: DelegationFields,
  s: OnchainSession,
  nowSec: number = Math.floor(Date.now() / 1000),
): { code: SessionMismatchCode; message: string } | null {
  if (ethers.getAddress(s.user) !== ethers.getAddress(f.issuer))
    return { code: "SESSION_USER_MISMATCH", message: `憑證簽發者(${f.issuer}) 不是鏈上 session.user(${s.user})` };
  if (ethers.getAddress(s.agent) !== ethers.getAddress(f.agent))
    return { code: "SESSION_AGENT_MISMATCH", message: `憑證的代理人(${f.agent}) 不是鏈上 session.agent(${s.agent})` };
  if (s.revoked) return { code: "SESSION_REVOKED", message: `鏈上 session #${f.sessionId} 已撤銷` };
  if (BigInt(nowSec) > s.expiry) return { code: "SESSION_EXPIRED", message: `鏈上 session #${f.sessionId} 已到期` };
  const diffs: string[] = [];
  if (BigInt(f.maxMarginPerTrade) !== s.maxMarginPerTrade) diffs.push(`maxMarginPerTrade ${f.maxMarginPerTrade}≠${s.maxMarginPerTrade}`);
  if (BigInt(f.totalMarginBudget) !== s.totalMarginBudget) diffs.push(`totalMarginBudget ${f.totalMarginBudget}≠${s.totalMarginBudget}`);
  if (BigInt(f.maxLeverage) !== s.maxLeverage) diffs.push(`maxLeverage ${f.maxLeverage}≠${s.maxLeverage}`);
  if (BigInt(f.sessionExpiry) !== s.expiry) diffs.push(`expiry ${f.sessionExpiry}≠${s.expiry}`);
  if (diffs.length) return { code: "SESSION_TERMS_MISMATCH", message: `憑證額度與鏈上 session 不一致：${diffs.join("；")}` };
  const a = canonicalAssets(f.allowedAssets);
  const b = canonicalAssets(s.allowedAssets);
  if (a.length !== b.length || a.some((x, i) => x !== b[i]))
    return { code: "SESSION_ASSETS_MISMATCH", message: "憑證的資產白名單與鏈上 allowedAssets 不一致" };
  return null;
}

// ── Presentation (holder side) ───────────────────────────────────────────────

/** Canonical request path, the same rules signal-api's router applies (decode, collapse `//`, strip trailing `/`, lowercase first segment). */
export function canonicalRequestPath(pathname: string): string {
  let p = pathname.split(/[?#]/)[0] || "/";
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw; the server will reject the request anyway */
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.replace(/^\/([^/]+)/, (_m, seg: string) => `/${seg.toLowerCase()}`) || "/";
}

/** EIP-3009 authorization inside an x402 payment header (v1 X-PAYMENT or v2 PAYMENT-SIGNATURE). */
export interface PaymentAuthorization {
  from: string;
  to: string;
  value: bigint;
  nonce: string;
  validBefore: bigint;
}

/** Decode `payload.authorization` from a base64 x402 payment header; null if absent / malformed. */
export function paymentAuthorizationOf(header: string | null | undefined): PaymentAuthorization | null {
  if (!header) return null;
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload?: { authorization?: Record<string, unknown> };
    };
    const a = j?.payload?.authorization;
    if (!a) return null;
    const from = String(a.from ?? "");
    const to = String(a.to ?? "");
    const nonce = String(a.nonce ?? "");
    if (!ethers.isAddress(from) || !ethers.isAddress(to) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
    const value = BigInt(String(a.value ?? ""));
    const validBefore = BigInt(String(a.validBefore ?? "0"));
    if (value < 0n) return null;
    return { from: ethers.getAddress(from), to: ethers.getAddress(to), value, nonce: nonce.toLowerCase(), validBefore };
  } catch {
    return null;
  }
}

export interface PresentForX402Params {
  credential: DelegationCredential;
  /** Agent (holder) address; must be credentialSubject.id's address. */
  holderAddress: string;
  /** Agent key typed-data signer (GuardedWallet / guarded viem account pass the signing guard). */
  signTypedData: TypedDataSigner;
  method: string;
  /** Request path (or full URL); canonicalised. */
  path: string;
  /** The x402 payment header value this presentation travels with. */
  paymentHeader: string;
  /** Unix seconds; default now. */
  created?: number;
}

/**
 * Build the `X-Agent-Presentation` header value: a W3C VP holding the v3 credential, signed
 * (EIP-712) by the agent key and bound to METHOD + path + the payment's EIP-3009 nonce and payer.
 */
export async function presentForX402(p: PresentForX402Params): Promise<{ header: string; presentation: AgentX402Presentation }> {
  const auth = paymentAuthorizationOf(p.paymentHeader);
  if (!auth) throw new Error("付款 header 解不出 EIP-3009 authorization（無法綁定 presentation）");
  const { fields, chainId } = delegationFieldsFromCredential(p.credential);
  const holder = ethers.getAddress(p.holderAddress);
  if (holder !== ethers.getAddress(fields.agent)) throw new Error(`presentation 的 holder(${holder}) 不是憑證的代理人(${fields.agent})`);
  if (auth.from !== holder) throw new Error(`付款人(${auth.from}) 不是代理人(${holder})：KYA 要求付款人＝憑證主體`);
  let path = p.path;
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* treat as path */
  }
  const vpFields = {
    holder,
    credentialHash: delegationCredentialHash(fields, chainId),
    method: p.method.toUpperCase(),
    path: canonicalRequestPath(path),
    paymentNonce: auth.nonce,
    payer: auth.from,
    created: p.created ?? Math.floor(Date.now() / 1000),
  };
  const signature = await p.signTypedData(presentationDomain(chainId), VP_TYPES, buildPresentationTypedValue(vpFields));
  const presentation = assemblePresentation({ credential: p.credential, fields: vpFields, chainId, signature });
  return { header: encodeHeaderJson(presentation), presentation };
}

/** Normalise an origin allowlist entry (`https://api.example` or a full URL) to `scheme://host[:port]`. */
function originOf(u: string): string | null {
  try {
    return new URL(u).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * fetch wrapper that attaches `X-Agent-Presentation` to every request carrying an x402
 * payment header (X-PAYMENT or PAYMENT-SIGNATURE). Put it UNDER the x402 payment wrapper
 * (as the base fetch of wrapFetchWithPayment / @x402/fetch), like meteredFetch.
 *
 * The presentation carries the whole credential (user address, session terms, allowances), so it
 * is only sent to `allowedOrigins` (the KYA services this agent was told to pay). A paid request
 * to any other origin goes out without it — that service either does not ask for KYA or will
 * answer `kya_presentation_required`, and the agent's operator decides whether to trust it.
 */
export function kyaFetch(
  opts: { credential: DelegationCredential; holderAddress: string; signTypedData: TypedDataSigner; allowedOrigins: string[] },
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const allowed = new Set(opts.allowedOrigins.map(originOf).filter((o): o is string => o !== null));
  if (allowed.size === 0) throw new Error("kyaFetch：allowedOrigins 至少要有一個合法的 origin（憑證只送給明確信任的 KYA 服務）");
  return (async (input: string | URL | Request, init?: RequestInit) => {
    // Structural Request check (not instanceof) — same reason as meteredFetch: @hono/node-server
    // swaps globalThis.Request, and @x402/fetch sends a native request.clone().
    const isReq = typeof input === "object" && input !== null && "headers" in input && "url" in input;
    const r = isReq ? (input as Request) : null;
    const headers = new Headers(init?.headers ?? r?.headers);
    const pay = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
    if (!pay || headers.has(AGENT_PRESENTATION_HEADER)) return base(input, init);
    const url = r ? r.url : String(input);
    const origin = originOf(url);
    if (!origin || !allowed.has(origin)) return base(input, init);
    const method = init?.method ?? r?.method ?? "GET";
    const { header } = await presentForX402({
      credential: opts.credential,
      holderAddress: opts.holderAddress,
      signTypedData: opts.signTypedData,
      method,
      path: url,
      paymentHeader: pay,
    });
    headers.set(AGENT_PRESENTATION_HEADER, header);
    return base(input, { ...(init ?? {}), method, headers });
  }) as typeof globalThis.fetch;
}

// ── Presentation (verifier side) ─────────────────────────────────────────────

export type PresentationReason =
  | "KYA_PRESENTATION_MALFORMED"
  | "KYA_PRESENTATION_BAD_SIGNATURE"
  | "KYA_PRESENTATION_STALE"
  | "KYA_PRESENTATION_WRONG_REQUEST"
  | "KYA_PRESENTATION_WRONG_PAYMENT"
  | "KYA_HOLDER_NOT_SUBJECT"
  | "KYA_PAYER_NOT_SUBJECT";

export interface PresentationCheck {
  ok: boolean;
  reasonCode?: PresentationReason;
  reason?: string;
  credential?: DelegationCredential;
  holder?: string;
}

/** Default allowed clock skew for a presentation (seconds). */
export const KYA_PRESENTATION_MAX_SKEW_SEC = 120;

/**
 * Check the presentation itself (not the credential): well-formed, signed by its holder,
 * fresh, bound to THIS request and THIS payment, holder = credential subject = payer.
 * The credential inside still has to go through verifyDelegationCredential + status + chain.
 */
export function verifyX402Presentation(
  headerValue: string,
  req: { method: string; path: string; payment: PaymentAuthorization },
  opts: { now?: number; maxSkewSec?: number } = {},
): PresentationCheck {
  const fail = (reasonCode: PresentationReason, reason: string, extra: Partial<PresentationCheck> = {}): PresentationCheck => ({
    ok: false,
    reasonCode,
    reason,
    ...extra,
  });
  let vp: AgentX402Presentation;
  try {
    if (headerValue.length > 16_384) return fail("KYA_PRESENTATION_MALFORMED", "presentation 太大（> 16 KB）");
    vp = decodeHeaderJson<AgentX402Presentation>(headerValue);
  } catch {
    return fail("KYA_PRESENTATION_MALFORMED", "X-Agent-Presentation 不是 base64url JSON");
  }
  try {
    if (!Array.isArray(vp?.type) || !vp.type.includes("VerifiablePresentation"))
      return fail("KYA_PRESENTATION_MALFORMED", "不是 VerifiablePresentation");
    const vcs = vp.verifiableCredential;
    if (!Array.isArray(vcs) || vcs.length !== 1 || !isDelegationCredential(vcs[0]))
      return fail("KYA_PRESENTATION_MALFORMED", "presentation 必須恰好包含一張 v3 AgentDelegationCredential");
    const credential = vcs[0];
    const { fields, chainId } = delegationFieldsFromCredential(credential);
    const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(vp.holder ?? ""));
    if (!m || Number(m[1]) !== chainId) return fail("KYA_PRESENTATION_MALFORMED", "holder 必須是與憑證同鏈的 did:pkh");
    const holder = ethers.getAddress(m[2]!);
    const pr = vp.proof;
    const created = Math.floor(Date.parse(String(pr?.created ?? "")) / 1000);
    if (!Number.isFinite(created) || !/^0x[0-9a-fA-F]{64}$/.test(String(pr?.challenge ?? "")))
      return fail("KYA_PRESENTATION_MALFORMED", "proof.created／proof.challenge 不合法");
    const domainStr = String(pr.domain ?? "");
    const sp = domainStr.indexOf(" ");
    const method = domainStr.slice(0, sp).toUpperCase();
    const path = domainStr.slice(sp + 1);
    const credentialHash = delegationCredentialHash(fields, chainId);
    const vpFields = {
      holder,
      credentialHash,
      method,
      path,
      paymentNonce: String(pr.challenge).toLowerCase(),
      payer: ethers.isAddress(String(pr.payer ?? "")) ? ethers.getAddress(String(pr.payer)) : ZERO,
      created,
    };
    const recovered = ethers.verifyTypedData(presentationDomain(chainId), VP_TYPES, buildPresentationTypedValue(vpFields), String(pr.proofValue ?? ""));
    if (recovered === ZERO || ethers.getAddress(recovered) !== holder)
      return fail("KYA_PRESENTATION_BAD_SIGNATURE", `presentation 簽章不是 holder 簽的（recovered ${recovered}）`);
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    const skew = opts.maxSkewSec ?? KYA_PRESENTATION_MAX_SKEW_SEC;
    if (Math.abs(nowSec - created) > skew)
      return fail("KYA_PRESENTATION_STALE", `presentation 時間 ${pr.created} 與伺服器時間相差超過 ${skew} 秒`);
    if (method !== req.method.toUpperCase() || path !== req.path)
      return fail("KYA_PRESENTATION_WRONG_REQUEST", `presentation 綁定 ${domainStr}，本請求是 ${req.method.toUpperCase()} ${req.path}`);
    if (vpFields.paymentNonce !== req.payment.nonce.toLowerCase() || vpFields.payer !== req.payment.from)
      return fail("KYA_PRESENTATION_WRONG_PAYMENT", "presentation 綁定的付款（nonce／payer）不是本請求的付款");
    if (holder !== ethers.getAddress(fields.agent))
      return fail("KYA_HOLDER_NOT_SUBJECT", `presentation 簽者(${holder}) 不是憑證主體(${fields.agent})`);
    if (req.payment.from !== holder)
      return fail("KYA_PAYER_NOT_SUBJECT", `x402 付款人(${req.payment.from}) 不是憑證主體／presentation 簽者(${holder})`);
    return { ok: true, credential, holder };
  } catch (err) {
    return fail("KYA_PRESENTATION_MALFORMED", (err as Error).message);
  }
}

/** Is `vc` any agent credential this stack knows (v1/v2 authorization or v3 delegation)? */
export function agentCredentialVersion(vc: unknown): 1 | 2 | 3 | null {
  if (isDelegationCredential(vc)) return DELEGATION_VC_VERSION as 3;
  const v = vc as { proof?: { eip712Domain?: { version?: string } }; credentialSubject?: { authorization?: unknown } } | null;
  if (!v?.credentialSubject?.authorization) return null;
  return v.proof?.eip712Domain?.version === "2" ? 2 : 1;
}
