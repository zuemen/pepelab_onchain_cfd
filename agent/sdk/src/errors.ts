// signal-api 錯誤型別。呼叫端以 `instanceof` 分流，不需要解析字串。
//
//   SignalApiError                 —— 所有 HTTP 錯誤的基底（status、code、body、url）
//   ├─ PaymentRequiredError   402  —— 需要付款（未注入 payment client，或付款後仍被拒）
//   ├─ RateLimitedError       429  —— 免費端點節流或 facilitator 限流（retryAfterSec）
//   ├─ PayToUnsafeError       503  —— `payto_unsafe`：收款地址未通過守門，**不要付款**
//   ├─ PriceStaleError        503  —— `price_stale`：鏈上價格過期
//   └─ ServiceUnavailableError 502/503 —— 其他上游／內部錯誤
//   PaymentLimitExceededError      —— 要求或簽出的金額超過單筆／累計上限（未送出、未付）
//   PaymentRejectedError           —— 付款要求不符（網路、幣別、payTo 白名單、逾時上限），或簽出的
//                                     X-PAYMENT 與要求不一致（收款人、scheme、network、版本、validBefore）（未送出、未付）
//   PaymentOutcomeUnknownError     —— 已送出 X-PAYMENT 但沒拿到明確結果（逾時／網路錯誤）；**不會自動重試**
//
// paymentSent：所有「帶了 X-PAYMENT 之後」產生的錯誤都是 true（包含 402／429／5xx）。
// 此時已簽的 EIP-3009 授權已交給伺服器，在 validBefore 之前仍可能被結算 ——
// **先對帳再決定是否重送，不要依 retryAfterSec 直接重試**（重試會簽一張新的授權，可能雙付）。
//   PaymentSignTimeoutError        —— 簽署端在 paymentSignTimeoutMs 內沒有回應；預留已回滾，之後才回來的簽章一律丟棄（未送出、未付）
//   SignalApiTimeoutError / SignalApiNetworkError —— 未送出付款的請求逾時／連線失敗（paymentSent 一律 false；
//                                     帶付款的請求逾時／斷線改丟 PaymentOutcomeUnknownError）
import type {
  ErrorBody,
  PaymentRequirements,
  PayToUnsafeBody,
  PriceStaleBody,
} from "./signalApiTypes.ts";

export class SignalApiError extends Error {
  readonly status: number;
  /** 伺服器回傳的原因代碼（body.error，若為字串）。 */
  readonly code: string | null;
  readonly body: unknown;
  readonly url: string;
  /** true = 這個錯誤發生在送出 X-PAYMENT 之後；已簽授權可能仍會被結算，先對帳再重送。 */
  readonly paymentSent: boolean;
  constructor(message: string, p: { status: number; code: string | null; body: unknown; url: string; paymentSent?: boolean }) {
    super(message);
    this.name = "SignalApiError";
    this.status = p.status;
    this.code = p.code;
    this.body = p.body;
    this.url = p.url;
    this.paymentSent = p.paymentSent ?? false;
  }
}

export class PaymentRequiredError extends SignalApiError {
  readonly accepts: PaymentRequirements[];
  readonly x402Version: number | null;
  /** true = 已經送過 X-PAYMENT 仍被 402（付款驗證或結算失敗）。 */
  readonly afterPayment: boolean;
  constructor(p: { body: unknown; url: string; afterPayment: boolean }) {
    const b = (p.body ?? {}) as { accepts?: PaymentRequirements[]; x402Version?: number; error?: unknown };
    super(
      p.afterPayment
        ? `付款後仍回 402（驗證或結算失敗）：${typeof b.error === "string" ? b.error : "unknown"}`
        : "此端點需要 x402 付款；請在 SignalApiClient 注入 payment client",
      { status: 402, code: typeof b.error === "string" ? b.error : null, body: p.body, url: p.url, paymentSent: p.afterPayment },
    );
    this.name = "PaymentRequiredError";
    this.accepts = Array.isArray(b.accepts) ? b.accepts : [];
    this.x402Version = typeof b.x402Version === "number" ? b.x402Version : null;
    this.afterPayment = p.afterPayment;
  }
}

export class RateLimitedError extends SignalApiError {
  /** Retry-After（秒）；沒有時為 null。 */
  readonly retryAfterSec: number | null;
  constructor(p: { body: unknown; url: string; retryAfterSec: number | null; paymentSent?: boolean }) {
    const code = (p.body as ErrorBody | undefined)?.error;
    super(
      `被節流（429）${p.retryAfterSec !== null ? `，Retry-After ${p.retryAfterSec}s` : ""}` +
        (p.paymentSent ? "；已送出付款授權，先對帳再重送" : ""),
      { status: 429, code: typeof code === "string" ? code : null, body: p.body, url: p.url, paymentSent: p.paymentSent },
    );
    this.name = "RateLimitedError";
    this.retryAfterSec = p.retryAfterSec;
  }
}

