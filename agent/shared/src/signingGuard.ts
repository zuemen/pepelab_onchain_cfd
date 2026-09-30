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
//       自己；`value` ≤ X402_MAX_PAYMENT_USDC（resolveX402MaxValue）。
//       呼叫點：x402-fetch（examples/x402-*、buy-signal、demo-agent、x402_agent.ts）。
//   (c) EIP-191 personal message：只允許 ERC-8126 proof-of-possession 挑戰字串
//       `pepelab-wv:<agent 地址>:<毫秒時間戳>`（verification.ts checkWV；write.ts 風險閘與
//       MCP get_agent_verification 會帶 agent 金鑰呼叫）。personal_sign 有
//       "\x19Ethereum Signed Message" 前綴，不可能被當成交易、permit 或 7702 authorization，
//       且挑戰字串格式固定、不含任何授權語意。
// 其餘全部拒絕：approve / increaseAllowance / permit / Permit2 / 任意合約呼叫 / 其他
// typed data / 其他訊息 / 7702 authorization / 裸 hash 簽章。
//
// 誠實邊界：拿得到私鑰原文的程式碼永遠可以繞過任何 JS 包裝（例如直接用 signingKey.sign）。
// 這一關防的是「agent 被 prompt injection / 惡意 402 回應 / 惡意工具參數誘導」去簽
// 危險內容，不是防一個已經被攻陷的 process。
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
import { OFFICIAL_BASE_SEPOLIA_USDC } from "./env.ts";
import { resolveX402MaxValue } from "./x402Client.ts";

/** 拒絕原因代碼（穩定字串，寫進稽核與錯誤）。 */
export type SigningGuardReason =
  | "TX_NOT_ALLOWLISTED"
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
  tx: { to?: unknown; data?: unknown; value?: unknown; type?: unknown; authorizationList?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (is7702(tx)) {
    throw new SigningGuardError("EIP7702_TX_FORBIDDEN", "agent 金鑰不得簽 EIP-7702（type-4 / authorizationList）交易");
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
  try {
    SESSION_MANAGER_IFACE.decodeFunctionData(fnName, data);
  } catch {
    throw new SigningGuardError("TX_NOT_ALLOWLISTED", `${fnName} calldata 無法完整解碼（fail-closed）`);
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
  const domainOk =
    domain?.name === usdc.name &&
    domain?.version === usdc.version &&
    big(domain?.chainId) === BigInt(AGENT_CHAIN_ID) &&
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
    assertAllowedTypedData(domain as any, types, value, this.address);
    return super.signTypedData(domain, types, value);
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
      assertAllowedTypedData(td?.domain ?? {}, td?.types ?? {}, td?.message ?? {}, acc.address, td?.primaryType);
      return acc.signTypedData(td);
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
