// 合格投資人 VC：簽發、驗證、狀態清單（撤銷）——docs/SSI_RWA_ACCESS.md。
//
// 與既有程式的關係（不另起一套）：
//   • EIP-712 schema 與文件格式的單一真相來源：frontend/src/contracts/investorCredential.ts
//     （前端與這裡共用，比照 agentAuth.ts／agentAuthStatus.ts 的作法）。
//   • 撤銷：沿用 ADR-016 的狀態清單結構（sequence、revokedBefore、正規排序的 revoked、有效期上限），
//     primary type 換成 InvestorCredentialStatusList（DESIGN_BESU.md §3.4 的建議），domain 綁
//     VCKycRegistry（chainId＋合約位址）。驗證端的防重放、同號異文偵測、sticky 撤銷記憶、
//     清單來源（本機目錄＋目錄標記、HTTP 不跟隨轉址）全部直接重用 agent/shared/src/vcStatus.ts 的
//     StatusStateStore／dirStatusSource／httpStatusSource／isCredentialRevoked。
//     沒有重用的只有 verifyStatusList 與 createVcStatusChecker：它們把 domain 寫死成 agent 授權 VC 的
//     domain（name PepeLabAgentAuthorization、chainId 84532、verifyingContract = session manager），
//     改它們會讓 signal-api 的 Vercel bundle 指紋改變（ADR-016 §5）。換 domain／primary type 的清單驗簽
//     放在共用 schema（verifyInvestorStatusListWith，前端同一份），這裡只有一個不快取的薄檢查器。
//   • VC 驗證（verifyInvestorCredentialWith）也在共用 schema：瀏覽器與發證服務跑同一套檢查，
//     crypto（ethers v6）由呼叫端注入；DID 規則與 identity.ts 的 did:pkh 相同、時鐘誤差同為 300 秒。
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import type { TypedDataSigner } from "../shared/src/identity.ts";
import {
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
  REVOKE_ALL_LEAD_SEC,
  isCredentialRevoked,
  stateKey,
  statusListExpiryWarning,
  type IssuerStatusState,
  type StatusSource,
  type StatusStateStore,
} from "../shared/src/vcStatus.ts";
import {
  ATTESTATION_TYPES,
  DEFAULT_ATTESTATION_SUBMIT_WINDOW_DAYS,
  DEFAULT_INVESTOR_VC_VALIDITY_DAYS,
  INVESTOR_STATUS_LIST_TYPES,
  VC_KYC_REGISTRY_ABI,
  assembleInvestorCredential,
  assembleInvestorStatusList,
  buildAttestationValue,
  buildInvestorStatusListValue,
  canonicalRevokedIds,
  vcKycDomain,
  type AttestationValue,
  type CredentialTypeName,
  type InvestorCredential,
  type InvestorStatusList,
  type VcKycDomain,
  type Eip712Crypto,
  type InvestorVcVerifyResult,
  type VerifyInvestorVcOptions,
  type InvestorListVerifyResult,
  verifyInvestorCredentialWith,
  verifyInvestorStatusListWith,
} from "../../frontend/src/contracts/investorCredential";

export * from "../../frontend/src/contracts/investorCredential";

const ZERO = ethers.ZeroAddress;
const DAY = 86400;
const isSafeUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const typesOf = (t: Record<string, { name: string; type: string }[]>) => t as Record<string, ethers.TypedDataField[]>;

/** 憑證 id（jti）→ 鏈上撤銷鍵 credentialHash = keccak256(utf8(id))。 */
export const credentialHashOf = (id: string): string => ethers.id(id).toLowerCase();

/** EIP-712 digest（與 VCKycRegistry.attestationDigest 相同）。 */
export function attestationDigest(domain: VcKycDomain, value: AttestationValue): string {
  return ethers.TypedDataEncoder.hash(domain, typesOf(ATTESTATION_TYPES), value);
}

/** 給合約呼叫用的 tuple（ethers 接受物件形式）。 */
export function toContractAttestation(v: AttestationValue) {
  return {
    subject: v.subject,
    credentialType: v.credentialType,
    credentialHash: v.credentialHash,
    statusListIndex: BigInt(v.statusListIndex),
    issuedAt: BigInt(v.issuedAt),
    expiresAt: BigInt(v.expiresAt),
    nonce: BigInt(v.nonce),
    deadline: BigInt(v.deadline),
  };
}

