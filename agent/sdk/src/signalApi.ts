// signal-api 型別化 client。
//
// 規則：
//   • 逾時：每個 HTTP 請求各自 AbortController（預設 15 秒）。
//   • 重試：**只重試沒有帶付款的 GET**（網路錯誤、逾時、429〔Retry-After 夠短時〕、500/502/503/504）。
//     `payto_unsafe`、`price_stale` 不重試（重試也不會變）。帶了 X-PAYMENT 的請求**永遠不重試** ——
//     x402 沒有退款，重送一張已簽的授權可能造成重複付款。
//   • 付款：SDK 不持有私鑰。付費端點由呼叫端注入 `X402PaymentClient`（通常包著 HSM／MPC／
//     guardViemAccount 簽署端），SDK 只負責：挑選付款要求、檢查網路／幣別／收款地址、
//     檢查單筆與累計上限（預設沿用 agent 的 0.02 USDC／1 USDC）、送出並記帳。
//   • 付費端點在發出 402 之前的守門錯誤（400、503 payto_unsafe、503 price_stale）一律
//     在「簽任何東西之前」就以型別化錯誤丟出。
import { getAddress, isAddress } from "viem";

import { OFFICIAL_BASE_SEPOLIA_USDC } from "../../shared/src/env.ts";
import {
  formatUsdcAtomic,
  parseUsdcAtomic,
  paymentValueFromHeader,
  X402_DEFAULT_MAX_PAYMENT_USDC,
  X402_DEFAULT_MAX_TOTAL_SPEND_USDC,
} from "../../shared/src/x402Client.ts";
import {
  PaymentLimitExceededError,
  PaymentOutcomeUnknownError,
  PaymentRejectedError,
  PaymentRequiredError,
  PayToUnsafeError,
  PriceStaleError,
  RateLimitedError,
  ServiceUnavailableError,
  SignalApiError,
  SignalApiNetworkError,
  SignalApiTimeoutError,
} from "./errors.ts";
import type {
  AgentVerificationResponse,
  BenchmarksResponse,
  CandleInterval,
  CandleResponse,
  Discovery,
  OracleSnapshot,
  PaidEnvelope,
  PaymentRequirements,
  PayToUnsafeBody,
  PriceStaleBody,
  Revenue,
  RiskExposure,
  TraderPerformance,
  X402PaymentRequiredBody,
} from "./signalApiTypes.ts";

export const DEFAULT_SIGNAL_API_URL = "https://agent-git-master-zuemens-projects.vercel.app";
export const DEFAULT_X402_NETWORK = "base-sepolia";
/** 預設單筆付款上限（atomic，6 位小數）＝ agent 的 X402_DEFAULT_MAX_PAYMENT_USDC（0.02 USDC）。 */
export const DEFAULT_MAX_PAYMENT_ATOMIC = parseUsdcAtomic(X402_DEFAULT_MAX_PAYMENT_USDC);
/** 預設「此 client 生命週期內」累計上限（atomic）＝ agent 的 X402_DEFAULT_MAX_TOTAL_SPEND_USDC（1 USDC）。 */
export const DEFAULT_MAX_TOTAL_SPEND_ATOMIC = parseUsdcAtomic(X402_DEFAULT_MAX_TOTAL_SPEND_USDC);

/** 端點目錄（test/openapi-schema.test.ts 與 openapi.yaml 的 paths 逐一比對）。 */
export const OPERATIONS = {
  healthz: { method: "GET", path: "/healthz", paid: false },
  discover: { method: "GET", path: "/", paid: false },
  getRevenue: { method: "GET", path: "/revenue", paid: false },
  getCandles: { method: "GET", path: "/candles/{symbol}", paid: false },
  getBenchmarks: { method: "GET", path: "/benchmarks", paid: false },
  getRiskExposure: { method: "GET", path: "/risk/exposure", paid: false },
  getAgentVerification: { method: "GET", path: "/agent/{did}/verification", paid: false },
  getSignal: { method: "GET", path: "/signals/{trader}", paid: true },
  getOracleSnapshot: { method: "GET", path: "/oracle/{asset}", paid: true },
} as const;

/**
 * 由呼叫端提供的 x402 付款簽署端。SDK 把「已通過檢查的一筆付款要求」交給它，
 * 它回傳 X-PAYMENT 標頭值（base64）。私鑰只存在於它的實作裡。
 *
 * 典型實作（x402 0.5.x）：
 *   import { createPaymentHeader } from "x402/client";
 *   const payment = { createPaymentHeader: ({ requirements, x402Version }) =>
 *     createPaymentHeader(guardedAccount, x402Version, requirements) };
 */
