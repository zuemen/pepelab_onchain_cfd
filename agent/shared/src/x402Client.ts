// x402 付款端（client）的共用防護：單筆付款上限 + 實付金額計量。
//
// 1. maxValue：x402-fetch 的 wrapFetchWithPayment 第三個參數是「願意為單次請求簽出的
//    最高金額」（atomic units；官方 USDC 6 位小數）。不傳時套件預設 0.10 USDC——
//    伺服器回一張 0.10 的 402，client 就會照簽。這裡改成**明確傳入**，預設 0.02 USDC，
//    可由 env `X402_MAX_PAYMENT_USDC` 設定。
// 2. meteredFetch：包在 wrapFetchWithPayment 底下的 fetch，從它送出的 X-PAYMENT
//    （EIP-3009 authorization.value）讀出**實際簽出的金額**。三個數字：
//      - totalSentAtomic：所有**送出過**的授權（不論回應狀態、不論 base() 是否丟錯）。
//        授權一旦交給伺服器，validBefore 之前都可能被結算 —— 花費上限應該用這個保守值。
//      - unsettledAtomic：其中沒有拿到 X-PAYMENT-RESPONSE（結算證明）的部分，需要對帳。
//      - totalPaidAtomic：確定成立的付款（有 X-PAYMENT-RESPONSE 或 status < 400）。
//    以前只有 totalPaidAtomic，付款後 502／斷線都不計，花費被低估（shared-race PoC C）。
// 3. x402 v2（docs/ADR-009-x402-v2-migration.md）：付款 header 改名 PAYMENT-SIGNATURE、結算證明改名
//    PAYMENT-RESPONSE。meteredFetch 兩種都認；差別是 **v2 的 PAYMENT-RESPONSE 在結算失敗的 402 也會
//    出現（success:false）**，所以 v2 要解開看 success，不能像 v1 只看 header 有沒有。
//    @x402/fetch 沒有 v1 的 maxValue 參數，單筆上限改由 x402Client 的 spendControls 設定——
//    見 x402V2SpendControls()；真正的最後防線仍是簽章守門（signingGuard.ts）。

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

/**
 * 解出付款 header（base64 JSON）裡 EIP-3009 authorization.value；解不出來回 null。
 * v1 的 X-PAYMENT 與 v2 的 PAYMENT-SIGNATURE（exact／EIP-3009）都是 `payload.authorization.value`。
 * v2 的 Permit2 payload（`payload.permit2Authorization`）刻意不解：簽章守門不放行 Permit2，
 * 真的出現就讓呼叫端以單筆上限保守計入。
 */
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

/** v1／v2 的付款 header 與結算證明 header。 */
export const X402_PAYMENT_HEADERS = ["PAYMENT-SIGNATURE", "X-PAYMENT"] as const;

/**
 * 回應是否帶「結算成功」的證明。
 *   v1：X-PAYMENT-RESPONSE 只在結算成功時出現 → 有就算。
 *   v2：PAYMENT-RESPONSE 在結算失敗時也會出現 → 必須解得開且 success === true。
 */
export function hasSettlementProof(headers: Headers): boolean {
  if (headers.has("X-PAYMENT-RESPONSE")) return true;
  const v2 = headers.get("PAYMENT-RESPONSE");
  if (!v2) return false;
  try {
    const j = JSON.parse(Buffer.from(v2, "base64").toString("utf8")) as { success?: unknown };
    return j?.success === true;
  } catch {
    return false;
  }
}

/**
 * @x402/core 的 x402Client spendControls（v2 client 的單筆上限）。不設的話套件預設是 **$1**。
 * 回傳純物件（shared 不依賴 @x402/*）：`x402Client.fromConfig({ schemes, spendControls: x402V2SpendControls() })`
 * 或 `client.setSpendControls(x402V2SpendControls())`。金額沿用 X402_MAX_PAYMENT_USDC（預設 0.02）。
 * 沒有列 allowedAssets → 只接受該網路的預設資產（官方 USDC）。
 */
export function x402V2SpendControls(): { maxAmountPerPayment: string } {
  return { maxAmountPerPayment: `$${formatUsdcAtomic(resolveX402MaxValue())}` };
}

