// 委託授權 VC v3（AgentDelegationCredential）＋ x402 KYA presentation 的 SDK helpers。
// docs/SSI_AGENT_DELEGATION.md。
//
// 密碼學與 schema 全部重用既有實作，不重寫：
//   • schema：frontend/src/contracts/agentDelegation.ts（前端簽發端的同一份）
//   • 雜湊、驗簽、presentation：agent/shared/src/delegation.ts
// SDK 的差別只有簽章端的形狀：回傳 viem `signTypedData` 用的 typed data（呼叫端的 wallet／HSM
// 簽，SDK 不持有金鑰），並把 viem 形狀的簽章函式轉給 shared。
import { getAddress, type Address, type Hex } from "viem";

import {
  DELEGATION_PRIMARY_TYPE,
  DELEGATION_TYPES,
  PRESENTATION_PRIMARY_TYPE,
  assembleDelegationCredential,
  buildDelegationFields,
  buildDelegationTypedValue,
  delegationCredentialHash,
  delegationDomain,
  kyaFetch as sharedKyaFetch,
  presentForX402 as sharedPresent,
  verifyDelegationCredential,
  type AgentX402Presentation,
  type DelegationCredential,
  type DelegationFields,
  type DelegationSessionTerms,
  type DelegationVerifyResult,
  type X402Allowance,
} from "../../shared/src/delegation.ts";
import type { TypedDataSigner } from "../../shared/src/identity.ts";

export type { AgentX402Presentation, DelegationCredential, DelegationFields, DelegationVerifyResult, X402Allowance };
export { verifyDelegationCredential, DELEGATION_PRIMARY_TYPE };

/** viem 形狀的 typed-data 簽章端：`(td) => walletClient.signTypedData({ account, ...td })`。 */
export type ViemTypedDataSigner = (typedData: {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<Hex>;

export interface CreateDelegationParams {
  /** 使用者（session 的建立者）—— 簽發者。 */
  issuer: Address;
  /** 代理人 session key —— 持有者。 */
  agent: Address;
  sessionManager: Address;
  sessionId: number;
  /** 鏈上 session 的原始值（sessions(id)＋allowedAssets(id)）；驗證端會逐欄比對。 */
  session: DelegationSessionTerms;
  /** x402 花費上限與允許端點（atomic USDC）。預設每日 0.10、總額 1.00、兩個付費端點。 */
  x402?: Partial<X402Allowance>;
  chainId: number;
  validFrom?: number;
  validUntil?: number;
  nonce?: Hex;
  statusListCredential?: string;
}

export interface DelegationDraft {
  fields: DelegationFields;
  chainId: number;
  /** = EIP-712 digest；使用者錨定到 SessionCredentialAnchor 的值。 */
  credentialHash: Hex;
  /** 交給 viem `walletClient.signTypedData(typedData)`。 */
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: typeof DELEGATION_TYPES;
    primaryType: typeof DELEGATION_PRIMARY_TYPE;
    message: ReturnType<typeof buildDelegationTypedValue>;
  };
  /** 拿到簽章後組出 W3C VC 2.0 文件（並立刻驗證簽章，不符就丟錯）。 */
  finalize(signature: Hex): DelegationCredential;
}

/**
 * 建立 v3 委託憑證：回傳待簽的 typed data 與 credentialHash；呼叫端簽完以 `finalize(sig)` 組出憑證。
 * 也可傳 `signTypedData` 一次完成（見 issueDelegationCredential）。
 */
export function createDelegationCredential(p: CreateDelegationParams): DelegationDraft {
  const fields = buildDelegationFields({
    issuerAddress: p.issuer,
    agentAddress: p.agent,
    sessionManager: p.sessionManager,
    sessionId: p.sessionId,
    session: p.session,
    x402: p.x402,
    chainId: p.chainId,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
    nonce: p.nonce,
  });
  const d = delegationDomain(p.chainId, fields.sessionManager);
  const typedData = {
    domain: { ...d, verifyingContract: getAddress(d.verifyingContract) },
    types: DELEGATION_TYPES,
    primaryType: DELEGATION_PRIMARY_TYPE,
    message: buildDelegationTypedValue(fields),
  };
  const credentialHash = delegationCredentialHash(fields, p.chainId) as Hex;
  return {
    fields,
    chainId: p.chainId,
    credentialHash,
    typedData,
    finalize(signature: Hex) {
      const credential = assembleDelegationCredential({
        fields,
        chainId: p.chainId,
        signature,
        statusListCredential: p.statusListCredential,
      });
      const r = verifyDelegationCredential(credential, {
        expectedSessionManager: fields.sessionManager,
        acceptedChainIds: [p.chainId],
        now: Math.max(Date.now(), fields.validFrom * 1000),
      });
      if (!r.valid) throw new Error(`委託憑證簽章驗證失敗（${r.reasonCode}）：${r.reason}`);
      return credential;
    },
  };
}

/** build → 呼叫端簽 → finalize。 */
export async function issueDelegationCredential(
  p: CreateDelegationParams & { signTypedData: ViemTypedDataSigner },
): Promise<{ credential: DelegationCredential; credentialHash: Hex }> {
  const draft = createDelegationCredential(p);
  const sig = await p.signTypedData(draft.typedData as never);
  return { credential: draft.finalize(sig), credentialHash: draft.credentialHash };
}

/** viem 形狀 → shared 的 (domain, types, value) 形狀（primaryType 由型別名稱推出）。 */
function adapt(sign: ViemTypedDataSigner): TypedDataSigner {
  return async (domain, types, value) => {
    const primaryType = Object.keys(types).includes(PRESENTATION_PRIMARY_TYPE)
      ? PRESENTATION_PRIMARY_TYPE
      : Object.keys(types).includes(DELEGATION_PRIMARY_TYPE)
        ? DELEGATION_PRIMARY_TYPE
        : Object.keys(types)[0]!;
    return sign({ domain: domain as Record<string, unknown>, types, primaryType, message: value });
  };
}

/**
 * x402 KYA：為一個付費請求產生 `X-Agent-Presentation` header（代理人金鑰以 EIP-712 簽，綁定
 * METHOD＋路徑＋這筆付款的 EIP-3009 nonce 與付款人）。`paymentHeader` 是同一請求的
 * X-PAYMENT（v1）或 PAYMENT-SIGNATURE（v2）。
 */
export async function presentForX402(p: {
  credential: DelegationCredential;
  holder: Address;
  signTypedData: ViemTypedDataSigner;
  method: string;
  /** 完整 URL 或路徑。 */
  url: string;
  paymentHeader: string;
}): Promise<{ header: string; presentation: AgentX402Presentation }> {
  return sharedPresent({
    credential: p.credential,
    holderAddress: p.holder,
    signTypedData: adapt(p.signTypedData),
    method: p.method,
    path: p.url,
    paymentHeader: p.paymentHeader,
  });
}

/** 包在 x402 付款 client 底下的 fetch：帶付款 header 的請求自動附上 presentation。 */
export function kyaFetch(
  p: { credential: DelegationCredential; holder: Address; signTypedData: ViemTypedDataSigner },
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return sharedKyaFetch({ credential: p.credential, holderAddress: p.holder, signTypedData: adapt(p.signTypedData) }, base);
}
