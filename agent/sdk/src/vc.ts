// Agent 授權 VC（v2，EIP-712）helpers。
//
// 密碼學與 schema 全部重用既有實作，不重寫：
//   • schema／typed data 建構：frontend/src/contracts/agentAuth.ts（前端簽發端的同一份）
//   • 驗簽：agent/shared/src/identity.ts 的 verifyAuthorizationVC（ethers.verifyTypedData）
// SDK 只多做三件事：
//   1. 以 viem 的 signTypedData 形狀回傳 typed data（呼叫端的 wallet／HSM 簽，SDK 不持有金鑰）；
//   2. **拒絕 v1**（shared 在 2026-12-31 前仍會讓 v1 帶警告通過；SDK 對新整合方一律不收）；
//   3. verifyingContract 在驗證時為必填（shared 是選填），避免把別的 session manager 的授權當真。
import { getAddress, isAddress, type Address, type Hex } from "viem";

import {
  AUTH_TYPES_V2,
  AUTH_VC_CHAIN_ID,
  assembleAuthorizationVC,
  authDomainV2,
  authVcVersion,
  buildAuthTypedValueV2,
  defaultValidUntil,
  newAuthNonce,
  verifyAuthorizationVC,
  type AuthorizationCaps,
  type AuthorizationVC,
  type VerifyResult,
} from "../../shared/src/identity.ts";
import { MARGIN_DECIMALS } from "./format.ts";
import type { SessionView } from "./read.ts";

export { AUTH_VC_CHAIN_ID };
export type { AuthorizationCaps, AuthorizationVC };

export const VC_PRIMARY_TYPE = "AgentTradingAuthorization" as const;

export interface AuthorizationTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof AUTH_TYPES_V2;
  primaryType: typeof VC_PRIMARY_TYPE;
  message: ReturnType<typeof buildAuthTypedValueV2>;
}

export interface AuthorizationDraft {
  issuer: Address;
  agent: Address;
  sessionId: number;
  caps: AuthorizationCaps;
  issuedAt: number;
  validUntil: number;
  nonce: Hex;
  verifyingContract: Address;
  /** 交給 viem `walletClient.signTypedData(typedData)`（或任何 EIP-712 簽署端）。 */
  typedData: AuthorizationTypedData;
}

export interface BuildAuthorizationParams {
  /** 使用者（session 的建立者）地址 —— 簽發者。 */
  issuer: string;
  /** agent 的 session key 地址 —— 持有者。 */
  agent: string;
  sessionId: number;
  caps: AuthorizationCaps;
  /** AgentSessionManager 位址（v2 domain 的 verifyingContract）。必填。 */
  verifyingContract: string;
  /** 預設現在（unix 秒）。 */
  issuedAt?: number;
  /** 預設 min(issuedAt + 30 天, caps.expiry)。 */
  validUntil?: number;
  /** 預設隨機 bytes32。 */
  nonce?: string;
}

function checkedAddress(label: string, a: string): Address {
  if (!isAddress(a) || /^0x0{40}$/i.test(a)) throw new Error(`${label} 不是合法的非零地址：${a}`);
  return getAddress(a);
}

/** 建構 v2 授權的 EIP-712 typed data（不簽）。 */
export function buildAuthorizationTypedData(p: BuildAuthorizationParams): AuthorizationDraft {
  const issuer = checkedAddress("issuer", p.issuer);
  const agent = checkedAddress("agent", p.agent);
  const verifyingContract = checkedAddress("verifyingContract", p.verifyingContract);
  if (!Number.isSafeInteger(p.sessionId) || p.sessionId < 0) throw new Error(`sessionId 不合法：${p.sessionId}`);
  const issuedAt = p.issuedAt ?? Math.floor(Date.now() / 1000);
  const validUntil = p.validUntil ?? defaultValidUntil(issuedAt, p.caps.expiry);
  if (validUntil <= issuedAt) throw new Error(`validUntil(${validUntil}) 必須晚於 issuedAt(${issuedAt})`);
  const nonce = (p.nonce ?? newAuthNonce()) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error(`nonce 必須是 bytes32：${nonce}`);
  const base = { issuer, agent, sessionId: p.sessionId, caps: p.caps, issuedAt };
  return {
    issuer,
    agent,
    sessionId: p.sessionId,
    caps: p.caps,
    issuedAt,
    validUntil,
    nonce,
    verifyingContract,
    typedData: {
      domain: authDomainV2(verifyingContract) as AuthorizationTypedData["domain"],
      types: AUTH_TYPES_V2,
      primaryType: VC_PRIMARY_TYPE,
      message: buildAuthTypedValueV2({ ...base, validUntil, nonce }),
    },
  };
}

