// 簽章守門（signing guard）—— agent 金鑰能簽什麼，在「簽之前」就擋。
//
// 業界 agent wallet（Privy / Turnkey / Coinbase）在簽章層做的兩條硬規則，這裡照做：
//   1. **禁止簽 EIP-7702**：type-4 交易、帶 authorizationList 的交易、以及單獨的
//      7702 authorization 簽章（ethers `authorize`、viem `signAuthorization`）。
//      7702 等於把 EOA 的程式碼換掉 —— agent 金鑰一旦簽出去，委派合約就能以這個
//      EOA 的身分做任何事，session 限額完全失效。
//   2. **禁止無上限（實質無上限）授權**：ERC-20 `approve` / `increaseAllowance`、
//      EIP-2612 `permit`、Permit2 `approve` / `permit(PermitSingle)` / `permit(PermitBatch)`
//      的額度 ≥ 絕對上限（預設 2^128，SIGNING_GUARD_MAX_ALLOWANCE）一律拒絕；DAI 式
//      `permit(…, allowed, …)` 的 allowed 為 truthy 即拒絕；對應的 EIP-712 typed data 同規則。
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

/**
 * 授權額度的**絕對上限**（審查 Medium-2）：只擋「剛好等於 MaxUint」擋不住 MaxUint-1、
 * 2^200 這類實質無上限的額度。approve / increaseAllowance / permit / Permit2 的額度
 * 一律要求 `< 上限`（`>=` 上限即拒絕）。預設 2^128（遠大於任何真實交易量，
 * 又遠小於各種「無上限」慣用值），可用 env SIGNING_GUARD_MAX_ALLOWANCE（十進位整數，
 * 代幣最小單位）調整；設定不合法 → 所有授權類簽章一律拒絕（fail-closed）。
 */
export const DEFAULT_MAX_ALLOWANCE = 1n << 128n;

/** 拒絕原因代碼（穩定字串，寫進稽核與錯誤）。 */
export type SigningGuardReason =
  | "EIP7702_TX_FORBIDDEN"
  | "EIP7702_AUTHORIZATION_FORBIDDEN"
  | "RAW_HASH_SIGN_FORBIDDEN"
  | "UNLIMITED_APPROVE_FORBIDDEN"
  | "UNLIMITED_PERMIT_FORBIDDEN"
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

/** 目前的額度上限；env 不合法時丟 GUARD_CONFIG_INVALID（呼叫端一律拒絕）。 */
export function maxAllowance(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.SIGNING_GUARD_MAX_ALLOWANCE?.trim();
  if (!raw) return DEFAULT_MAX_ALLOWANCE;
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new SigningGuardError("GUARD_CONFIG_INVALID", "SIGNING_GUARD_MAX_ALLOWANCE 必須是正整數（fail-closed：拒絕所有授權類簽章）");
  }
  return BigInt(raw);
}

function capCheck(
  amount: unknown,
  reason: "UNLIMITED_APPROVE_FORBIDDEN" | "UNLIMITED_PERMIT_FORBIDDEN",
  what: string,
): SigningGuardError | null {
  const cap = maxAllowance();
  const v = big(amount);
  if (v === null) return new SigningGuardError(reason, `${what} 額度無法解析（fail-closed）`);
  if (v >= cap) return new SigningGuardError(reason, `${what} 額度 ${v} ≥ 上限 ${cap}`);
  return null;
}

// ── calldata 檢查 ─────────────────────────────────────────────────────────────
const IFACE = new ethers.Interface([
  // ERC-20
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  // EIP-2612 / DAI 式 permit（兩者簽章不同，selector 不同）
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)",
  // Permit2 AllowanceTransfer
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)",
  "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)",
]);
const sel = (sig: string) => IFACE.getFunction(sig)!.selector;
const SEL = {
  approve: sel("approve(address,uint256)"),
  increaseAllowance: sel("increaseAllowance(address,uint256)"),
  permit2612: sel("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"),
  permitDai: sel("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)"),
  permit2Approve: sel("approve(address,address,uint160,uint48)"),
  permit2Single: sel("permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)"),
  permit2Batch: sel("permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)"),
};

/** 被守門的 selector（測試與文件用）。 */
export const GUARDED_SELECTORS = SEL;