export const registryInterface = new ethers.Interface(VC_KYC_REGISTRY_ABI as unknown as string[]);

// ── 簽發 ──────────────────────────────────────────────────────────────────────

export interface IssueInvestorVcParams {
  issuerAddress: string;
  signTypedData: TypedDataSigner;
  chainId: number;
  registry: string;
  subject: string;
  credentialType?: CredentialTypeName;
  /** 狀態清單的 base URL（`<base>/<issuer 小寫>.json`）。 */
  statusBaseUrl: string;
  statusListIndex: number;
  /** 必須等於鏈上 registry.nonces(subject)。 */
  nonce: number | bigint;
  /** 預設現在（unix 秒）。 */
  issuedAt?: number;
  validDays?: number;
  /** 簽章最晚可送上鏈的時間；預設 issuedAt + 30 天，不得晚於到期。 */
  deadline?: number;
  /** VC id；預設 urn:uuid:<隨機>。 */
  id?: string;
}

export async function issueInvestorCredentialWithSigner(p: IssueInvestorVcParams): Promise<InvestorCredential> {
  const issuer = ethers.getAddress(p.issuerAddress);
  const subject = ethers.getAddress(p.subject);
  const registry = ethers.getAddress(p.registry);
  if (registry === ZERO) throw new Error("registry 位址不可為 0");
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new Error(`chainId 不合法：${p.chainId}`);
  const credentialType = p.credentialType ?? "QUALIFIED_INVESTOR";
  const issuedAt = p.issuedAt ?? Math.floor(Date.now() / 1000);
  const validDays = p.validDays ?? DEFAULT_INVESTOR_VC_VALIDITY_DAYS;
  if (!(validDays > 0 && validDays <= 3 * 365)) throw new Error("validDays 必須在 (0, 1095] 天");
  const expiresAt = issuedAt + Math.round(validDays * DAY);
  const deadline = Math.min(p.deadline ?? issuedAt + DEFAULT_ATTESTATION_SUBMIT_WINDOW_DAYS * DAY, expiresAt);
  if (!isSafeUint(p.statusListIndex)) throw new Error("statusListIndex 必須是非負整數");
  const id = p.id ?? `urn:uuid:${randomUUID()}`;
  const value = buildAttestationValue({
    subject,
    credentialType,
    credentialHash: credentialHashOf(id),
    statusListIndex: p.statusListIndex,
    issuedAt,
    expiresAt,
    nonce: p.nonce,
    deadline,
  });
  const domain = vcKycDomain(p.chainId, registry);
  const signature = await p.signTypedData(domain, typesOf(ATTESTATION_TYPES), value);
  return assembleInvestorCredential({
    id,
    issuer,
    value,
    credentialType,
    domain,
    signature,
    statusBaseUrl: p.statusBaseUrl,
  });
}

export async function issueInvestorCredential(
  p: Omit<IssueInvestorVcParams, "issuerAddress" | "signTypedData"> & { issuer: ethers.Wallet | ethers.HDNodeWallet },
): Promise<InvestorCredential> {
  return issueInvestorCredentialWithSigner({
    ...p,
    issuerAddress: await p.issuer.getAddress(),
    signTypedData: (d, t, v) => p.issuer.signTypedData(d, t, v),
  });
}

// ── 驗證 VC ───────────────────────────────────────────────────────────────────

export const ETHERS_CRYPTO: Eip712Crypto = {
  id: (t) => ethers.id(t),
  getAddress: (a) => ethers.getAddress(a),
  verifyTypedData: (d, t, v, s) => ethers.verifyTypedData(d, typesOf(t), v, s),
  hashTypedData: (d, t, v) => ethers.TypedDataEncoder.hash(d, typesOf(t), v),
};

/** 驗 VC：結構、jti 雜湊、EIP-712 簽章（還原者必須是 issuer）、domain、時效。邏輯在共用 schema（前端同一份）。 */
export function verifyInvestorCredential(doc: unknown, opts: VerifyInvestorVcOptions = {}): InvestorVcVerifyResult {
  return verifyInvestorCredentialWith(ETHERS_CRYPTO, doc, opts);
}

// ── 狀態清單 ──────────────────────────────────────────────────────────────────

