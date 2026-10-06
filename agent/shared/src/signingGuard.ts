// 簽章守門（signing guard）—— **白名單**：agent 金鑰只能簽列出來的東西，其餘一律拒絕。
//
// 為什麼從 denylist 改成白名單（複審 High）：denylist 兩度被繞過——先是 MaxUint-1，
// 再是 typed data 夾帶 `allowed:false` 讓 EIP-2612 Permit 走進 DAI 分支被放行（ethers
// 簽出來的仍是無上限 permit）。「列舉危險的東西」永遠列不完；agent 金鑰實際需要簽的
// 東西只有三種，直接只放行這三種。
//
// 白名單（盤點過所有使用 agent 金鑰的簽章點）：
//   (a) 交易：`to` 必須是設定中的 session manager（SESSION_MANAGER_ADDRESS），selector
//       只能是 `openPositionForSession`（write.ts 開倉）或 `closePositionForSession`
//       （write.ts 平倉），calldata 必須能完整解碼；`value` ≤ 上限
//       （SIGNING_GUARD_MAX_TX_VALUE_WEI，預設 0.001 ETH；開倉只附 executionFee，
//       目前 0.0001 ETH；平倉不附 ETH）。type-4、authorizationList、合約建立一律拒絕。
//   (b) EIP-712：只允許 x402 exact 的 USDC `TransferWithAuthorization`（EIP-3009）。
//       以 `types`／`primaryType` 判斷型別（**不看 message 欄位**），型別欄位必須與
//       EIP-3009 規格逐欄相同、message 的鍵必須恰好等於型別欄位；domain 的 name /
//       version / chainId / verifyingContract 必須等於官方 USDC；`from` 必須是 agent
//       自己；`value` ≤ X402_MAX_PAYMENT_USDC（resolveX402MaxValue）；`to` 在 payTo allowlist
//       （X402_PAYTO_ALLOWLIST → PAY_TO → 第一次付款 TOFU 釘選）；validAfter ≤ now <
//       validBefore ≤ now+300（env X402_MAX_VALIDITY_SEC 可放寬，最多 3600）；
//       本 process 累計簽出 ≤ X402_MAX_TOTAL_SPEND_USDC（檢查與預留在同一個同步區段，並行安全）；
//       types.EIP712Domain 若存在須為標準四欄，domain.chainId 只收 number/bigint。
//       交易另要求 chainId = AGENT_CHAIN_ID（EIP-155），calldata 重新編碼須逐字相同。
//       持有證明挑戰的時間戳須在 ±60 秒內。
//       呼叫點：x402-fetch（examples/x402-*、buy-signal、demo-agent、x402_agent.ts）。
//       x402 v2（@x402/evm 2.28 的 exact client，docs/ADR-010）：預設仍是同一份 EIP-3009 typed data
//       （domain 取自付款要求的 asset／extra.name／extra.version，chainId 取自 CAIP-2），差別只有
//       validAfter 是 0（v1 是 now-600）—— 上面每一項檢查原樣適用，不需要為 v2 放寬任何東西。
//       v2 新增的其他簽章路徑**一律拒絕**（它們都不是 TransferWithAuthorization）：
//         - Permit2（extra.assetTransferMethod = "permit2" → PermitWitnessTransferFrom）
//         - upto scheme（Permit2 專用）、batch-settlement、auth-capture
//         - EIP-2612 gas sponsoring 擴充（簽 Permit）、ERC-20 approval sponsoring 擴充（簽 approve 交易）
//       伺服器（或惡意的 402）宣告這些方式時，agent 金鑰不會簽，付款失敗、沒有任何授權流出。
//   (c) EIP-191 personal message：只允許 ERC-8126 proof-of-possession 挑戰字串
//       `pepelab-wv:<agent 地址>:<毫秒時間戳>`（verification.ts checkWV；write.ts 風險閘與
//       MCP get_agent_verification 會帶 agent 金鑰呼叫）。personal_sign 有
//       "\x19Ethereum Signed Message" 前綴，不可能被當成交易、permit 或 7702 authorization，
//       且挑戰字串格式固定、不含任何授權語意。
//   (d) EIP-712：x402 KYA 的 `AgentX402Presentation`（docs/SSI_AGENT_DELEGATION.md）——代理人出示
//       v3 委託憑證時，對「這一個付費請求」簽的持有證明。型別必須與
//       frontend/src/contracts/agentDelegation.ts 的 PRESENTATION_TYPES 逐欄相同、message 鍵恰好相同；
//       domain 只能是 {name:'PepeLabAgentPresentation', version:'1', chainId}（chainId ∈ 接受的鏈，
//       無 verifyingContract／salt）；holder 與 payer 都必須是 agent 自己；created 在 ±60 秒內。
//       它不帶任何金額或授權語意（金額在同一請求的 EIP-3009 授權裡，仍受 (b) 全部限制），
//       所以不佔 x402 累計額度。
// 其餘全部拒絕：approve / increaseAllowance / permit / Permit2 / 任意合約呼叫 / 其他
// typed data / 其他訊息 / 7702 authorization / 裸 hash 簽章。
//
// 誠實邊界：拿得到私鑰原文的程式碼永遠可以繞過任何 JS 包裝（例如直接用 signingKey.sign）。
// 這一關防的是「agent 被 prompt injection / 惡意 402 回應 / 惡意工具參數誘導」去簽
// 危險內容，不是防一個已經被攻陷的 process。
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
import { OFFICIAL_BASE_SEPOLIA_USDC } from "./env.ts";
import { resolveX402MaxValue, resolveX402TotalSpendCap } from "./x402Client.ts";
// 直接讀純資料的 schema 模組（不經 delegation.ts）：delegation → identity → provider → signingGuard 會成環。
import { AUTH_VC_CHAIN_ID, PRESENTATION_TYPES } from "../../../frontend/src/contracts/agentAuth";

