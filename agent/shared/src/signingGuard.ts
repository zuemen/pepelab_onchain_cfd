// 簽章守門（signing guard）—— agent 金鑰能簽什麼，在「簽之前」就擋。
//
// 業界 agent wallet（Privy / Turnkey / Coinbase）在簽章層做的兩條硬規則，這裡照做：
//   1. **禁止簽 EIP-7702**：type-4 交易、帶 authorizationList 的交易、以及單獨的
//      7702 authorization 簽章（ethers `authorize`、viem `signAuthorization`）。
//      7702 等於把 EOA 的程式碼換掉 —— agent 金鑰一旦簽出去，委派合約就能以這個
//      EOA 的身分做任何事，session 限額完全失效。
//   2. **禁止無上限授權**：`approve(spender, MaxUint256)`、Permit2 `approve(…, MaxUint160, …)`、
//      EIP-2612 `permit(…, MaxUint256, …)`、DAI 式 `permit(…, allowed=true, …)`，
//      以及對應的 EIP-712 typed data（Permit / PermitSingle / PermitBatch）。
//
// 這一關與 policy gate（policyGate.ts）分工：policy gate 管「這筆單該不該下」，
// 這裡管「這把金鑰能不能簽這種東西」。所有 agent 金鑰的簽章都經過這裡：
//   - ethers 路徑：`makeSigner()` 回傳 `GuardedWallet`（覆寫 signTransaction /
//     signTypedData / authorize / authorizeSync；sendTransaction 內部會走 signTransaction）。
//   - viem 路徑（x402 付費用的 wallet client）：`guardViemAccount(privateKeyToAccount(pk))`。
//
// 誠實邊界：拿得到私鑰原文的程式碼永遠可以繞過任何 JS 包裝（例如直接用 signingKey.sign）。
// 這一關防的是「agent 被 prompt injection / 惡意 402 回應 / 惡意工具參數誘導」去簽
// 危險內容，不是防一個已經被攻陷的 process。
import { ethers } from "ethers";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;

/** 拒絕原因代碼（穩定字串，寫進稽核與錯誤）。 */
export type SigningGuardReason =
  | "EIP7702_TX_FORBIDDEN"
  | "EIP7702_AUTHORIZATION_FORBIDDEN"
  | "RAW_HASH_SIGN_FORBIDDEN"
  | "UNLIMITED_APPROVE_FORBIDDEN"
  | "UNLIMITED_PERMIT_FORBIDDEN";

export class SigningGuardError extends Error {
  constructor(
    public readonly reasonCode: SigningGuardReason,
    detail: string,
  ) {
    super(`[signing-guard] ${reasonCode}: ${detail}`);
    this.name = "SigningGuardError";
  }
}

// ── calldata 檢查 ─────────────────────────────────────────────────────────────
const ABI = ethers.AbiCoder.defaultAbiCoder();
/** approve(address,uint256) — ERC-20 */
const SEL_APPROVE = "0x095ea7b3";
/** approve(address,address,uint160,uint48) — Permit2 */
const SEL_PERMIT2_APPROVE = "0x87517c45";
/** permit(address,address,uint256,uint256,uint8,bytes32,bytes32) — EIP-2612 */
const SEL_PERMIT_2612 = "0xd505accf";
/** permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32) — DAI 式 */
const SEL_PERMIT_DAI = "0x8fcbaf0c";

function decodeArgs(types: string[], data: string): ethers.Result | null {
  try {
    return ABI.decode(types, ethers.dataSlice(data, 4));
  } catch {
    return null;
  }
}

/**
 * 檢查 calldata；回 null＝放行，回 reason＝拒絕。
 * 解不開的 approve/permit calldata 一律**拒絕**（fail-closed）：正常的 ABI 編碼
 * 不會解不開，解不開多半是刻意構造來繞過檢查的。
 */
export function checkCalldata(data: string | null | undefined): SigningGuardError | null {
  if (!data || data === "0x" || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === SEL_APPROVE) {
    const a = decodeArgs(["address", "uint256"], data);
    if (!a) return new SigningGuardError("UNLIMITED_APPROVE_FORBIDDEN", "approve calldata 無法解析（fail-closed）");
    if ((a[1] as bigint) === MAX_UINT256)
      return new SigningGuardError("UNLIMITED_APPROVE_FORBIDDEN", `approve(${a[0]}, MaxUint256)`);
    return null;
  }
  if (sel === SEL_PERMIT2_APPROVE) {
    const a = decodeArgs(["address", "address", "uint160", "uint48"], data);
    if (!a) return new SigningGuardError("UNLIMITED_APPROVE_FORBIDDEN", "Permit2 approve calldata 無法解析（fail-closed）");
    if ((a[2] as bigint) === MAX_UINT160)
      return new SigningGuardError("UNLIMITED_APPROVE_FORBIDDEN", `Permit2 approve(${a[0]}, ${a[1]}, MaxUint160)`);
    return null;
  }
  if (sel === SEL_PERMIT_2612) {
    const a = decodeArgs(["address", "address", "uint256", "uint256", "uint8", "bytes32", "bytes32"], data);
    if (!a) return new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", "permit calldata 無法解析（fail-closed）");
    if ((a[2] as bigint) === MAX_UINT256)
      return new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", `permit(spender=${a[1]}, MaxUint256)`);
    return null;
  }
  if (sel === SEL_PERMIT_DAI) {
    const a = decodeArgs(["address", "address", "uint256", "uint256", "bool", "uint8", "bytes32", "bytes32"], data);
    if (!a) return new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", "DAI permit calldata 無法解析（fail-closed）");
    if (a[4] === true)
      return new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", `DAI permit(spender=${a[1]}, allowed=true)＝無上限`);
    return null;
  }
  return null;
}

