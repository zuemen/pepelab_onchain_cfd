// 收款／分潤地址安全檢查（fail-closed）。
//
// 背景（2026-08-06 稽核）：舊 deployer 的私鑰外洩，該地址鏈上已被寫入 EIP-7702
// 委派碼（`eth_getCode` 以 0xef0100 開頭 → 由 sweeper 合約代管），任何打進去的
// 資產都會被即時掃走。它同時是線上 x402 的 payTo 與兩個 FeeRouter 的
// platformTreasury —— 讓任何人再付錢進這種地址就是把錢直接送給攻擊者。
//
// 規則：
//   1. 命中 COMPROMISED_ADDRESSES（或 env PAYOUT_DENYLIST）→ unsafe，不需 RPC。
//   2. `eth_getCode` 以 0xef0100 開頭（EIP-7702 委派）→ unsafe。
//   3. `requireEoa: true` 時，任何非空 code（合約、Safe）→ unsafe
//      （x402 payTo 必須是持有 FEE_SETTLEMENT_PRIVATE_KEY 的 EOA）。
//   4. 結果快取 PAYOUT_CACHE_TTL_MS（預設 10 分鐘）。RPC 失敗時沿用上次成功讀到的
//      code（即使已過期）；從未成功讀過 → unsafe（fail-closed）。
//
// 這裡**只放地址**，任何私鑰都不應出現在程式碼或註解裡。

/** 已知被接管的地址（全部小寫）。來源：2026-08-06 稽核——外洩的舊 deployer。 */
export const COMPROMISED_ADDRESSES: readonly string[] = [
  "0xe80a81360608c1342e66743f70a00f75d792eb93",
];

/** EIP-7702 委派指示碼前綴（0xef0100 ‖ 20-byte delegate）。 */
export const EIP7702_DELEGATION_PREFIX = "0xef0100";

export const PAYOUT_CACHE_TTL_MS = 10 * 60 * 1000;

export interface PayoutAssessment {
  address: string;
  safe: boolean;
  /** 機器可讀的原因代碼 + 人類可讀說明。 */
  reason: string;
  /** 判斷依據來自哪裡。 */
  source: "denylist" | "invalid" | "rpc" | "cache" | "stale-cache" | "no-data";
  /** 讀到 code 的時間（ms）；denylist/invalid/no-data 為 undefined。 */
  checkedAt?: number;
}

/** 只需要 getCode —— 讓測試可以塞假 provider，不必起 RPC。 */
export interface CodeReader {
  getCode(address: string): Promise<string>;
}

export interface AssessOptions {
  /** true → 任何非空 code 都視為 unsafe（payTo / 結算 signer 用）。 */
  requireEoa?: boolean;
  /** 測試用：覆寫「現在」。 */
  now?: number;
  /** 覆寫快取 TTL。 */
  ttlMs?: number;
  /** 單次 getCode 的逾時（預設 5s）：卡住的 RPC 不能把付費路由一起拖到 function timeout。 */
  timeoutMs?: number;
}

const codeCache = new Map<string, { code: string; at: number }>();

/** 測試用：清空快取。 */
export function clearPayoutSafetyCache(): void {
  codeCache.clear();
}

function denylist(): Set<string> {
  const extra = (process.env.PAYOUT_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  return new Set([...COMPROMISED_ADDRESSES, ...extra]);
}

export function isCompromisedAddress(addr: string): boolean {
  return denylist().has(addr.trim().toLowerCase());
}

function classifyCode(
  address: string,
  code: string,
  requireEoa: boolean,
): { safe: boolean; reason: string } {
  const c = (code ?? "0x").toLowerCase();
  if (c.startsWith(EIP7702_DELEGATION_PREFIX)) {
    return {
      safe: false,
      reason:
        `eip7702_delegated：${address} 帶 EIP-7702 委派碼（${c.slice(0, 48)}…），` +
        `資產會被委派合約代管／掃走，不可收款。`,
    };
  }
  if (requireEoa && c !== "0x" && c !== "0x0") {
    return {
      safe: false,
      reason:
        `not_eoa：${address} 有合約 code，但收款地址必須是持有 FEE_SETTLEMENT_PRIVATE_KEY ` +
        `的 EOA（不可用 Safe／FeeRouter 等合約）。`,
    };
  }
  return { safe: true, reason: "ok" };
}

/**
 * 判斷一個地址能不能拿來收款／分潤。永不丟錯：RPC 失敗會轉成 fail-closed 的結果。
 */
export async function assessPayoutAddress(
  provider: CodeReader,
  addr: string | undefined | null,
  opts: AssessOptions = {},
): Promise<PayoutAssessment> {
  const address = (addr ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
    return {
      address,
      safe: false,
      source: "invalid",
      reason: `invalid_address：「${address || "(空)"}」不是可收款的 EVM 地址。`,
    };
  }
  if (isCompromisedAddress(address)) {
    return {
      address,
      safe: false,
      source: "denylist",
      reason:
        `compromised：${address} 在已知外洩地址清單（2026-08-06 稽核的外洩 deployer），` +
        `私鑰已公開，絕不可再收款。`,
    };
  }

  const key = address.toLowerCase();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? PAYOUT_CACHE_TTL_MS;
  const requireEoa = opts.requireEoa ?? false;
  const cached = codeCache.get(key);

  if (cached && now - cached.at < ttl) {
    return { address, source: "cache", checkedAt: cached.at, ...classifyCode(address, cached.code, requireEoa) };
  }

  try {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      provider.getCode(address),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`getCode 逾時 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    codeCache.set(key, { code, at: now });
    return { address, source: "rpc", checkedAt: now, ...classifyCode(address, code, requireEoa) };
  } catch (err) {
    if (cached) {
      const r = classifyCode(address, cached.code, requireEoa);
      return {
        address,
        source: "stale-cache",
        checkedAt: cached.at,
        safe: r.safe,
        reason:
          `${r.reason}（RPC 失敗，沿用 ${Math.round((now - cached.at) / 1000)}s 前的結果：` +
          `${(err as Error)?.message ?? err}）`,
      };
    }
    return {
      address,
      safe: false,
      source: "no-data",
      reason:
        `rpc_unavailable：無法讀取 ${address} 的 code 且從未成功檢查過，` +
        `fail-closed 視為不安全（${(err as Error)?.message ?? err}）。`,
    };
  }
}