/** 拒絕原因代碼（穩定字串，寫進稽核與錯誤）。 */
export type SigningGuardReason =
  | "TX_NOT_ALLOWLISTED"
  | "TX_CHAIN_ID_INVALID"
  | "PAYTO_NOT_ALLOWLISTED"
  | "PAYMENT_WINDOW_INVALID"
  | "SPEND_CAP_EXCEEDED"
  | "EIP7702_TX_FORBIDDEN"
  | "EIP7702_AUTHORIZATION_FORBIDDEN"
  | "RAW_HASH_SIGN_FORBIDDEN"
  | "TX_VALUE_TOO_HIGH"
  | "TYPED_DATA_NOT_ALLOWLISTED"
  | "PAYMENT_TOO_HIGH"
  | "MESSAGE_NOT_ALLOWLISTED"
  | "GUARD_CONFIG_INVALID";

export class SigningGuardError extends Error {
  constructor(
    public readonly reasonCode: SigningGuardReason,
    detail: string,
  ) {
    super(`[signing-guard] ${reasonCode}: ${detail}`);
    this.name = "SigningGuardError";
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

// ── 設定 ─────────────────────────────────────────────────────────────────────
/** 官方 USDC 的 EIP-712 domain（x402 exact 使用）。依鏈別固定，不接受外部覆寫。 */
export const OFFICIAL_USDC_DOMAINS: Record<number, { name: string; version: string; verifyingContract: string }> = {
  84532: { name: "USDC", version: "2", verifyingContract: OFFICIAL_BASE_SEPOLIA_USDC },
};

export const DEFAULT_MAX_TX_VALUE_WEI = 10n ** 15n; // 0.001 ETH

/** session manager 的允許 selector（逐一列出，其餘拒絕）。 */
const SESSION_MANAGER_IFACE = new ethers.Interface([
  "function openPositionForSession(uint256 sessionId, bytes32 asset, bool isLong, uint256 margin, uint256 leverage, address copiedFrom) payable returns (uint256)",
  "function closePositionForSession(uint256 sessionId, uint256 positionId)",
]);
export const ALLOWED_TX_SELECTORS: Record<string, string> = {
  [SESSION_MANAGER_IFACE.getFunction("openPositionForSession")!.selector]: "openPositionForSession",
  [SESSION_MANAGER_IFACE.getFunction("closePositionForSession")!.selector]: "closePositionForSession",
};

/** EIP-3009 TransferWithAuthorization 的型別（逐欄比對）。 */
export const TRANSFER_WITH_AUTHORIZATION_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

export const WV_CHALLENGE_RE = /^pepelab-wv:(0x[0-9a-fA-F]{40}):(\d{10,16})$/;
/** 持有證明挑戰的時間戳（毫秒）與現在的最大差距。 */
export const WV_MAX_SKEW_MS = 60_000;

/** EIP-712 標準 domain 四欄（USDC 的 domain 就是這四欄）。 */
export const EIP712_DOMAIN_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

function sessionManager(env: NodeJS.ProcessEnv): string {
  const a = env.SESSION_MANAGER_ADDRESS?.trim();
  if (!a || !ethers.isAddress(a) || a.toLowerCase() === ZERO) {
    throw new SigningGuardError("GUARD_CONFIG_INVALID", "未設定有效 SESSION_MANAGER_ADDRESS，無法判斷交易白名單（fail-closed）");
  }
  return ethers.getAddress(a);
}

function maxTxValue(env: NodeJS.ProcessEnv): bigint {
  const raw = env.SIGNING_GUARD_MAX_TX_VALUE_WEI?.trim();
  if (!raw) return DEFAULT_MAX_TX_VALUE_WEI;
  if (!/^\d+$/.test(raw)) {
    throw new SigningGuardError("GUARD_CONFIG_INVALID", "SIGNING_GUARD_MAX_TX_VALUE_WEI 必須是非負整數（fail-closed）");
  }
  return BigInt(raw);
}

function big(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  } catch {
    /* fallthrough */
  }
  return null;
}

// ── (a) 交易 ─────────────────────────────────────────────────────────────────
/** 交易型別是不是 EIP-7702（ethers 用數字 4，viem 用字串 'eip7702'）。 */
function is7702(tx: { type?: unknown; authorizationList?: unknown }): boolean {
  const t = tx.type;
  if (t === 4 || t === 4n || t === "0x4" || t === "0x04" || t === "eip7702") return true;
  const list = tx.authorizationList as unknown[] | null | undefined;
  return Array.isArray(list) && list.length > 0;
}

export function assertAllowedTransaction(
  tx: { to?: unknown; data?: unknown; value?: unknown; type?: unknown; authorizationList?: unknown; chainId?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (is7702(tx)) {
    throw new SigningGuardError("EIP7702_TX_FORBIDDEN", "agent 金鑰不得簽 EIP-7702（type-4 / authorizationList）交易");
  }
  // chainId 必須帶、且等於 agent 的鏈：沒有 chainId 的簽章沒有 EIP-155 重放保護，可以被拿到別條鏈上重播。
  const cid = typeof tx.chainId === "bigint" || typeof tx.chainId === "number" ? big(tx.chainId) : null;
  if (cid === null || cid !== BigInt(AGENT_CHAIN_ID)) {
    throw new SigningGuardError("TX_CHAIN_ID_INVALID", `交易 chainId ${String(tx.chainId ?? "(缺)")} 必須等於 ${AGENT_CHAIN_ID}`);
  }
  const mgr = sessionManager(env);
  const to = typeof tx.to === "string" ? tx.to : (tx.to as { address?: string } | null)?.address;
  if (!to || !ethers.isAddress(to) || ethers.getAddress(to) !== mgr) {
    throw new SigningGuardError("TX_NOT_ALLOWLISTED", `交易對象 ${String(to ?? "(合約建立)")} 不是 session manager ${mgr}`);
  }
  const data = typeof tx.data === "string" ? tx.data : "";
  const sel = data.slice(0, 10).toLowerCase();
  const fnName = ALLOWED_TX_SELECTORS[sel];
  if (!fnName) throw new SigningGuardError("TX_NOT_ALLOWLISTED", `selector ${sel || "(空)"} 不在允許清單`);
  // 解碼後重新編碼，必須與原 data 逐字相同：尾端夾帶任何 bytes、非標準編碼都拒絕。
  let canonical: string;
  try {
    canonical = SESSION_MANAGER_IFACE.encodeFunctionData(fnName, SESSION_MANAGER_IFACE.decodeFunctionData(fnName, data));
  } catch {
    throw new SigningGuardError("TX_NOT_ALLOWLISTED", `${fnName} calldata 無法完整解碼（fail-closed）`);
  }
  if (canonical.toLowerCase() !== data.toLowerCase()) {
    throw new SigningGuardError("TX_NOT_ALLOWLISTED", `${fnName} calldata 不是標準編碼（尾端夾帶資料或格式異常）`);
  }
  const value = tx.value === undefined || tx.value === null ? 0n : big(tx.value);
  const cap = maxTxValue(env);
  if (value === null || value > cap) {
    throw new SigningGuardError("TX_VALUE_TOO_HIGH", `value ${String(tx.value)} 超過上限 ${cap} wei`);
  }
  if (fnName === "closePositionForSession" && value !== 0n) {
    throw new SigningGuardError("TX_VALUE_TOO_HIGH", "closePositionForSession 不應附帶 ETH");
  }
}

// ── (b) EIP-712 ──────────────────────────────────────────────────────────────
/**
 * 只允許 USDC TransferWithAuthorization。判斷依據是 **types / primaryType**：
 *   - types（去掉 EIP712Domain）必須恰好只有 TransferWithAuthorization 一個型別，且欄位
 *     與 EIP-3009 逐欄相同；primaryType（若有給）必須是它。
 *   - message 的鍵必須恰好等於型別欄位（多一個、少一個都拒絕）。
 *   - domain 必須等於官方 USDC；from 必須是簽章者；value ≤ X402_MAX_PAYMENT_USDC。
 */
export function assertAllowedTypedData(
  domain: { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown; salt?: unknown },
  types: Record<string, unknown>,
  message: Record<string, unknown>,
  signer: string,
  primaryType?: string,
): void {
  const T = "TYPED_DATA_NOT_ALLOWLISTED" as const;
  // types 若帶 EIP712Domain，必須逐欄等於標準四欄（名稱與型別都一致）。
  if ("EIP712Domain" in (types ?? {})) {
    const d = types.EIP712Domain as Array<{ name: string; type: string }>;
    const ok =
      Array.isArray(d) &&
      d.length === EIP712_DOMAIN_FIELDS.length &&
      d.every((f, i) => f?.name === EIP712_DOMAIN_FIELDS[i].name && f?.type === EIP712_DOMAIN_FIELDS[i].type);
    if (!ok) throw new SigningGuardError(T, "types.EIP712Domain 不是標準四欄（name, version, chainId, verifyingContract）");
  }
  const names = Object.keys(types ?? {}).filter((n) => n !== "EIP712Domain");
  if (names.length !== 1 || names[0] !== "TransferWithAuthorization") {
    throw new SigningGuardError(T, `typed data 型別 [${names.join(", ")}] 不在允許清單（只允許 TransferWithAuthorization）`);
  }
  if (primaryType !== undefined && primaryType !== "TransferWithAuthorization") {
    throw new SigningGuardError(T, `primaryType ${primaryType} 不在允許清單`);
  }
  const fields = types.TransferWithAuthorization as Array<{ name: string; type: string }>;
  const same =
    Array.isArray(fields) &&
    fields.length === TRANSFER_WITH_AUTHORIZATION_FIELDS.length &&
    fields.every((f, i) => f?.name === TRANSFER_WITH_AUTHORIZATION_FIELDS[i].name && f?.type === TRANSFER_WITH_AUTHORIZATION_FIELDS[i].type);
  if (!same) throw new SigningGuardError(T, "TransferWithAuthorization 的欄位與 EIP-3009 不符");

  const keys = Object.keys(message ?? {}).sort();
  const expected = TRANSFER_WITH_AUTHORIZATION_FIELDS.map((f) => f.name).sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new SigningGuardError(T, `message 欄位 [${keys.join(", ")}] 與型別不一致`);
  }

  const usdc = OFFICIAL_USDC_DOMAINS[AGENT_CHAIN_ID];
  if (!usdc) throw new SigningGuardError(T, `chain ${AGENT_CHAIN_ID} 沒有設定官方 USDC domain`);
  const vc = typeof domain?.verifyingContract === "string" ? domain.verifyingContract : "";
  // domain.chainId 只接受 number / bigint（字串可被構造成不同的編碼，不收）。
  const chainIdOk =
    (typeof domain?.chainId === "number" || typeof domain?.chainId === "bigint") &&
    big(domain.chainId) === BigInt(AGENT_CHAIN_ID);
  const domainOk =
    domain?.name === usdc.name &&
    domain?.version === usdc.version &&
    chainIdOk &&
    ethers.isAddress(vc) &&
    ethers.getAddress(vc) === ethers.getAddress(usdc.verifyingContract) &&
    domain?.salt === undefined;
  if (!domainOk) {
    throw new SigningGuardError(T, "domain 不是官方 USDC（name / version / chainId / verifyingContract 不符）");
  }
  const from = typeof message.from === "string" ? message.from : "";
  if (!ethers.isAddress(from) || ethers.getAddress(from) !== ethers.getAddress(signer)) {
    throw new SigningGuardError(T, "TransferWithAuthorization.from 不是 agent 自己");
  }
  const value = big(message.value);
  const cap = resolveX402MaxValue();
  if (value === null || value > cap) {
    throw new SigningGuardError("PAYMENT_TOO_HIGH", `付款金額 ${String(message.value)} 超過單筆上限 ${cap}（X402_MAX_PAYMENT_USDC）`);
  }

  // 收款地址：必須在 allowlist（見 x402PayToAllowlist 的來源順序）。
  const to = typeof message.to === "string" && ethers.isAddress(message.to) ? ethers.getAddress(message.to) : null;
  if (!to) throw new SigningGuardError("PAYTO_NOT_ALLOWLISTED", "TransferWithAuthorization.to 不是合法地址");
  const allow = x402PayToAllowlist();
  if (allow && !allow.includes(to)) {
    throw new SigningGuardError("PAYTO_NOT_ALLOWLISTED", `收款地址 ${to} 不在 x402 payTo allowlist`);
  }

  // 有效期：validAfter ≤ now、validBefore ≤ now + 上限（預設 300 秒；簽出去的授權不能長期有效）。
  const maxValidity = resolveX402MaxValiditySec();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const after = big(message.validAfter);
  const before = big(message.validBefore);
  if (after === null || before === null || after > nowSec || before > nowSec + maxValidity || before <= nowSec) {
    throw new SigningGuardError(
      "PAYMENT_WINDOW_INVALID",
      `授權有效期不合規（validAfter=${String(message.validAfter)}、validBefore=${String(message.validBefore)}；須 validAfter ≤ now、now < validBefore ≤ now+${maxValidity}，上限見 X402_MAX_VALIDITY_SEC）`,
    );
  }

  // 累計花費上限（所有 x402 付款流程共用：守門是它們唯一的共同咽喉點）。
  // signedTotal 包含「進行中」的預留（見 reserveX402），所以並行簽署看得到彼此。
  const total = resolveX402TotalSpendCap();
  if (x402Ledger.signedTotal + value > total) {
    throw new SigningGuardError(
      "SPEND_CAP_EXCEEDED",
      `本 process 已簽出／簽署中 ${x402Ledger.signedTotal}，加上本筆 ${value} 超過累計上限 ${total}（X402_MAX_TOTAL_SPEND_USDC）`,
    );
  }
}

// ── x402 共用狀態：payTo 與累計花費 ─────────────────────────────────────────
/** 授權有效期的**硬上限**（秒）：X402_MAX_VALIDITY_SEC 環境變數最多只能放寬到這裡。 */
export const X402_MAX_VALIDITY_SEC = 3600n;
/**
 * 授權有效期的預設上限（秒）。x402 client 以 validBefore = now + maxTimeoutSeconds 簽署，
 * 我們自己的 signal-api 宣告 60 秒（x402-hono 未設定時的預設是 300），300 秒涵蓋兩者。
 * v2 的 client（@x402/evm）算法相同，伺服器未設定時的預設同樣是 300。
 */
export const X402_DEFAULT_MAX_VALIDITY_SEC = 300n;

/** 有效期上限：env `X402_MAX_VALIDITY_SEC`（1–3600 的整數秒），預設 300。格式錯誤 fail-closed。 */
export function resolveX402MaxValiditySec(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.X402_MAX_VALIDITY_SEC?.trim();
  if (!raw) return X402_DEFAULT_MAX_VALIDITY_SEC;
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n || BigInt(raw) > X402_MAX_VALIDITY_SEC) {
    throw new SigningGuardError(
      "GUARD_CONFIG_INVALID",
      `X402_MAX_VALIDITY_SEC 必須是 1–${X402_MAX_VALIDITY_SEC} 的整數秒（收到 ${raw}，fail-closed）`,
    );
  }
  return BigInt(raw);
}