/** 交易型別是不是 EIP-7702（ethers 用數字 4，viem 用字串 'eip7702'）。 */
function is7702(tx: { type?: unknown; authorizationList?: unknown }): boolean {
  const t = tx.type;
  if (t === 4 || t === 4n || t === "0x4" || t === "0x04" || t === "eip7702") return true;
  const list = tx.authorizationList as unknown[] | null | undefined;
  return Array.isArray(list) && list.length > 0;
}

/**
 * 交易守門：type-4 / authorizationList / 無上限 approve / 無上限 permit 一律拒絕。
 * 通過時不回傳任何東西；拒絕時丟 `SigningGuardError`。
 */
export function assertSafeTransaction(tx: {
  type?: unknown;
  authorizationList?: unknown;
  data?: string | null;
}): void {
  if (is7702(tx)) {
    throw new SigningGuardError("EIP7702_TX_FORBIDDEN", "agent 金鑰不得簽 EIP-7702（type-4 / authorizationList）交易");
  }
  const bad = checkCalldata(tx.data ?? null);
  if (bad) throw bad;
}

// ── EIP-712 typed data 檢查 ──────────────────────────────────────────────────
function big(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" || typeof v === "string") return BigInt(v);
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 推斷 primaryType：viem 會明給；ethers 沒有 primaryType，取「沒被其他型別引用」的那個。 */
function primaryTypeOf(types: Record<string, unknown>, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const names = Object.keys(types).filter((n) => n !== "EIP712Domain");
  try {
    return ethers.TypedDataEncoder.getPrimaryType(
      Object.fromEntries(names.map((n) => [n, types[n] as ethers.TypedDataField[]])),
    );
  } catch {
    return names[0];
  }
}

/**
 * typed data 守門：EIP-2612 Permit(value=MaxUint256)、DAI Permit(allowed=true)、
 * Permit2 PermitSingle / PermitBatch / PermitTransferFrom 的無上限額度一律拒絕。
 * x402 用的 EIP-3009 TransferWithAuthorization 金額有限（由 maxValue 約束），不受影響。
 */
export function assertSafeTypedData(
  types: Record<string, unknown>,
  value: Record<string, any>,
  primaryType?: string,
): void {
  const pt = primaryTypeOf(types, primaryType);
  if (!pt) return;
  if (pt === "Permit") {
    if (value?.allowed === true)
      throw new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", "DAI 式 Permit(allowed=true)＝無上限授權");
    const v = big(value?.value);
    if (v !== null && v === MAX_UINT256)
      throw new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", "EIP-2612 Permit(value=MaxUint256)");
    return;
  }
  if (pt === "PermitSingle" || pt === "PermitBatch") {
    const details = Array.isArray(value?.details) ? value.details : [value?.details];
    for (const d of details) {
      const amt = big(d?.amount);
      if (amt !== null && amt >= MAX_UINT160)
        throw new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", `Permit2 ${pt}(amount=MaxUint160)`);
    }
    return;
  }
  if (pt === "PermitTransferFrom" || pt === "PermitBatchTransferFrom" || pt === "PermitWitnessTransferFrom") {
    const perms = Array.isArray(value?.permitted) ? value.permitted : [value?.permitted];
    for (const p of perms) {
      const amt = big(p?.amount);
      if (amt !== null && amt === MAX_UINT256)
        throw new SigningGuardError("UNLIMITED_PERMIT_FORBIDDEN", `Permit2 ${pt}(amount=MaxUint256)`);
    }
  }
}

// ── ethers：GuardedWallet ────────────────────────────────────────────────────
/**
 * `ethers.Wallet` 的子類：所有會產生簽章的公開方法都先過守門。
 * `sendTransaction` 在 AbstractSigner 裡是 populate → `this.signTransaction` → broadcast，
 * 因此覆寫 signTransaction 就同時涵蓋 sendTransaction 與所有 `contract.fn()` 寫呼叫。
 */
export class GuardedWallet extends ethers.Wallet {
  override async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    assertSafeTransaction(tx as any);
    return super.signTransaction(tx);
  }

  override async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>,
  ): Promise<string> {
    assertSafeTypedData(types, value);
    return super.signTypedData(domain, types, value);
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
 * 包一個 viem LocalAccount（`privateKeyToAccount(pk)` 的回傳值）：
 *   - signTransaction：先過 assertSafeTransaction
 *   - signTypedData：先過 assertSafeTypedData
 *   - signAuthorization（7702）與 sign（裸 hash 簽章，可用來簽 7702 authorization
 *     的 digest）：一律丟錯
 * 不 import viem（shared 不依賴它），以結構型別處理，回傳型別與輸入相同。
 */
export function guardViemAccount<A extends { type: string; address: string }>(account: A): A {
  const acc = account as any;
  const wrapped: any = { ...acc };
  if (typeof acc.signTransaction === "function") {
    wrapped.signTransaction = async (tx: any, opts?: any) => {
      assertSafeTransaction(tx ?? {});
      return acc.signTransaction(tx, opts);
    };
  }
  if (typeof acc.signTypedData === "function") {
    wrapped.signTypedData = async (td: any) => {
      assertSafeTypedData(td?.types ?? {}, td?.message ?? {}, td?.primaryType);
      return acc.signTypedData(td);
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