export interface IssueInvestorStatusListParams {
  issuerAddress: string;
  signTypedData: TypedDataSigner;
  chainId: number;
  registry: string;
  sequence: number;
  issuedAt?: number;
  /** 預設 issuedAt + 30 天；上限 90 天（與 ADR-016 相同）。 */
  validUntil?: number;
  revokedBefore?: number;
  /** 被撤銷的 credentialHash。 */
  revoked?: string[];
}

export async function issueInvestorStatusListWithSigner(p: IssueInvestorStatusListParams): Promise<InvestorStatusList> {
  const issuer = ethers.getAddress(p.issuerAddress);
  const issuedAt = p.issuedAt ?? Math.floor(Date.now() / 1000);
  const validUntil = p.validUntil ?? issuedAt + 30 * DAY;
  const revokedBefore = p.revokedBefore ?? 0;
  const revoked = canonicalRevokedIds(p.revoked ?? []);
  for (const [k, v] of Object.entries({ sequence: p.sequence, issuedAt, validUntil, revokedBefore })) {
    if (!isSafeUint(v)) throw new Error(`${k} 必須是非負整數：${v}`);
  }
  if (validUntil <= issuedAt) throw new Error("validUntil 必須晚於 issuedAt");
  if (validUntil - issuedAt > MAX_STATUS_LIST_VALIDITY_SEC) throw new Error("清單有效期不得超過 90 天");
  if (revokedBefore > issuedAt + REVOKE_ALL_LEAD_SEC) throw new Error("revokedBefore 不得晚於 issuedAt + 301 秒");
  if (revoked.length > MAX_STATUS_LIST_ENTRIES) throw new Error(`撤銷項目超過上限 ${MAX_STATUS_LIST_ENTRIES}`);
  const domain = vcKycDomain(p.chainId, ethers.getAddress(p.registry));
  const fields = { issuer, sequence: p.sequence, issuedAt, validUntil, revokedBefore, revoked };
  const signature = await p.signTypedData(domain, typesOf(INVESTOR_STATUS_LIST_TYPES), buildInvestorStatusListValue(fields));
  return assembleInvestorStatusList({ ...fields, domain, signature });
}

export async function issueInvestorStatusList(
  p: Omit<IssueInvestorStatusListParams, "issuerAddress" | "signTypedData"> & { issuer: ethers.Wallet | ethers.HDNodeWallet },
): Promise<InvestorStatusList> {
  return issueInvestorStatusListWithSigner({
    ...p,
    issuerAddress: await p.issuer.getAddress(),
    signTypedData: (d, t, v) => p.issuer.signTypedData(d, t, v),
  });
}

/** 驗狀態清單（ADR-016 §4.1 的規則，domain 綁 registry）。邏輯在共用 schema。 */
export function verifyInvestorStatusList(
  doc: unknown,
  opts: { now?: number; expectedIssuer?: string; expectedChainId?: number; expectedRegistry?: string } = {},
): InvestorListVerifyResult {
  return verifyInvestorStatusListWith(ETHERS_CRYPTO, doc, opts);
}

// ── 檢查器（重用 vcStatus.ts 的狀態儲存與來源）──────────────────────────────────

export interface InvestorStatusResult {
  ok: boolean;
  status: "active" | "revoked" | "unknown";
  reasonCode: string;
  message: string;
  listSequence?: number;
  warnings?: string[];
}

/** 給 isCredentialRevoked 用的最小視圖：jti = credentialHash（以 v2 的 nonce 欄位承載）。 */
const asStatusView = (v: { credentialHash: string; issuedAt: number }) => ({
  version: 2 as const,
  nonce: v.credentialHash,
  digest: undefined,
  issuedAt: v.issuedAt,
});

/**
 * 查某張已驗簽的投資人 VC 的撤銷狀態。fail-closed：來源不可達、清單驗不過、重放、同號異文、
 * 被扣住（曾接受過清單、來源卻說沒有）一律 ok=false（status unknown）。已知撤銷（sticky）優先。
 * 不快取：發證服務與准入流程每次動作只查一次。
 */