export class InvalidAuthorizationError extends Error {
  readonly result: SdkVerifyResult;
  constructor(result: SdkVerifyResult) {
    super(`VC 無效（${result.reasonCode ?? "VC_INVALID"}）：${result.reason ?? ""}`);
    this.name = "InvalidAuthorizationError";
    this.result = result;
  }
}

/**
 * `nowMs` 必須是**毫秒**（Date.now() 的單位）。小於 1e11 幾乎一定是誤傳了秒 ——
 * 以秒當毫秒會讓「是否過期」的比較永遠不成立、過期 VC 被判為有效（審查 M4），所以直接丟錯。
 */
export const MIN_PLAUSIBLE_NOW_MS = 1e11;

function checkNowMs(nowMs: number | undefined): number | undefined {
  if (nowMs === undefined) return undefined;
  if (!Number.isFinite(nowMs) || nowMs < MIN_PLAUSIBLE_NOW_MS) {
    throw new Error(`nowMs 必須是毫秒（Date.now() 單位），收到 ${nowMs}；看起來像秒`);
  }
  return nowMs;
}

/** 以簽章組出 W3C VC，並立刻驗證（簽的人不是 issuer、或 typed data 被改過 → 丟錯，不回傳半成品）。 */
export function finalizeAuthorizationVC(draft: AuthorizationDraft, signature: Hex, opts: { nowMs?: number } = {}): AuthorizationVC {
  const vc = assembleAuthorizationVC({
    issuerAddress: draft.issuer,
    agentAddress: draft.agent,
    sessionId: draft.sessionId,
    caps: draft.caps,
    issuedAt: draft.issuedAt,
    signature,
    v2: { validUntil: draft.validUntil, nonce: draft.nonce, verifyingContract: draft.verifyingContract },
  });
  const r = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: draft.verifyingContract, nowMs: opts.nowMs });
  if (!r.valid) throw new InvalidAuthorizationError(r);
  return vc;
}

/** build → 呼叫端簽 → finalize。`signTypedData` 例如 `(td) => walletClient.signTypedData({ account, ...td })`。 */
export async function issueAuthorizationVC(
  p: BuildAuthorizationParams & { signTypedData: (typedData: AuthorizationTypedData) => Promise<Hex> },
): Promise<AuthorizationVC> {
  const draft = buildAuthorizationTypedData(p);
  const sig = await p.signTypedData(draft.typedData);
  return finalizeAuthorizationVC(draft, sig);
}

export type SdkVerifyResult = Omit<VerifyResult, "reasonCode"> & {
  reasonCode?: VerifyResult["reasonCode"] | "VC_V1_REJECTED";
};

/**
 * 驗證 v2 VC。與 shared 的差別：v1 一律拒絕（`VC_V1_REJECTED`），且 expectedVerifyingContract 必填。
 * 注意：這是無狀態驗證。nonce 一次性（防重放）需要持久狀態，由 verifier 自行記錄
 * （agent 端的實作見 agent/shared/src/vcNonce.ts）。
 */
