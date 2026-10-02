// Agent 授權 VC 的撤銷（狀態清單，ADR-016）helpers。
//
// 與 vc.ts 同一個原則：密碼學與 schema 全部重用既有實作（frontend/src/contracts/agentAuthStatus.ts
// ＋ agent/shared/src/vcStatus.ts），SDK 只提供：
//   1. 以 viem `signTypedData` 形狀回傳清單的 typed data（簽發者的錢包／HSM 簽，SDK 不持有金鑰）；
//   2. finalize：組裝並立即驗證；
//   3. `checkCredentialStatusWithList`：給一次性驗證的整合方用（自己抓清單、自己記最高 sequence）；
//      要快取／新鮮度／防重放全套，用 `createVcStatusChecker` ＋ `httpStatusSource` ＋ 狀態儲存。
import { getAddress, isAddress, type Address, type Hex } from "viem";

import {
  DEFAULT_STATUS_LIST_VALIDITY_SEC,
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
  STATUS_LIST_PRIMARY_TYPE,
  STATUS_LIST_TYPES,
  assembleStatusList,
  buildStatusListTypedValue,
  canonicalRevokedIds,
  credentialJti,
  isCredentialRevoked,
  statusListDomain,
  verifyStatusList,
  type CredentialStatusList,
  type StatusListReason,
  type VerifiedStatusList,
} from "../../shared/src/vcStatus.ts";
import type { SdkVerifyResult } from "./vc.ts";

export {
  DEFAULT_STATUS_LIST_VALIDITY_SEC,
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
  STATUS_LIST_PRIMARY_TYPE,
  credentialJti,
  isCredentialRevoked,
  verifyStatusList,
};
export {
  createVcStatusChecker,
  httpStatusSource,
  memoryStatusStateStore,
  fileStatusStateStore,
  STATUS_DIRECTORY_TYPE,
  DEFAULT_STATUS_CACHE_MAX_AGE_SEC,
  MAX_STATUS_CACHE_MAX_AGE_SEC,
} from "../../shared/src/vcStatus.ts";
export type {
  CredentialStatusList,
  CredentialStatusResult,
  CredentialStatusReason,
  StatusListReason,
  StatusSource,
  StatusStateStore,
  VcStatusChecker,
  VerifiedStatusList,
} from "../../shared/src/vcStatus.ts";

export interface StatusListTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof STATUS_LIST_TYPES;
  primaryType: typeof STATUS_LIST_PRIMARY_TYPE;
  message: ReturnType<typeof buildStatusListTypedValue>;
}

export interface StatusListDraft {
  issuer: Address;
  sequence: number;
  issuedAt: number;
  validUntil: number;
  revokedBefore: number;
  revoked: Hex[];
  verifyingContract: Address;
  typedData: StatusListTypedData;
}

export interface BuildStatusListParams {
  /** 簽發者（與要撤銷的 VC 同一個 issuer）。 */
  issuer: string;
  /** AgentSessionManager 位址（domain 的 verifyingContract）。必填。 */
  verifyingContract: string;
  /** 必須大於這個簽發者先前發佈過的任何 sequence。 */
  sequence: number;
  /** 撤銷的憑證 id（jti；v2 = VC 的 nonce）。新清單必須包含舊清單的項目（累積）。 */
  revoked?: string[];
  /** 撤銷所有 issuedAt < revokedBefore 的憑證。 */
  revokedBefore?: number;
  /** 預設現在（unix 秒）。 */
  issuedAt?: number;
  /** 預設 issuedAt + 30 天，最長 90 天。 */
  validUntil?: number;
}