export async function checkInvestorCredentialStatus(
  vc: { issuer: string; credentialHash: string; issuedAt: number; domain: VcKycDomain },
  deps: { source: StatusSource; store: StatusStateStore; now?: () => number },
): Promise<InvestorStatusResult> {
  const nowMs = (deps.now ?? Date.now)();
  const registry = ethers.getAddress(vc.domain.verifyingContract);
  const issuer = ethers.getAddress(vc.issuer);
  const key = stateKey(`${vc.domain.chainId}:${registry}`, issuer);
  const view = asStatusView(vc);
  const unknown = (reasonCode: string, message: string): InvestorStatusResult => ({ ok: false, status: "unknown", reasonCode, message });

  let known: IssuerStatusState | null;
  try {
    known = await deps.store.get(key);
  } catch {
    return unknown("STATUS_STATE_UNREADABLE", "狀態檔無法讀取或格式不符");
  }
  if (known && isCredentialRevoked(view, known)) {
    return { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: `憑證已被發證者撤銷（清單 sequence ${known.sequence}）`, listSequence: known.sequence };
  }

  let f: Awaited<ReturnType<StatusSource["fetch"]>>;
  try {
    f = await deps.source.fetch(issuer);
  } catch (e) {
    return unknown("STATUS_UNAVAILABLE", `狀態檢查失敗：${(e as Error).message}`);
  }
  if (f.kind === "unavailable") return unknown("STATUS_UNAVAILABLE", `無法取得狀態清單：${f.reason}`);
  if (f.kind === "none") {
    if (known) return unknown("STATUS_LIST_WITHHELD", `來源沒有回傳清單，但本驗證端已接受過 sequence ${known.sequence}`);
    return { ok: true, status: "active", reasonCode: "STATUS_NO_LIST", message: "發證者沒有發佈狀態清單（沒有撤銷）" };
  }
  const v = verifyInvestorStatusList(f.doc, {
    now: nowMs,
    expectedIssuer: issuer,
    expectedChainId: vc.domain.chainId,
    expectedRegistry: registry,
  });
  if (!v.valid) return unknown(v.reasonCode, v.reason);
  const { chainId: _c, ...list } = v.list;
  let a: Awaited<ReturnType<StatusStateStore["accept"]>>;
  try {
    a = await deps.store.accept(key, list, Math.floor(nowMs / 1000));
  } catch {
    return unknown("STATUS_STATE_WRITE_FAILED", "狀態無法寫入");
  }
  if (!a.ok) return unknown(a.reasonCode, a.message);
  if (isCredentialRevoked(view, a.state) || isCredentialRevoked(view, list)) {
    return { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: `憑證已被發證者撤銷（清單 sequence ${a.state.sequence}）`, listSequence: a.state.sequence };
  }
  const warn = statusListExpiryWarning(list.validUntil, nowMs);
  return {
    ok: true,
    status: "active",
    reasonCode: "STATUS_ACTIVE",
    message: `狀態清單 sequence ${a.state.sequence}：未撤銷`,
    listSequence: a.state.sequence,
    ...(warn ? { warnings: [warn] } : {}),
  };
}

// ── 鏈上交易資料（只產生，不送）────────────────────────────────────────────────

export function buildSubmitTx(registry: string, vc: Extract<InvestorVcVerifyResult, { valid: true }>) {
  return {
    to: ethers.getAddress(registry),
    data: registryInterface.encodeFunctionData("submitAttestation", [toContractAttestation(vc.value), vc.signature]),
  };
}

export function buildRevokeTx(registry: string, credentialHash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(credentialHash)) throw new Error("credentialHash 必須是 bytes32");
  return {
    to: ethers.getAddress(registry),
    data: registryInterface.encodeFunctionData("revoke", [credentialHash]),
  };
}

/** 解出 VCKycRegistry／PerpetualExchange 的自訂錯誤名稱（給人看的 revert 原因）。 */
export function decodeRevert(data: string | undefined | null): string | null {
  if (!data || data === "0x") return null;
  try {
    const e = registryInterface.parseError(data);
    if (e) return `${e.name}(${e.args.map((x) => String(x)).join(", ")})`;
  } catch {
    /* fallthrough */
  }
  try {
    const ex = new ethers.Interface(["error NotKycVerified(address user)"]);
    const e = ex.parseError(data);
    if (e) return `${e.name}(${e.args.map((x) => String(x)).join(", ")})`;
  } catch {
    /* fallthrough */
  }
  return data.slice(0, 10);
}