export function verifyAuthorizationVCv2(
  vc: AuthorizationVC,
  /** nowMs：現在時間（**毫秒**），測試或以區塊時間驗證時用；省略為 Date.now()。 */
  opts: { expectedVerifyingContract: string; nowMs?: number },
): SdkVerifyResult {
  if (!opts?.expectedVerifyingContract || !isAddress(opts.expectedVerifyingContract)) {
    throw new Error("verifyAuthorizationVCv2 需要 expectedVerifyingContract（AgentSessionManager 位址）");
  }
  if (authVcVersion(vc) !== 2) {
    return {
      valid: false,
      reasonCode: "VC_V1_REJECTED",
      reason: "v1（舊格式，無 verifyingContract／validUntil／nonce）VC 不被 SDK 接受；請重新簽發 v2",
      version: 1,
    };
  }
  const nowMs = checkNowMs(opts.nowMs);
  const r = verifyAuthorizationVC(vc, { expectedVerifyingContract: opts.expectedVerifyingContract, now: nowMs });
  if (r.valid && r.version !== 2) {
    return { ...r, valid: false, reasonCode: "VC_V1_REJECTED", reason: "驗證結果不是 v2" };
  }
  return r;
}

export interface SessionCrossCheck {
  ok: boolean;
  /** 每一項不符的原因（ok=true 時為空）。 */
  mismatches: string[];
}

/**
 * VC 與鏈上 session 交叉比對（與 agent 下單前的檢查同一套規則）：
 * issuer = session.user、agent = session.agent、sessionId 相同、caps 與鏈上完全一致、
 * session 存在且在該區塊仍有效（未撤銷、未過期）。
 * `session` 請用 `read.getSession(id, { blockNumber })` 取得。
 */
export function crossCheckWithSession(verified: SdkVerifyResult, session: SessionView): SessionCrossCheck {
  const m: string[] = [];
  if (!verified.valid) m.push(`VC 無效：${verified.reasonCode ?? ""} ${verified.reason ?? ""}`.trim());
  if (!session.exists) m.push(`鏈上 session ${session.sessionId} 不存在`);
  if (verified.sessionId === undefined || BigInt(verified.sessionId) !== session.sessionId) {
    m.push(`VC sessionId(${verified.sessionId}) ≠ 鏈上(${session.sessionId})`);
  }
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (!eq(verified.issuer, session.user)) m.push(`VC issuer(${verified.issuer}) ≠ session.user(${session.user})`);
  if (!eq(verified.agent, session.agent)) m.push(`VC agent(${verified.agent}) ≠ session.agent(${session.agent})`);
  if (verified.verifyingContract && !eq(verified.verifyingContract, session.sessionManager)) {
    m.push(`VC verifyingContract(${verified.verifyingContract}) ≠ 讀取的 session manager(${session.sessionManager})`);
  }
  const c = verified.caps;
  if (c) {
    const toRaw = (s: string) => {
      try {
        return parseDecimal(s, MARGIN_DECIMALS);
      } catch {
        return null;
      }
    };
    if (toRaw(c.maxMarginPerTrade) !== session.maxMarginPerTrade.raw) m.push(`maxMarginPerTrade(${c.maxMarginPerTrade}) 與鏈上不符`);
    if (toRaw(c.totalBudget) !== session.totalMarginBudget.raw) m.push(`totalBudget(${c.totalBudget}) 與鏈上不符`);
    if (BigInt(c.maxLeverage) !== session.maxLeverage) m.push(`maxLeverage(${c.maxLeverage}) 與鏈上不符`);
    if (BigInt(c.expiry) !== session.expiry) m.push(`expiry(${c.expiry}) 與鏈上 session 到期不符`);
  } else {
    m.push("VC 沒有 caps");
  }
  if (session.revoked) m.push("鏈上 session 已撤銷");
  if (session.expired) m.push("鏈上 session 已過期（以區塊時間計）");
  return { ok: m.length === 0, mismatches: m };
}

/** "12.5" → 12500000000000000000n（18 位）。不接受超過精度或非十進位格式。 */
function parseDecimal(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) throw new Error(`不是十進位數字：${s}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`超過 ${decimals} 位小數：${s}`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