export interface X402PaymentClient {
  createPaymentHeader(args: {
    requirements: PaymentRequirements;
    x402Version: number;
    /** SDK 已檢查 requirements.maxAmountRequired ≤ 這個值；實作端可再自行檢查。 */
    maxValueAtomic: bigint;
    /** 請求的完整 URL。 */
    resource: string;
  }): Promise<string>;
}

export interface RetryOptions {
  /** 最多重試次數（不含第一次）。預設 2。 */
  retries?: number;
  /** 指數退避基準（ms）。預設 300。 */
  baseDelayMs?: number;
  /** 單次等待上限（ms）。預設 5000。 */
  maxDelayMs?: number;
  /** 429 的 Retry-After 超過這個秒數就不重試、直接丟 RateLimitedError。預設 10。 */
  maxRetryAfterSec?: number;
}

export interface SignalApiClientConfig {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** 每個 HTTP 請求的逾時（ms）。預設 15000。 */
  timeoutMs?: number;
  retry?: RetryOptions;
  /** 付費端點用；不提供時付費端點會丟 PaymentRequiredError（不付款）。 */
  payment?: X402PaymentClient;
  /** 單筆上限（USDC 6 位小數原始值）。預設 20000（0.02 USDC）。必須 > 0。 */
  maxPaymentAtomic?: bigint;
  /** 此 client 的累計上限。預設 1_000000（1 USDC）。必須 > 0。 */
  maxTotalSpendAtomic?: bigint;
  /** 只接受這個 x402 network。預設 base-sepolia。 */
  expectedNetwork?: string;
  /** 只接受這個結算代幣。預設 Circle 官方 Base Sepolia USDC。 */
  expectedAsset?: string;
  /** 若提供，payTo 必須在清單內。 */
  payToAllowlist?: readonly string[];
  /** 測試用：可替換等待與亂數。 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface PaymentReceipt {
  /** 實際簽出且成立的金額（atomic）。 */
  paidAtomic: bigint;
  /** 同上，十進位字串（USDC）。 */
  paidUsdc: string;
  payTo: string;
  network: string;
  asset: string;
  /** X-PAYMENT-RESPONSE 解碼後的內容（facilitator 結算證明）；沒有時為 null。 */
  settlement: unknown | null;
}

export interface PaidResult<T> {
  body: PaidEnvelope<T>;
  /** null = 伺服器沒有要求付款（例如本機未開 paywall）。 */
  payment: PaymentReceipt | null;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_CODES = new Set(["payto_unsafe", "price_stale"]);

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : null;
}

function codeOf(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : null;
}

function decodeSettlement(h: string | null): unknown | null {
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return h;
  }
}

/** 把非 2xx 回應轉成型別化錯誤。 */
export function toSignalApiError(res: RawResponse, url: string, afterPayment = false): SignalApiError {
  const code = codeOf(res.body);
  const retryAfterSec = parseRetryAfter(res.headers.get("retry-after"));
  if (res.status === 402) return new PaymentRequiredError({ body: res.body, url, afterPayment });
  if (res.status === 429) return new RateLimitedError({ body: res.body, url, retryAfterSec });
  if (res.status === 503 && code === "payto_unsafe") {
    return new PayToUnsafeError({ body: res.body as PayToUnsafeBody, url, retryAfterSec });
  }
  if (res.status === 503 && code === "price_stale") return new PriceStaleError({ body: res.body as PriceStaleBody, url });
  if (res.status >= 500) return new ServiceUnavailableError({ status: res.status, code, body: res.body, url });
  const msg = (res.body as { message?: string } | null)?.message;
  return new SignalApiError(`signal-api ${res.status}${code ? `（${code}）` : ""}${msg ? `：${msg}` : ""}`, {
    status: res.status,
    code,
    body: res.body,
    url,
  });
}

export class SignalApiClient {
  readonly baseUrl: string;
  readonly maxPaymentAtomic: bigint;
  readonly maxTotalSpendAtomic: bigint;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;
  private readonly payment?: X402PaymentClient;
  private readonly expectedNetwork: string;
  private readonly expectedAsset: string;
  private readonly payToAllowlist: Set<string> | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private spent = 0n;