/**
 * 本 process 的 x402 帳本。
 *   signedTotal          —— 已簽出 + **簽署中（已預留）** 的授權總額（atomic）。以「簽出」計、不等結算，
 *                           寧可高估；這個數字是拿來擋上限的。
 *   activeAuthorizations —— 已簽出 + 簽署中的授權筆數（決定 TOFU 釘選能不能撤銷）。
 *   pinnedPayTo          —— TOFU 釘選的收款地址；pinOwner 為「釘它、且還沒簽完」的那筆預留。
 * 所有走 GuardedWallet / guardViemAccount 的 x402 流程共用。
 * 誠實邊界：以 process 為範圍，重啟歸零；長期上限請配合外部監控。
 */
const x402Ledger = {
  signedTotal: 0n,
  activeAuthorizations: 0,
  pinnedPayTo: null as string | null,
  pinOwner: null as symbol | null,
};

/** 已簽出 + 簽署中的 x402 授權總額（atomic）。 */
export function x402SignedTotal(): bigint {
  return x402Ledger.signedTotal;
}

/** 測試用：清掉累計與 TOFU 釘選。 */
export function resetX402GuardStateForTesting(): void {
  x402Ledger.signedTotal = 0n;
  x402Ledger.activeAuthorizations = 0;
  x402Ledger.pinnedPayTo = null;
  x402Ledger.pinOwner = null;
}