/**
 * @x402/core 的 payment policy：只留下 exact／EIP-3009／authorization flow 的付款要求。
 * Permit2（extra.assetTransferMethod = "permit2"）、upto、upfront／escrow 一律濾掉——簽章守門本來就
 * 不會簽它們，這裡只是讓 client 在選付款方式時就明確失敗，而不是走到簽章才被擋。
 * 用法：`client.registerPolicy(x402V2Eip3009OnlyPolicy)`。
 */
export function x402V2Eip3009OnlyPolicy<R extends { scheme?: unknown; extra?: unknown }>(
  _x402Version: number,
  requirements: R[],
): R[] {
  return requirements.filter((r) => {
    const extra = (r.extra ?? {}) as { assetTransferMethod?: unknown; paymentFlow?: unknown };
    const atm = extra.assetTransferMethod ?? "eip3009";
    const flow = extra.paymentFlow ?? "authorization";
    return r.scheme === "exact" && atm === "eip3009" && flow === "authorization";
  });
}

export interface PaymentMeter {
  /** 交給 wrapFetchWithPayment 當底層 fetch。 */
  fetch: typeof globalThis.fetch;
  /** 累計**已送出**的授權（atomic）：不論結果。花費上限請用這個。 */
  totalSentAtomic(): bigint;
  /** 已送出但沒有結算證明（X-PAYMENT-RESPONSE／v2 的 PAYMENT-RESPONSE success:true）的授權（atomic），含 base() 丟錯的。 */
  unsettledAtomic(): bigint;
  /** 累計確定成立的付款（atomic）。 */
  totalPaidAtomic(): bigint;
  /** 最近一次成立的付款金額（atomic）；最近一次請求沒有付款成立則為 null。 */
  lastPaidAtomic(): bigint | null;
}

function maxValueOrDefault(): bigint {
  try {
    return resolveX402MaxValue();
  } catch {
    return parseUsdcAtomic(X402_DEFAULT_MAX_PAYMENT_USDC);
  }
}

/** 建一個會記錄實付金額的 fetch。 */
export function meteredFetch(base: typeof globalThis.fetch = globalThis.fetch): PaymentMeter {
  let total = 0n;
  let sent = 0n;
  let unsettled = 0n;
  let last: bigint | null = null;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // v2（PAYMENT-SIGNATURE）優先；兩個都帶時各是一張獨立的授權，金額相加（保守）。
    const payments = X402_PAYMENT_HEADERS.map((h) => headers.get(h)).filter((h): h is string => Boolean(h));
    const payment = payments[0] ?? null;
    const values = payments.map(paymentValueFromHeader);
    const value = values.length && values.every((v) => v !== null) ? values.reduce<bigint>((a, v) => a + v!, 0n) : null;
    // 帶了付款 header 卻解不出金額：無法證明沒付錢 → 已送出／未結算以單筆上限保守計入
    // （totalPaidAtomic 仍只計解得出金額的）。
    const sentValue = value ?? (payment ? maxValueOrDefault() * BigInt(payments.length) : null);
    if (sentValue !== null) sent += sentValue; // 送出前就記：base() 丟錯也算已送出
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      if (sentValue !== null) {
        unsettled += sentValue;
        last = null;
      }
      throw err;
    }
    const settled = hasSettlementProof(res.headers);
    if (sentValue !== null && !settled) unsettled += sentValue;
    if (value !== null) {
      // 帶了付款授權：回應帶結算成功的證明（v1 X-PAYMENT-RESPONSE／v2 PAYMENT-RESPONSE success:true）
      // 或成功狀態碼，就當作已付。寧可高估不可低估——這個數字是拿來擋花費上限的。
      if (settled || res.status < 400) {
        total += value;
        last = value;
      } else {
        last = null;
      }
    }
    return res;
  }) as typeof globalThis.fetch;
  return {
    fetch: wrapped,
    totalSentAtomic: () => sent,
    unsettledAtomic: () => unsettled,
    totalPaidAtomic: () => total,
    lastPaidAtomic: () => last,
  };
}
