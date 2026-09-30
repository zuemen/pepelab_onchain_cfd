// signal-api 錯誤型別。呼叫端以 `instanceof` 分流，不需要解析字串。
//
//   SignalApiError                 —— 所有 HTTP 錯誤的基底（status、code、body、url）
//   ├─ PaymentRequiredError   402  —— 需要付款（未注入 payment client，或付款後仍被拒）
//   ├─ RateLimitedError       429  —— 免費端點節流或 facilitator 限流（retryAfterSec）
//   ├─ PayToUnsafeError       503  —— `payto_unsafe`：收款地址未通過守門，**不要付款**
//   ├─ PriceStaleError        503  —— `price_stale`：鏈上價格過期
//   └─ ServiceUnavailableError 502/503 —— 其他上游／內部錯誤
//   PaymentLimitExceededError      —— 402 要求的金額超過 maxPaymentAtomic／累計上限（未簽、未付）
//   PaymentRejectedError           —— 402 的付款要求不符（網路、幣別、收款地址不在白名單）（未簽、未付）
//   PaymentOutcomeUnknownError     —— 已送出 X-PAYMENT 但沒拿到明確結果（逾時／網路錯誤）；**不會自動重試**
//   SignalApiTimeoutError / SignalApiNetworkError —— 未送出付款的請求逾時／連線失敗
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
  constructor(message: string, p: { status: number; code: string | null; body: unknown; url: string }) {
    super(message);
    this.name = "SignalApiError";
    this.status = p.status;
    this.code = p.code;
    this.body = p.body;
    this.url = p.url;
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
      { status: 402, code: typeof b.error === "string" ? b.error : null, body: p.body, url: p.url },
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
  constructor(p: { body: unknown; url: string; retryAfterSec: number | null }) {
    const code = (p.body as ErrorBody | undefined)?.error;
    super(`被節流（429）${p.retryAfterSec !== null ? `，Retry-After ${p.retryAfterSec}s` : ""}`, {
      status: 429,
      code: typeof code === "string" ? code : null,
      body: p.body,
      url: p.url,
    });
    this.name = "RateLimitedError";
    this.retryAfterSec = p.retryAfterSec;
  }
}

export class PayToUnsafeError extends SignalApiError {
  readonly payTo: string;
  readonly reason: string;
  readonly retryAfterSec: number | null;
  constructor(p: { body: PayToUnsafeBody; url: string; retryAfterSec: number | null }) {
    super(`收款地址未通過安全檢查（payto_unsafe），伺服器未發出付款要求：${p.body.reason}`, {
      status: 503,
      code: "payto_unsafe",
      body: p.body,
      url: p.url,
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
  constructor(p: { body: PriceStaleBody; url: string }) {
    super(`鏈上價格過期（${p.body.asset} age ${p.body.ageSec}s > ${p.body.maxPriceAgeSec}s）`, {
      status: 503,
      code: "price_stale",
      body: p.body,
      url: p.url,
    });
    this.name = "PriceStaleError";
    this.asset = p.body.asset;
    this.ageSec = p.body.ageSec;
    this.maxPriceAgeSec = p.body.maxPriceAgeSec;
  }
}

export class ServiceUnavailableError extends SignalApiError {
  constructor(p: { status: number; code: string | null; body: unknown; url: string }) {
    super(`signal-api ${p.status}${p.code ? `（${p.code}）` : ""}`, p);
    this.name = "ServiceUnavailableError";
  }
}

export class PaymentLimitExceededError extends Error {
  readonly requiredAtomic: bigint;
  readonly limitAtomic: bigint;
  readonly kind: "per-request" | "total";
  constructor(p: { requiredAtomic: bigint; limitAtomic: bigint; kind: "per-request" | "total" }) {
    super(
      p.kind === "per-request"
        ? `付款要求 ${p.requiredAtomic} 超過單筆上限 ${p.limitAtomic}（USDC 6 位小數原始值）；未簽署、未付款`
        : `付款後累計將達 ${p.requiredAtomic}，超過累計上限 ${p.limitAtomic}；未簽署、未付款`,
    );
    this.name = "PaymentLimitExceededError";
    this.requiredAtomic = p.requiredAtomic;
    this.limitAtomic = p.limitAtomic;
    this.kind = p.kind;
  }
}

export class PaymentRejectedError extends Error {
  readonly accepts: PaymentRequirements[];
  constructor(message: string, accepts: PaymentRequirements[]) {
    super(`${message}；未簽署、未付款`);
    this.name = "PaymentRejectedError";
    this.accepts = accepts;
  }
}

export class PaymentOutcomeUnknownError extends Error {
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

export class SignalApiTimeoutError extends Error {
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
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`signal-api 連線失敗：${url}（${(cause as Error)?.message ?? cause}）`);
    this.name = "SignalApiNetworkError";
    this.url = url;
    (this as { cause?: unknown }).cause = cause;
  }
}