export interface X402Reservation {
  /** 簽章成功：預留轉為已簽出（不可再撤銷）。 */
  commit(): void;
  /** 簽章失敗：退回預留；若本筆是 TOFU 釘選者且沒有其他授權，撤銷釘選。 */
  rollback(): void;
}

/**
 * 檢查 + 預留，**在同一個同步區段完成**（中間沒有 await）。
 *
 * 以前是「assertAllowedTypedData 檢查 → await 簽章 → recordX402Signed 記帳」，檢查與記帳之間隔著
 * await，並行的 N 筆會在彼此記帳前全部通過累計上限；TOFU 也要等簽完才釘選，並行兩筆不同收款人
 * 都會被放行（審查 PR #201 附帶回報，shared-race PoC 重現）。現在通過檢查的當下就記入
 * signedTotal 與 TOFU 釘選，下一筆（不論是否並行）的檢查一定看得到。
 */
export function reserveX402(
  domain: Parameters<typeof assertAllowedTypedData>[0],
  types: Record<string, unknown>,
  message: Record<string, unknown>,
  signer: string,
  primaryType?: string,
): X402Reservation {
  assertAllowedTypedData(domain, types, message, signer, primaryType);
  // ↓ 從這裡到 return 都是同步程式碼：與上面的檢查構成一個不可分割的區段。
  const value = big(message.value) ?? 0n;
  const token = Symbol("x402-reservation");
  x402Ledger.signedTotal += value;
  x402Ledger.activeAuthorizations += 1;
  const tofu = !envPayToAllowlistRaw() && !x402Ledger.pinnedPayTo && typeof message.to === "string";
  if (tofu) {
    x402Ledger.pinnedPayTo = ethers.getAddress(message.to as string);
    x402Ledger.pinOwner = token;
  }
  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      if (x402Ledger.pinOwner === token) x402Ledger.pinOwner = null; // 釘選自此永久（本 process）
    },
    rollback() {
      if (settled) return;
      settled = true;
      x402Ledger.signedTotal -= value;
      x402Ledger.activeAuthorizations -= 1;
      // activeAuthorizations 計的是「已簽出＋簽署中」（commit 不遞減）。歸零代表沒有任何
      // 授權付給過釘選的地址，撤銷釘選一定安全——不論是哪一筆釘的。只看「本筆是否為
      // 釘選者」會漏掉：釘選者先失敗（還有另一筆在簽）、後來那筆也失敗 → 釘選殘留，
      // 惡意 402 的收款地址配上兩次暫時性簽章失敗就能把合法收款人鎖到重啟（#204 審查 M1）。
      if (x402Ledger.pinOwner === token) x402Ledger.pinOwner = null;
      if (x402Ledger.activeAuthorizations === 0) {
        x402Ledger.pinnedPayTo = null;
        x402Ledger.pinOwner = null;
      }
    },
  };
}

