// x402 付款端（client）的共用防護：單筆付款上限 + 實付金額計量。
//
// 1. maxValue：x402-fetch 的 wrapFetchWithPayment 第三個參數是「願意為單次請求簽出的
//    最高金額」（atomic units；官方 USDC 6 位小數）。不傳時套件預設 0.10 USDC——
//    伺服器回一張 0.10 的 402，client 就會照簽。這裡改成**明確傳入**，預設 0.02 USDC，
//    可由 env `X402_MAX_PAYMENT_USDC` 設定。
// 2. meteredFetch：包在 wrapFetchWithPayment 底下的 fetch，從它送出的 X-PAYMENT
//    （EIP-3009 authorization.value）讀出**實際簽出的金額**，只有在付款確實成立時
//    （回應帶 X-PAYMENT-RESPONSE 或 status < 400）才累計。花費上限應該用這個數字，
//    而不是「單價常數 × 次數」——伺服器改價、或回了不同的 402，常數就不準了。

/** 預設單筆上限（USDC）。 */
export const X402_DEFAULT_MAX_PAYMENT_USDC = "0.02";
/** 官方 USDC 小數位。 */
export const USDC_DECIMALS = 6;

/** "0.02" → 20000n（6 位小數）。格式錯誤丟錯。 */
export function parseUsdcAtomic(s: string): bigint {
  const t = s.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) throw new Error(`不是合法的 USDC 金額（最多 6 位小數）：「${s}」`);
  const frac = (m[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return BigInt(m[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac || "0");
}

/** 20000n → "0.02"。 */
export function formatUsdcAtomic(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const frac = (a % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? "." + frac : ""}`;
}

/** 預設累計花費上限（USDC）。 */
export const X402_DEFAULT_MAX_TOTAL_SPEND_USDC = "1";

/**
 * 累計花費上限（atomic），所有 x402 付款流程共用（簽章守門在簽出每筆 x402 授權前檢查）。
 * env `X402_MAX_TOTAL_SPEND_USDC`；舊名 `LOOP_MAX_SPEND_USDC` 仍可用（向後相容）；預設 1 USDC。
 */
export function resolveX402TotalSpendCap(): bigint {
  const raw =
    process.env.X402_MAX_TOTAL_SPEND_USDC?.trim() ||
    process.env.LOOP_MAX_SPEND_USDC?.trim() ||
    X402_DEFAULT_MAX_TOTAL_SPEND_USDC;
  const v = parseUsdcAtomic(raw);
  if (v <= 0n) throw new Error(`X402_MAX_TOTAL_SPEND_USDC 必須 > 0（收到 ${raw}）`);
  return v;
}

/** 單筆付款上限（atomic）。env `X402_MAX_PAYMENT_USDC`，預設 0.02 USDC；0 或負數拒絕。 */
export function resolveX402MaxValue(): bigint {
  const raw = process.env.X402_MAX_PAYMENT_USDC?.trim() || X402_DEFAULT_MAX_PAYMENT_USDC;
  const v = parseUsdcAtomic(raw);
  if (v <= 0n) throw new Error(`X402_MAX_PAYMENT_USDC 必須 > 0（收到 ${raw}）`);
  return v;
}

/** 解出 X-PAYMENT header（base64 JSON）裡 EIP-3009 authorization.value；解不出來回 null。 */
export function paymentValueFromHeader(header: string | null | undefined): bigint | null {
  if (!header) return null;
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload?: { authorization?: { value?: string } };
    };
    const v = j?.payload?.authorization?.value;
    return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

export interface PaymentMeter {
  /** 交給 wrapFetchWithPayment 當底層 fetch。 */
  fetch: typeof globalThis.fetch;
  /** 累計實付（atomic）。 */
  totalPaidAtomic(): bigint;
  /** 最近一次成立的付款金額（atomic）；最近一次請求沒有付款成立則為 null。 */
  lastPaidAtomic(): bigint | null;
}

/** 建一個會記錄實付金額的 fetch。 */
export function meteredFetch(base: typeof globalThis.fetch = globalThis.fetch): PaymentMeter {
  let total = 0n;
  let last: bigint | null = null;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const value = paymentValueFromHeader(headers.get("X-PAYMENT"));
    const res = await base(input, init);
    if (value !== null) {
      // 帶了付款授權：回應帶 X-PAYMENT-RESPONSE（facilitator 結算成功）或成功狀態碼，
      // 就當作已付。寧可高估不可低估——這個數字是拿來擋花費上限的。
      if (res.headers.has("X-PAYMENT-RESPONSE") || res.status < 400) {
        total += value;
        last = value;
      } else {
        last = null;
      }
    }
    return res;
  }) as typeof globalThis.fetch;
  return { fetch: wrapped, totalPaidAtomic: () => total, lastPaidAtomic: () => last };
}