  constructor(cfg: SignalApiClientConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_SIGNAL_API_URL).replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.retry = {
      retries: Math.max(0, cfg.retry?.retries ?? 2),
      baseDelayMs: cfg.retry?.baseDelayMs ?? 300,
      maxDelayMs: cfg.retry?.maxDelayMs ?? 5_000,
      maxRetryAfterSec: cfg.retry?.maxRetryAfterSec ?? 10,
    };
    this.payment = cfg.payment;
    this.maxPaymentAtomic = cfg.maxPaymentAtomic ?? DEFAULT_MAX_PAYMENT_ATOMIC;
    this.maxTotalSpendAtomic = cfg.maxTotalSpendAtomic ?? DEFAULT_MAX_TOTAL_SPEND_ATOMIC;
    if (this.maxPaymentAtomic <= 0n) throw new Error("maxPaymentAtomic 必須 > 0");
    if (this.maxTotalSpendAtomic <= 0n) throw new Error("maxTotalSpendAtomic 必須 > 0");
    this.expectedNetwork = cfg.expectedNetwork ?? DEFAULT_X402_NETWORK;
    this.expectedAsset = (cfg.expectedAsset ?? OFFICIAL_BASE_SEPOLIA_USDC).toLowerCase();
    this.payToAllowlist = cfg.payToAllowlist
      ? new Set(cfg.payToAllowlist.map((a) => {
          if (!isAddress(a)) throw new Error(`payToAllowlist 含非法地址：${a}`);
          return a.toLowerCase();
        }))
      : null;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = cfg.random ?? Math.random;
  }

  /** 此 client 累計實付（atomic）。 */
  spentAtomic(): bigint {
    return this.spent;
  }

  // ── 免費端點 ───────────────────────────────────────────────────────────────

  async healthz(): Promise<string> {
    const r = await this.getWithRetry(this.url(OPERATIONS.healthz.path));
    return r.text;
  }

  discover(): Promise<Discovery> {
    return this.getJson<Discovery>(this.url("/"));
  }

  getRevenue(opts: { trader?: string } = {}): Promise<Revenue> {
    return this.getJson<Revenue>(this.url("/revenue", { trader: opts.trader }));
  }

  getCandles(
    symbol: string,
    opts: { interval?: CandleInterval; limit?: number; end?: number } = {},
  ): Promise<CandleResponse> {
    return this.getJson<CandleResponse>(
      this.url(`/candles/${encodeURIComponent(symbol)}`, {
        interval: opts.interval,
        limit: opts.limit,
        end: opts.end,
      }),
    );
  }

  getBenchmarks(opts: { date?: string } = {}): Promise<BenchmarksResponse> {
    if (opts.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
      throw new TypeError(`date 必須是 YYYY-MM-DD：${opts.date}`);
    }
    return this.getJson<BenchmarksResponse>(this.url("/benchmarks", { date: opts.date }));
  }

  getRiskExposure(): Promise<RiskExposure> {
    return this.getJson<RiskExposure>(this.url("/risk/exposure"));
  }

  /** `did:pkh:…` 或裸 0x 地址。 */
  getAgentVerification(didOrAddress: string): Promise<AgentVerificationResponse> {
    return this.getJson<AgentVerificationResponse>(
      this.url(`/agent/${encodeURIComponent(didOrAddress)}/verification`),
    );
  }

  // ── 付費端點 ───────────────────────────────────────────────────────────────

  /** GET /signals/{trader}（0.01 USDC）。 */
  getSignal(trader: string): Promise<PaidResult<TraderPerformance>> {
    if (!isAddress(trader)) throw new TypeError(`trader 不是合法地址：${trader}`);
    return this.getPaid<TraderPerformance>(this.url(`/signals/${getAddress(trader)}`));
  }

  /** GET /oracle/{asset}（0.005 USDC）。asset 分大小寫（sBTC）。 */
  getOracleSnapshot(asset: string): Promise<PaidResult<OracleSnapshot>> {
    return this.getPaid<OracleSnapshot>(this.url(`/oracle/${encodeURIComponent(asset)}`));
  }

  // ── 內部 ───────────────────────────────────────────────────────────────────

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** 單次 HTTP GET（有逾時）。網路錯誤／逾時丟 SignalApiNetworkError／SignalApiTimeoutError。 */
  private async once(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: ac.signal,
      });
      const text = await res.text();
      let body: unknown = text;
      if ((res.headers.get("content-type") ?? "").includes("json") || /^\s*[{[]/.test(text)) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, headers: res.headers, body, text };
    } catch (err) {
      if (ac.signal.aborted) throw new SignalApiTimeoutError(url, this.timeoutMs);
      throw new SignalApiNetworkError(url, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
    return Math.round(exp * (0.5 + this.random() / 2));
  }

  /**
   * 沒帶付款的 GET，冪等，可重試。回傳最後一個回應（含非 2xx，由呼叫端決定如何處理）；
   * 重試用盡仍是網路錯誤／逾時則丟出。
   */
  private async getWithRetry(url: string): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retry.retries;
      let res: RawResponse;
      try {
        res = await this.once(url);
      } catch (err) {
        if (last) throw err;
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (res.status < 400 || res.status === 402 || last) return res;
      if (!RETRYABLE_STATUS.has(res.status) || NON_RETRYABLE_CODES.has(codeOf(res.body) ?? "")) return res;
      if (res.status === 429) {
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        if (ra !== null && ra > this.retry.maxRetryAfterSec) return res;
        await this.sleep(ra !== null ? ra * 1000 : this.backoff(attempt));
        continue;
      }
      await this.sleep(this.backoff(attempt));
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.getWithRetry(url);
    if (res.status >= 400) throw toSignalApiError(res, url);
    return res.body as T;
  }

  private selectRequirements(body: X402PaymentRequiredBody): PaymentRequirements {
    const accepts = Array.isArray(body?.accepts) ? body.accepts : [];
    const candidates = accepts.filter(
      (r) =>
        r?.scheme === "exact" &&
        r.network === this.expectedNetwork &&
        typeof r.asset === "string" &&
        r.asset.toLowerCase() === this.expectedAsset &&
        typeof r.payTo === "string" &&
        isAddress(r.payTo) &&
        (!this.payToAllowlist || this.payToAllowlist.has(r.payTo.toLowerCase())) &&
        /^\d+$/.test(String(r.maxAmountRequired)),
    );
    if (candidates.length === 0) {
      throw new PaymentRejectedError(
        `402 沒有符合條件的付款要求（需要 scheme=exact、network=${this.expectedNetwork}、asset=${this.expectedAsset}` +
          `${this.payToAllowlist ? "、payTo 在白名單內" : ""}）`,
        accepts,
      );
    }
    // 多個符合時取最便宜的。
    return candidates.reduce((a, b) => (BigInt(b.maxAmountRequired) < BigInt(a.maxAmountRequired) ? b : a));
  }

  private async getPaid<T>(url: string): Promise<PaidResult<T>> {
    // 1) 沒帶付款的探測：付款前的守門錯誤（400／payto_unsafe／price_stale）在這一步就會丟出。
    const first = await this.getWithRetry(url);
    if (first.status < 400) return { body: first.body as PaidEnvelope<T>, payment: null };
    if (first.status !== 402) throw toSignalApiError(first, url);
    if (!this.payment) throw toSignalApiError(first, url);

    // 2) 檢查付款要求與上限（都在簽署之前）。
    const body402 = first.body as X402PaymentRequiredBody;
    const req = this.selectRequirements(body402);
    const required = BigInt(req.maxAmountRequired);
    if (required > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: required, limitAtomic: this.maxPaymentAtomic, kind: "per-request" });
    }
    if (this.spent + required > this.maxTotalSpendAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: this.spent + required, limitAtomic: this.maxTotalSpendAtomic, kind: "total" });
    }

    // 3) 呼叫端簽署。
    const header = await this.payment.createPaymentHeader({
      requirements: req,
      x402Version: typeof body402.x402Version === "number" ? body402.x402Version : 1,
      maxValueAtomic: this.maxPaymentAtomic,
      resource: url,
    });
    // 縱深防禦：實際簽出的金額不得超過要求與上限（簽署端被換掉或有 bug 時擋下，不送出）。
    const signed = paymentValueFromHeader(header);
    if (signed === null) {
      throw new PaymentRejectedError("payment client 回傳的 X-PAYMENT 無法解析出 authorization.value", [req]);
    }
    if (signed > required || signed > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({
        requiredAtomic: signed,
        limitAtomic: required < this.maxPaymentAtomic ? required : this.maxPaymentAtomic,
        kind: "per-request",
      });
    }

    // 4) 送出付款請求 —— 只送一次，永不重試。
    let paid: RawResponse;
    try {
      paid = await this.once(url, { "X-PAYMENT": header });
    } catch (err) {
      throw new PaymentOutcomeUnknownError({ url, signedAtomic: signed, cause: err });
    }
    const settlementHeader = paid.headers.get("x-payment-response");
    // 與 agent 的 meteredFetch 相同：有結算證明或成功狀態就記帳（寧可高估）。
    if (settlementHeader || paid.status < 400) this.spent += signed;
    if (paid.status >= 400) throw toSignalApiError(paid, url, true);
    return {
      body: paid.body as PaidEnvelope<T>,
      payment: {
        paidAtomic: signed,
        paidUsdc: formatUsdcAtomic(signed),
        payTo: req.payTo,
        network: req.network,
        asset: req.asset,
        settlement: decodeSettlement(settlementHeader),
      },
    };
  }
}