/** 包住一次簽章：先預留，簽章成功 commit、失敗 rollback。 */
async function withX402Reservation<T>(r: X402Reservation, sign: () => Promise<T>): Promise<T> {
  let sig: T;
  try {
    sig = await sign();
  } catch (err) {
    r.rollback();
    throw err;
  }
  r.commit();
  return sig;
}

function envPayToAllowlistRaw(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.X402_PAYTO_ALLOWLIST?.trim() || env.PAY_TO?.trim() || undefined;
}

/**
 * payTo allowlist 的來源（依序）：
 *   1. `X402_PAYTO_ALLOWLIST`（逗號分隔地址）——正式環境請設定。
 *   2. `PAY_TO`——與 signal-api 收款地址同一個設定（同一份 agent/.env）。
 *   3. 都沒有：**第一次付款的收款地址為準**（trust-on-first-use）。本 process 第一筆 x402 付款
 *      簽出後釘住它的 `to`，之後任何不同的收款地址一律拒絕；重啟後重新釘選。啟動時會在
 *      stderr 警告一次。回傳 null＝尚未釘選（第一筆放行）。
 */
export function x402PayToAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = envPayToAllowlistRaw(env);
  if (raw) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((a) => !ethers.isAddress(a));
    if (bad.length || !list.length) {
      throw new SigningGuardError("GUARD_CONFIG_INVALID", `X402_PAYTO_ALLOWLIST / PAY_TO 含非法地址（fail-closed）`);
    }
    return list.map((a) => ethers.getAddress(a));
  }
  if (x402Ledger.pinnedPayTo) return [x402Ledger.pinnedPayTo];
  if (!warnedTofu) {
    warnedTofu = true;
    console.warn("[signing-guard] ⚠ 未設定 X402_PAYTO_ALLOWLIST / PAY_TO：以第一次 x402 付款的收款地址為準（TOFU），之後只允許該地址。");
  }
  return null;
}
let warnedTofu = false;