export class PayToUnsafeError extends SignalApiError {
  readonly payTo: string;
  readonly reason: string;
  readonly retryAfterSec: number | null;
  constructor(p: { body: PayToUnsafeBody; url: string; retryAfterSec: number | null; paymentSent?: boolean }) {
    super(`收款地址未通過安全檢查（payto_unsafe），伺服器未發出付款要求：${p.body.reason}`, {
      status: 503,
      code: "payto_unsafe",
      body: p.body,
      url: p.url,
      paymentSent: p.paymentSent,
    });
    this.name = "PayToUnsafeError";
    this.payTo = p.body.payTo;
    this.reason = p.body.reason;
    this.retryAfterSec = p.retryAfterSec;
  }
}

export class PriceStaleError extends SignalApiError {
  readonly asset: string;
  readonly ageSec: number;
  readonly maxPriceAgeSec: number;
  constructor(p: { body: PriceStaleBody; url: string; paymentSent?: boolean }) {
    super(`鏈上價格過期（${p.body.asset} age ${p.body.ageSec}s > ${p.body.maxPriceAgeSec}s）`, {
      status: 503,
      code: "price_stale",
      body: p.body,
      url: p.url,
      paymentSent: p.paymentSent,
    });
    this.name = "PriceStaleError";
    this.asset = p.body.asset;
    this.ageSec = p.body.ageSec;
    this.maxPriceAgeSec = p.body.maxPriceAgeSec;
  }
}

export class ServiceUnavailableError extends SignalApiError {
  constructor(p: { status: number; code: string | null; body: unknown; url: string; paymentSent?: boolean }) {
    super(`signal-api ${p.status}${p.code ? `（${p.code}）` : ""}${p.paymentSent ? "；已送出付款授權，先對帳再重送" : ""}`, p);
    this.name = "ServiceUnavailableError";
  }
}

export class PaymentLimitExceededError extends Error {
  /** 一律為 false：在送出 X-PAYMENT 之前就擋下。 */
  readonly paymentSent = false as const;
  readonly requiredAtomic: bigint;
  readonly limitAtomic: bigint;
  readonly kind: "per-request" | "total";
  constructor(p: { requiredAtomic: bigint; limitAtomic: bigint; kind: "per-request" | "total" }) {
    super(
      p.kind === "per-request"
        ? `付款要求 ${p.requiredAtomic} 超過單筆上限 ${p.limitAtomic}（USDC 6 位小數原始值）；未送出付款授權、未付款`
        : `付款後累計將達 ${p.requiredAtomic}，超過累計上限 ${p.limitAtomic}；未送出付款授權、未付款`,
    );
    this.name = "PaymentLimitExceededError";
    this.requiredAtomic = p.requiredAtomic;
    this.limitAtomic = p.limitAtomic;
    this.kind = p.kind;
  }
}

export class PaymentRejectedError extends Error {
  /** 一律為 false：在送出 X-PAYMENT 之前就擋下。 */
  readonly paymentSent = false as const;
  readonly accepts: PaymentRequirements[];
  constructor(message: string, accepts: PaymentRequirements[]) {
    super(`${message}；未送出付款授權、未付款`);
    this.name = "PaymentRejectedError";
    this.accepts = accepts;
  }
}

export class PaymentOutcomeUnknownError extends Error {
  /** 一律為 true：授權已送出。 */
  readonly paymentSent = true as const;
  readonly url: string;
  readonly signedAtomic: bigint | null;
  constructor(p: { url: string; signedAtomic: bigint | null; cause: unknown }) {
    super(
      `已送出付款授權但未取得明確結果（${(p.cause as Error)?.message ?? p.cause}）。` +
        `款項可能已結算，SDK 不會自動重試；請以 facilitator／鏈上紀錄對帳後再決定是否重送。`,
    );
    this.name = "PaymentOutcomeUnknownError";
    this.url = p.url;
    this.signedAtomic = p.signedAtomic;
    (this as { cause?: unknown }).cause = p.cause;
  }
}

export class PaymentSignTimeoutError extends Error {
  /** 一律為 false：簽署端逾時，SDK 沒有送出任何 X-PAYMENT；之後才回來的簽章會被丟棄。 */
  readonly paymentSent = false as const;
  readonly url: string;
  readonly timeoutMs: number;
  constructor(p: { url: string; timeoutMs: number }) {
    super(
      `付款簽署端 ${p.timeoutMs}ms 內未回應；已回滾預留額度，之後才回傳的簽章一律丟棄、不會送出；未付款`,
    );
    this.name = "PaymentSignTimeoutError";
    this.url = p.url;
    this.timeoutMs = p.timeoutMs;
  }
}

export class SignalApiTimeoutError extends Error {
  /**
   * 一律為 false：這個錯誤只會發生在沒帶 X-PAYMENT 的請求（帶付款的請求逾時改丟
   * PaymentOutcomeUnknownError）。與 SignalApiError 一樣有這個欄位，呼叫端可以一律檢查 `e.paymentSent`。
   */
  readonly paymentSent = false as const;
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`signal-api 請求逾時（${timeoutMs}ms）：${url}`);
    this.name = "SignalApiTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class SignalApiNetworkError extends Error {
  /** 一律為 false：同 SignalApiTimeoutError（帶付款的請求斷線改丟 PaymentOutcomeUnknownError）。 */
  readonly paymentSent = false as const;
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`signal-api 連線失敗：${url}（${(cause as Error)?.message ?? cause}）`);
    this.name = "SignalApiNetworkError";
    this.url = url;
    (this as { cause?: unknown }).cause = cause;
  }
}