function decodeBy(selector: string, data: string): ethers.Result | null {
  try {
    const fn = IFACE.getFunction(selector)!;
    return IFACE.decodeFunctionData(fn, data);
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
  const s = data.slice(0, 10).toLowerCase();
  try {
    const A = "UNLIMITED_APPROVE_FORBIDDEN" as const;
    const P = "UNLIMITED_PERMIT_FORBIDDEN" as const;
    const need = (r: ethers.Result | null, reason: typeof A | typeof P, what: string) =>
      r ?? new SigningGuardError(reason, `${what} calldata 無法解析（fail-closed）`);
    switch (s) {
      case SEL.approve: {
        const a = need(decodeBy(s, data), A, "approve");
        return a instanceof SigningGuardError ? a : capCheck(a[1], A, `approve(${a[0]})`);
      }
      case SEL.increaseAllowance: {
        const a = need(decodeBy(s, data), A, "increaseAllowance");
        return a instanceof SigningGuardError ? a : capCheck(a[1], A, `increaseAllowance(${a[0]})`);
      }
      case SEL.permit2612: {
        const a = need(decodeBy(s, data), P, "permit");
        return a instanceof SigningGuardError ? a : capCheck(a[2], P, `permit(spender=${a[1]})`);
      }
      case SEL.permitDai: {
        const a = need(decodeBy(s, data), P, "DAI permit");
        if (a instanceof SigningGuardError) return a;
        return a[4] ? new SigningGuardError(P, `DAI permit(spender=${a[1]}, allowed=${a[4]})＝無上限`) : null;
      }
      case SEL.permit2Approve: {
        const a = need(decodeBy(s, data), A, "Permit2 approve");
        return a instanceof SigningGuardError ? a : capCheck(a[2], A, `Permit2 approve(${a[0]}, ${a[1]})`);
      }
      case SEL.permit2Single: {
        const a = need(decodeBy(s, data), P, "Permit2 permit");
        return a instanceof SigningGuardError ? a : capCheck(a[1][0][1], P, "Permit2 permit(PermitSingle)");
      }
      case SEL.permit2Batch: {
        const a = need(decodeBy(s, data), P, "Permit2 permitBatch");
        if (a instanceof SigningGuardError) return a;
        for (const d of a[1][0] as ethers.Result[]) {
          const bad = capCheck(d[1], P, "Permit2 permit(PermitBatch)");
          if (bad) return bad;
        }
        return null;
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof SigningGuardError) return err;
    return new SigningGuardError("UNLIMITED_APPROVE_FORBIDDEN", "授權類 calldata 檢查失敗（fail-closed）");
  }
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
 * typed data 守門：EIP-2612 Permit（value ≥ 上限）、DAI Permit（allowed 為 truthy）、
 * Permit2 PermitSingle / PermitBatch / PermitTransferFrom 系列（amount ≥ 上限）一律拒絕。
 * x402 用的 EIP-3009 TransferWithAuthorization 金額有限（由 maxValue 約束），不受影響。
 */
export function assertSafeTypedData(
  types: Record<string, unknown>,
  value: Record<string, any>,
  primaryType?: string,
): void {
  const pt = primaryTypeOf(types, primaryType);
  if (!pt) return;
  const P = "UNLIMITED_PERMIT_FORBIDDEN" as const;
  const check = (amt: unknown, what: string) => {
    const bad = capCheck(amt, P, what);
    if (bad) throw bad;
  };
  if (pt === "Permit") {
    // DAI 式：allowed 是 bool，但簽章端可能收到 1 / "true" 之類 → truthy 就拒絕。
    if (value && "allowed" in value) {
      if (value.allowed) throw new SigningGuardError(P, `DAI 式 Permit(allowed=${String(value.allowed)})＝無上限授權`);
      return;
    }
    check(value?.value, "EIP-2612 Permit");
    return;
  }
  if (pt === "PermitSingle" || pt === "PermitBatch") {
    const details = Array.isArray(value?.details) ? value.details : [value?.details];
    for (const d of details) check(d?.amount, `Permit2 ${pt}`);
    return;
  }
  if (pt === "PermitTransferFrom" || pt === "PermitBatchTransferFrom" || pt === "PermitWitnessTransferFrom" ||
      pt === "PermitBatchWitnessTransferFrom") {
    const perms = Array.isArray(value?.permitted) ? value.permitted : [value?.permitted];
    for (const p of perms) check(p?.amount, `Permit2 ${pt}`);
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