// ── (d) x402 KYA presentation ────────────────────────────────────────────────
const PRESENTATION_PRIMARY = "AgentX402Presentation";
const PRESENTATION_DOMAIN_FIELDS = ["name", "version", "chainId"];

/** types 是否宣告為 KYA presentation（只看型別名稱；細節由 assertAllowedPresentation 檢查）。 */
export function isPresentationTypedData(types: Record<string, unknown>): boolean {
  return Object.keys(types ?? {}).some((n) => n === PRESENTATION_PRIMARY);
}

function presentationChainIds(env: NodeJS.ProcessEnv = process.env): bigint[] {
  const raw = env.DELEGATION_VC_CHAIN_IDS?.trim();
  const ids = raw
    ? raw.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map((s) => BigInt(s))
    : [];
  return ids.length ? ids : [BigInt(AGENT_CHAIN_ID), BigInt(AUTH_VC_CHAIN_ID)];
}

/**
 * (d) 白名單：KYA presentation。逐欄比對型別、message 鍵、domain；holder／payer 必須是簽章者；
 * created 在 ±WV_MAX_SKEW_MS 內。違反任何一項丟 TYPED_DATA_NOT_ALLOWLISTED。
 */
export function assertAllowedPresentation(
  domain: { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown; salt?: unknown },
  types: Record<string, unknown>,
  message: Record<string, unknown>,
  signer: string,
  primaryType?: string,
): void {
  const T = "TYPED_DATA_NOT_ALLOWLISTED" as const;
  if ("EIP712Domain" in (types ?? {})) {
    const d = types.EIP712Domain as Array<{ name: string }>;
    const ok = Array.isArray(d) && d.length === PRESENTATION_DOMAIN_FIELDS.length && d.every((f, i) => f?.name === PRESENTATION_DOMAIN_FIELDS[i]);
    if (!ok) throw new SigningGuardError(T, "presentation 的 types.EIP712Domain 只能是 name, version, chainId");
  }
  const names = Object.keys(types ?? {}).filter((n) => n !== "EIP712Domain");
  if (names.length !== 1 || names[0] !== PRESENTATION_PRIMARY) {
    throw new SigningGuardError(T, `typed data 型別 [${names.join(", ")}] 不在允許清單`);
  }
  if (primaryType !== undefined && primaryType !== PRESENTATION_PRIMARY) {
    throw new SigningGuardError(T, `primaryType ${primaryType} 不在允許清單`);
  }
  const want = PRESENTATION_TYPES[PRESENTATION_PRIMARY]!;
  const fields = types[PRESENTATION_PRIMARY] as Array<{ name: string; type: string }>;
  if (!Array.isArray(fields) || fields.length !== want.length || fields.some((f, i) => f?.name !== want[i]!.name || f?.type !== want[i]!.type)) {
    throw new SigningGuardError(T, "AgentX402Presentation 的欄位與 schema 不符");
  }
  const keys = Object.keys(message ?? {}).sort();
  const expected = want.map((f) => f.name).sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new SigningGuardError(T, `presentation message 欄位 [${keys.join(", ")}] 與型別不一致`);
  }
  const chainOk =
    (typeof domain?.chainId === "number" || typeof domain?.chainId === "bigint") &&
    presentationChainIds().includes(BigInt(domain.chainId as number | bigint));
  if (
    domain?.name !== "PepeLabAgentPresentation" ||
    domain?.version !== "1" ||
    !chainOk ||
    domain?.verifyingContract !== undefined ||
    domain?.salt !== undefined
  ) {
    throw new SigningGuardError(T, "presentation 的 domain 不符（name／version／chainId，且不得帶 verifyingContract／salt）");
  }
  const me = ethers.getAddress(signer);
  for (const k of ["holder", "payer"] as const) {
    const v = typeof message[k] === "string" ? (message[k] as string) : "";
    if (!ethers.isAddress(v) || ethers.getAddress(v) !== me) {
      throw new SigningGuardError(T, `presentation.${k} 不是 agent 自己`);
    }
  }
  const created = big(message.created);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const skew = BigInt(WV_MAX_SKEW_MS / 1000);
  if (created === null || created > nowSec + skew || created < nowSec - skew) {
    throw new SigningGuardError(T, `presentation.created 不在現在 ±${skew} 秒內`);
  }
}