/** 建構狀態清單的 EIP-712 typed data（不簽）。 */
export function buildStatusListTypedData(p: BuildStatusListParams): StatusListDraft {
  if (!isAddress(p.issuer) || /^0x0{40}$/i.test(p.issuer)) throw new Error(`issuer 不是合法的非零地址：${p.issuer}`);
  if (!isAddress(p.verifyingContract) || /^0x0{40}$/i.test(p.verifyingContract)) {
    throw new Error(`verifyingContract 不是合法的非零地址：${p.verifyingContract}`);
  }
  const issuer = getAddress(p.issuer);
  const verifyingContract = getAddress(p.verifyingContract);
  const issuedAt = p.issuedAt ?? Math.floor(Date.now() / 1000);
  const validUntil = p.validUntil ?? issuedAt + DEFAULT_STATUS_LIST_VALIDITY_SEC;
  const revokedBefore = p.revokedBefore ?? 0;
  for (const [k, v] of Object.entries({ sequence: p.sequence, issuedAt, validUntil, revokedBefore })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${k} 必須是非負整數：${v}`);
  }
  if (validUntil <= issuedAt) throw new Error(`validUntil(${validUntil}) 必須晚於 issuedAt(${issuedAt})`);
  if (validUntil - issuedAt > MAX_STATUS_LIST_VALIDITY_SEC) throw new Error(`清單有效期不得超過 ${MAX_STATUS_LIST_VALIDITY_SEC / 86400} 天`);
  if (revokedBefore > issuedAt) throw new Error(`revokedBefore(${revokedBefore}) 不得晚於 issuedAt(${issuedAt})`);
  const revoked = canonicalRevokedIds(p.revoked ?? []) as Hex[];
  if (revoked.length > MAX_STATUS_LIST_ENTRIES) throw new Error(`撤銷項目超過上限 ${MAX_STATUS_LIST_ENTRIES}`);
  const fields = { issuer, sequence: p.sequence, issuedAt, validUntil, revokedBefore, revoked };
  return {
    ...fields,
    verifyingContract,
    typedData: {
      domain: statusListDomain(verifyingContract) as StatusListTypedData["domain"],
      types: STATUS_LIST_TYPES,
      primaryType: STATUS_LIST_PRIMARY_TYPE,
      message: buildStatusListTypedValue(fields),
    },
  };
}

export class InvalidStatusListError extends Error {
  readonly reasonCode: StatusListReason;
  constructor(reasonCode: StatusListReason, reason: string) {
    super(`狀態清單無效（${reasonCode}）：${reason}`);
    this.name = "InvalidStatusListError";
    this.reasonCode = reasonCode;
  }
}

/** 以簽章組出狀態清單並立刻驗證（簽的人不是 issuer → 丟錯，不回傳半成品）。nowMs 為毫秒。 */
export function finalizeStatusList(draft: StatusListDraft, signature: Hex, opts: { nowMs?: number } = {}): CredentialStatusList {
  const doc = assembleStatusList({
    issuer: draft.issuer,
    sequence: draft.sequence,
    issuedAt: draft.issuedAt,
    validUntil: draft.validUntil,
    revokedBefore: draft.revokedBefore,
    revoked: draft.revoked,
    issuerAddress: draft.issuer,
    signature,
    verifyingContract: draft.verifyingContract,
  });
  const v = verifyStatusList(doc, { now: opts.nowMs, expectedIssuer: draft.issuer, expectedVerifyingContract: draft.verifyingContract });
  if (!v.valid) throw new InvalidStatusListError(v.reasonCode, v.reason);
  return doc;
}

/**
 * build → 簽發者簽 → finalize。`signTypedData` 例如 `(td) => walletClient.signTypedData({ account, ...td })`。
 * `nowMs`（毫秒）只影響 finalize 時的時效檢查，測試或以區塊時間驗證時用。
 */
export async function issueStatusList(
  p: BuildStatusListParams & { signTypedData: (typedData: StatusListTypedData) => Promise<Hex>; nowMs?: number },
): Promise<CredentialStatusList> {
  const draft = buildStatusListTypedData(p);
  return finalizeStatusList(draft, await p.signTypedData(draft.typedData), { nowMs: p.nowMs });
}

export interface ListStatusCheck {
  /** 寫入類動作只有 ok=true 才可以放行。 */
  ok: boolean;
  status: "active" | "revoked" | "unknown";
  reasonCode: "STATUS_ACTIVE" | "VC_REVOKED" | "VC_INVALID" | "STATUS_LIST_REPLAYED" | StatusListReason;
  message: string;
  list?: VerifiedStatusList;
}

/**
 * 以一份（呼叫端自己取得的）狀態清單判斷一張**已驗證**的 VC 是否被撤銷。無狀態：
 * 防重放靠呼叫端傳入 `minSequence`（它接受過的最高 sequence）。清單驗不過、過期、
 * sequence 太舊 → status=unknown、ok=false（寫入類必須拒絕）。
 * 清單「不存在」不在這裡判斷：沒有清單時呼叫端自行決定（見 ADR-016 §4.3 的 withheld 規則）。
 */
export function checkCredentialStatusWithList(
  verified: SdkVerifyResult,
  listDoc: unknown,
  opts: { expectedVerifyingContract: string; nowMs?: number; minSequence?: number },
): ListStatusCheck {
  if (!verified.valid || !verified.issuer) {
    return { ok: false, status: "unknown", reasonCode: "VC_INVALID", message: "VC 本身未通過驗證" };
  }
  const v = verifyStatusList(listDoc, {
    now: opts.nowMs,
    expectedIssuer: verified.issuer,
    expectedVerifyingContract: opts.expectedVerifyingContract,
  });
  if (!v.valid) return { ok: false, status: "unknown", reasonCode: v.reasonCode, message: v.reason };
  if (opts.minSequence !== undefined && v.list.sequence < opts.minSequence) {
    return {
      ok: false,
      status: "unknown",
      reasonCode: "STATUS_LIST_REPLAYED",
      message: `清單 sequence ${v.list.sequence} 舊於已接受的 ${opts.minSequence}`,
      list: v.list,
    };
  }
  if (isCredentialRevoked(verified, v.list)) {
    return { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: `憑證已被撤銷（清單 sequence ${v.list.sequence}）`, list: v.list };
  }
  return { ok: true, status: "active", reasonCode: "STATUS_ACTIVE", message: `清單 sequence ${v.list.sequence}：未撤銷`, list: v.list };
}