// ── (c) personal message ─────────────────────────────────────────────────────
export function assertAllowedMessage(message: unknown, signer: string): void {
  const text =
    typeof message === "string"
      ? message
      : message instanceof Uint8Array
        ? (() => {
            try {
              return ethers.toUtf8String(message);
            } catch {
              return "";
            }
          })()
        : "";
  const m = WV_CHALLENGE_RE.exec(text);
  if (!m || ethers.getAddress(m[1]) !== ethers.getAddress(signer)) {
    throw new SigningGuardError("MESSAGE_NOT_ALLOWLISTED", "只允許簽 ERC-8126 proof-of-possession 挑戰字串（pepelab-wv:<自己的地址>:<時間戳>）");
  }
  // 時間戳（毫秒）必須在現在 ±60 秒內：擋預先簽好、事後重放的持有證明。
  if (Math.abs(Number(m[2]) - Date.now()) > WV_MAX_SKEW_MS) {
    throw new SigningGuardError("MESSAGE_NOT_ALLOWLISTED", `持有證明挑戰的時間戳與現在相差超過 ${WV_MAX_SKEW_MS / 1000} 秒`);
  }
}

// ── ethers：GuardedWallet ────────────────────────────────────────────────────
/**
 * `ethers.Wallet` 的子類：所有會產生簽章的公開方法都先過白名單。
 * `sendTransaction` 在 AbstractSigner 裡是 populate → `this.signTransaction` → broadcast，
 * 因此覆寫 signTransaction 就同時涵蓋 sendTransaction 與所有 `contract.fn()` 寫呼叫。
 */
export class GuardedWallet extends ethers.Wallet {
  override async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    assertAllowedTransaction(tx as any);
    return super.signTransaction(tx);
  }

  override async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>,
  ): Promise<string> {
    if (isPresentationTypedData(types)) {
      assertAllowedPresentation(domain as any, types, value, this.address);
      return super.signTypedData(domain, types, value);
    }
    const r = reserveX402(domain as any, types, value, this.address);
    return withX402Reservation(r, () => super.signTypedData(domain, types, value));
  }

  override async signMessage(message: string | Uint8Array): Promise<string> {
    assertAllowedMessage(message, this.address);
    return super.signMessage(message);
  }

  override signMessageSync(message: string | Uint8Array): string {
    assertAllowedMessage(message, this.address);
    return super.signMessageSync(message);
  }

  override async authorize(_auth: ethers.AuthorizationRequest): Promise<ethers.Authorization> {
    throw new SigningGuardError("EIP7702_AUTHORIZATION_FORBIDDEN", "agent 金鑰不得簽 EIP-7702 authorization");
  }

  override authorizeSync(_auth: ethers.AuthorizationRequest): ethers.Authorization {
    throw new SigningGuardError("EIP7702_AUTHORIZATION_FORBIDDEN", "agent 金鑰不得簽 EIP-7702 authorization");
  }

  override connect(provider: ethers.Provider | null): GuardedWallet {
    return new GuardedWallet(this.signingKey, provider);
  }
}

// ── viem：guardViemAccount ──────────────────────────────────────────────────
/**
 * 包一個 viem LocalAccount（`privateKeyToAccount(pk)` 的回傳值），規則與 GuardedWallet 相同：
 *   - signTransaction / signTypedData / signMessage：先過白名單
 *   - signAuthorization（7702）與 sign（裸 hash）：一律丟錯
 * 不 import viem（shared 不依賴它），以結構型別處理，回傳型別與輸入相同。
 */
export function guardViemAccount<A extends { type: string; address: string }>(account: A): A {
  const acc = account as any;
  const wrapped: any = { ...acc };
  if (typeof acc.signTransaction === "function") {
    wrapped.signTransaction = async (tx: any, opts?: any) => {
      assertAllowedTransaction(tx ?? {});
      return acc.signTransaction(tx, opts);
    };
  }
  if (typeof acc.signTypedData === "function") {
    wrapped.signTypedData = async (td: any) => {
      if (isPresentationTypedData(td?.types ?? {})) {
        assertAllowedPresentation(td?.domain ?? {}, td?.types ?? {}, td?.message ?? {}, acc.address, td?.primaryType);
        return acc.signTypedData(td);
      }
      const r = reserveX402(td?.domain ?? {}, td?.types ?? {}, td?.message ?? {}, acc.address, td?.primaryType);
      return withX402Reservation(r, () => acc.signTypedData(td));
    };
  }
  if (typeof acc.signMessage === "function") {
    wrapped.signMessage = async (p: any) => {
      const m = p?.message;
      assertAllowedMessage(typeof m === "string" ? m : m?.raw instanceof Uint8Array ? m.raw : "", acc.address);
      return acc.signMessage(p);
    };
  }
  if ("signAuthorization" in acc) {
    wrapped.signAuthorization = async () => {
      throw new SigningGuardError("EIP7702_AUTHORIZATION_FORBIDDEN", "agent 金鑰不得簽 EIP-7702 authorization");
    };
  }
  if ("sign" in acc) {
    wrapped.sign = async () => {
      throw new SigningGuardError(
        "RAW_HASH_SIGN_FORBIDDEN",
        "agent 金鑰不得簽裸 hash（可被用來簽 7702 authorization 或任意訊息摘要）",
      );
    };
  }
  return wrapped as A;
}
