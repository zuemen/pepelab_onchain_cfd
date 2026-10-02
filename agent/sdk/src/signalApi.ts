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
//   • 記帳（審查 H1）：累計上限在呼叫簽署端**之前**以「預留」方式檢查（檢查與預留之間沒有 await，
//     並行請求不會同時通過）；只有確定沒送出（簽署失敗、簽署逾時、簽出內容不符）才回滾。一旦送出 X-PAYMENT，
//     不論 2xx／4xx／5xx／逾時都保留記帳，沒有結算證明的另記在 unsettledAtomic()。
//     預留以付款要求的 maxAmountRequired 計（簽署前不知道實際金額），簽出較少時才調整為實際金額 ——
//     保守：接近累計上限時，可能因預留以 maxAmountRequired 計而被擋下（#203 L-c）。
//   • 簽署逾時（#203 L-a，選用）：paymentSignTimeoutMs 內簽署端沒回應 → 視為「未送出」、回滾預留、
//     丟 PaymentSignTimeoutError；之後才回來的簽章一律丟棄，**絕不送出**。
//   • 對帳釋放（#203 Info）：releaseUnsettled() 只減少 unsettledAtomic()，**不會**減少 spentAtomic()，
//     所以不能拿來繞過累計上限。
//   • 簽出內容檢查（審查 M1）：authorization.to == payTo、scheme、network、x402Version、value、
//     validBefore ≤ now + maxTimeoutSeconds + 60s；maxTimeoutSeconds 必須是 1–300 的整數。
//   • 付費端點在發出 402 之前的守門錯誤（400、503 payto_unsafe、503 price_stale）一律
//     在「簽任何東西之前」就以型別化錯誤丟出。
//   • x402 v2（docs/ADR-010-x402-v2-migration.md）：伺服器以 X402_PROTOCOL 決定收 v1、v2 或兩者。
//     v2 的付款要求在 402 的 `PAYMENT-REQUIRED` header、付款用 `PAYMENT-SIGNATURE`、結算證明是
//     `PAYMENT-RESPONSE`（**結算失敗的 402 也會帶，要看 success**）。上面每一條規則在 v2 完全相同：
//     預留、逐欄核對（accepted 必須等於挑選的付款要求、authorization.to = payTo、金額、validBefore）、
//     只送一次、paymentSent、unsettled。v2 另外只接受 exact／EIP-3009／authorization flow ——
//     Permit2（extra.assetTransferMethod）、upfront／escrow（extra.paymentFlow）一律不簽。
//     `x402Protocol: "auto"`（預設）：伺服器有宣告 v2 且簽署端有 createPaymentSignature → v2，否則 v1。
//   • payment-identifier（v2，選用）：**預設不送**。呼叫端以 `paymentId` 指定時才填入
//     PaymentPayload.extensions（id 不在簽章範圍內，由 SDK 在簽署端回傳之後填入），回傳在
//     PaymentReceipt.paymentId／PaymentOutcomeUnknownError.paymentId，供對帳。signal-api 只把它當
//     中繼資料記錄，**不保證以 id 去重**：每一張結算成功的授權都是一筆獨立的付款。
import { getAddress, isAddress } from "viem";

import { OFFICIAL_BASE_SEPOLIA_USDC } from "../../shared/src/env.ts";
import {
  formatUsdcAtomic,
  parseUsdcAtomic,
  X402_DEFAULT_MAX_PAYMENT_USDC,
  X402_DEFAULT_MAX_TOTAL_SPEND_USDC,
} from "../../shared/src/x402Client.ts";
import {
  PaymentLimitExceededError,
  PaymentOutcomeUnknownError,
  PaymentRejectedError,
  PaymentRequiredError,
  PaymentSignTimeoutError,
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
  PaymentRequirementsV2,
  PayToUnsafeBody,
  PriceStaleBody,
  Revenue,
  RiskExposure,
  TraderPerformance,
  X402PaymentRequiredBody,
  X402PaymentRequiredV2,
  X402SettlementResponse,
} from "./signalApiTypes.ts";

/**
 * openapi.yaml 列出的測試網部署。**這是 Vercel 的分支網域，不是穩定網域**，所以 SDK 不拿它當預設值；
 * `baseUrl` 必填。只在測試或明確知道自己要打這個部署時使用。
 */
export const SIGNAL_API_TESTNET_URL = "https://agent-git-master-zuemens-projects.vercel.app";
export const DEFAULT_X402_NETWORK = "base-sepolia";
/** x402 v1 的網路名稱 ↔ v2 的 CAIP-2。 */
export const X402_NETWORK_CAIP2: Readonly<Record<string, string>> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};
/** x402 v2 的 payment-identifier 擴充（client 自選的付款 id）。 */
export const PAYMENT_IDENTIFIER = "payment-identifier";
const PAYMENT_ID_RE = new RegExp("^[a-zA-Z0-9_-]{16,128}$");

/** payment-identifier 的 id 格式：16–128 個字元，只含英數、底線、連字號。 */
export function isValidPaymentId(id: unknown): id is string {
  return typeof id === "string" && PAYMENT_ID_RE.test(id);
}

/** 產生一個 payment-identifier（`pay_` + 32 個十六進位字元）。SDK 不會自動呼叫；需要時由呼叫端產生後傳入。 */
export function generatePaymentId(): string {
  return `pay_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}
/** 付款要求的 maxTimeoutSeconds 上限（秒）。x402 client 以 validBefore = now + maxTimeoutSeconds 簽署。 */
export const MAX_PAYMENT_TIMEOUT_SEC = 300;
/** 檢查簽出授權的 validBefore 時容忍的時鐘誤差（秒）。 */
export const PAYMENT_VALIDITY_SKEW_SEC = 60;
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
    /**
     * 只有設定 paymentSignTimeoutMs 時才會提供：逾時後 abort。實作端可以據此取消簽署；
     * 就算不理會，逾時後回傳的簽章 SDK 也一律丟棄、不送出。
     */
    signal?: AbortSignal;
  }): Promise<string>;
}

/**
 * x402 **v2** 的付款簽署端。SDK 把「已通過檢查的一筆 v2 付款要求」交給它，它回傳
 * `PAYMENT-SIGNATURE` 標頭值（base64 編碼的 PaymentPayload）。私鑰只存在於它的實作裡。
 *
 * 典型實作（@x402/core、@x402/evm 2.x）：
 *   import { x402Client } from "@x402/core/client";
 *   import { encodePaymentSignatureHeader } from "@x402/core/http";
 *   import { ExactEvmScheme } from "@x402/evm/exact/client";
 *   const core = new x402Client().register("eip155:84532", new ExactEvmScheme(guardedAccount));
 *   const payment = { createPaymentSignature: async ({ paymentRequired, requirements }) =>
 *     encodePaymentSignatureHeader(
 *       await core.createPaymentPayload({ ...paymentRequired, accepts: [requirements] })) };
 * （`accepts: [requirements]`：只給簽署端 SDK 挑好的那一筆，它就沒有別的可選。）
 *
 * 同一個物件可以同時實作 createPaymentHeader（v1）與 createPaymentSignature（v2）。
 */
export interface X402PaymentClientV2 {
  createPaymentSignature(args: {
    /** 伺服器的 PAYMENT-REQUIRED（完整內容，含 resource 與 extensions）。 */
    paymentRequired: X402PaymentRequiredV2;
    /** SDK 挑選並檢查過的那一筆付款要求（paymentRequired.accepts 其中之一）。 */
    requirements: PaymentRequirementsV2;
    /** SDK 已檢查 requirements.amount ≤ 這個值；實作端可再自行檢查。 */
    maxValueAtomic: bigint;
    /** 請求的完整 URL。 */
    resource: string;
    /** 只有設定 paymentSignTimeoutMs 時才會提供：逾時後 abort。 */
    signal?: AbortSignal;
  }): Promise<string>;
}

/** 付費端點的選項。 */
export interface PaidRequestOptions {
  /**
   * x402 v2 的 payment-identifier（選用，16–128 個字元，英數、底線、連字號）。
   * **省略時不送**（SDK 不自動產生）；指定時填入 PaymentPayload.extensions，v1 沒有這個概念（忽略）。
   * 用途是對帳：回傳在 PaymentReceipt.paymentId／PaymentOutcomeUnknownError.paymentId。
   * signal-api 只把它當中繼資料記錄，**不保證以 id 去重**——帶同一個 id 重送仍會簽一張新的授權，
   * 結算成功就是另一筆付款。
   */
  paymentId?: string;
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
  /** 必填。沒有穩定的正式網域之前，SDK 不替你選部署（見 SIGNAL_API_TESTNET_URL）。 */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** 每個 HTTP 請求的逾時（ms）。預設 15000。 */
  timeoutMs?: number;
  retry?: RetryOptions;
  /**
   * 付費端點用；不提供時付費端點會丟 PaymentRequiredError（不付款）。
   * v1（createPaymentHeader）、v2（createPaymentSignature）擇一或兩者都實作。
   */
  payment?: X402PaymentClient | X402PaymentClientV2 | (X402PaymentClient & X402PaymentClientV2);
  /**
   * 使用哪個 x402 協定版本。預設 "auto"：伺服器的 402 有宣告 v2（PAYMENT-REQUIRED header）且
   * 簽署端有 createPaymentSignature → v2；否則 v1。"v1"／"v2" = 只用該版本，不符就丟 PaymentRejectedError。
   */
  x402Protocol?: "auto" | "v1" | "v2";
  /** 單筆上限（USDC 6 位小數原始值）。預設 20000（0.02 USDC）。必須 > 0。 */
  maxPaymentAtomic?: bigint;
  /**
   * 此 client 的累計上限。預設 1_000000（1 USDC）。必須 > 0。
   * 每筆付款在簽署前以付款要求的 `maxAmountRequired` 預留（簽出較少時才調整為實際金額），
   * 所以接近上限時可能被擋下，即使實際會簽出較少（保守設計）。
   */
  maxTotalSpendAtomic?: bigint;
  /**
   * 選用：簽署端（payment.createPaymentHeader）的逾時（ms，正整數）。逾時視為「未送出」：
   * 回滾預留、丟 PaymentSignTimeoutError；之後才回來的簽章一律丟棄、不送出。
   * 不設定時無限等待（簽署端懸置會讓該筆預留一直佔住累計額度）。
   */
  paymentSignTimeoutMs?: number;
  /**
   * 只接受這個 x402 network。預設 base-sepolia。v1 名稱（base-sepolia）或 CAIP-2（eip155:84532）皆可，
   * SDK 會依協定版本換成對應的寫法（v1 比對名稱、v2 比對 CAIP-2）。
   * 與 expectedAsset **必須同時設定或同時省略**（換網路卻沿用 Base Sepolia 的 USDC 位址，或反之，都會丟錯）。
   */
  expectedNetwork?: string;
  /** 只接受這個結算代幣。預設 Circle 官方 Base Sepolia USDC。與 expectedNetwork 同時設定。 */
  expectedAsset?: string;
  /** 若提供，payTo 必須在清單內。 */
  payToAllowlist?: readonly string[];
  /** 測試用：可替換等待與亂數。 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** 測試用：現在時間（ms）。檢查 validBefore 用。 */
  now?: () => number;
}

export interface PaymentReceipt {
  /** 實際簽出且成立的金額（atomic）。 */
  paidAtomic: bigint;
  /** 同上，十進位字串（USDC）。 */
  paidUsdc: string;
  payTo: string;
  network: string;
  asset: string;
  /** X-PAYMENT-RESPONSE（v1）／PAYMENT-RESPONSE（v2）解碼後的內容（facilitator 結算證明）；沒有時為 null。 */
  settlement: unknown | null;
  /** 這筆付款使用的 x402 協定版本。 */
  x402Version: 1 | 2;
  /** x402 v2 的 payment-identifier（呼叫端指定或簽署端自帶的）；沒有帶、或 v1 時為 null。 */
  paymentId: string | null;
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
/**
 * 把非 2xx 回應轉成型別化錯誤。`paymentSent`（= 這個回應是帶 X-PAYMENT 的請求回來的）
 * 會帶到每一種錯誤上，讓呼叫端知道要先對帳再重送。
 */
export function toSignalApiError(res: RawResponse, url: string, paymentSent = false): SignalApiError {
  const code = codeOf(res.body);
  const retryAfterSec = parseRetryAfter(res.headers.get("retry-after"));
  if (res.status === 402) {
    return new PaymentRequiredError({
      body: res.body,
      url,
      afterPayment: paymentSent,
      paymentRequiredV2: decodePaymentRequiredHeader(res.headers.get("payment-required")),
      settlement: decodeSettlementV2(res.headers.get("payment-response")),
    });
  }
  if (res.status === 429) return new RateLimitedError({ body: res.body, url, retryAfterSec, paymentSent });
  if (res.status === 503 && code === "payto_unsafe") {
    return new PayToUnsafeError({ body: res.body as PayToUnsafeBody, url, retryAfterSec, paymentSent });
  }
  if (res.status === 503 && code === "price_stale") {
    return new PriceStaleError({ body: res.body as PriceStaleBody, url, paymentSent });
  }
  if (res.status >= 500) return new ServiceUnavailableError({ status: res.status, code, body: res.body, url, paymentSent });
  const msg = (res.body as { message?: string } | null)?.message;
  return new SignalApiError(
    `signal-api ${res.status}${code ? `（${code}）` : ""}${msg ? `：${msg}` : ""}` +
      (paymentSent ? "；已送出付款授權，先對帳再重送" : ""),
    { status: res.status, code, body: res.body, url, paymentSent },
  );
}

/** X-PAYMENT（x402 v1 exact／EVM）解碼後的欄位；格式不符回 null。 */
export interface DecodedXPayment {
  x402Version: number;
  scheme: string;
  network: string;
  authorization: { from: string; to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: string };
}

const UINT_STRING = new RegExp("^[0-9]+$");

export function decodeXPayment(header: string): DecodedXPayment | null {
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      x402Version?: unknown;
      scheme?: unknown;
      network?: unknown;
      payload?: { authorization?: Record<string, unknown> };
    };
    const a = j?.payload?.authorization;
    const int = (v: unknown) => (typeof v === "string" && UINT_STRING.test(v) ? BigInt(v) : null);
    if (!a || typeof j.x402Version !== "number" || typeof j.scheme !== "string" || typeof j.network !== "string") return null;
    const value = int(a.value);
    const validAfter = int(a.validAfter);
    const validBefore = int(a.validBefore);
    if (value === null || validAfter === null || validBefore === null) return null;
    if (typeof a.to !== "string" || !isAddress(a.to) || typeof a.from !== "string") return null;
    return {
      x402Version: j.x402Version,
      scheme: j.scheme,
      network: j.network,
      authorization: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: String(a.nonce ?? "") },
    };
  } catch {
    return null;
  }
}

function decodeBase64Object(h: string | null | undefined): Record<string, unknown> | null {
  if (!h) return null;
  try {
    const j: unknown = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return j !== null && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `PAYMENT-REQUIRED` header → v2 的 PaymentRequired；不是 v2 或格式不符回 null。 */
export function decodePaymentRequiredHeader(h: string | null | undefined): X402PaymentRequiredV2 | null {
  const j = decodeBase64Object(h);
  if (!j || j.x402Version !== 2 || !Array.isArray(j.accepts)) return null;
  return j as unknown as X402PaymentRequiredV2;
}

/** `PAYMENT-RESPONSE` header → v2 的結算回執；格式不符回 null。 */
export function decodeSettlementV2(h: string | null | undefined): X402SettlementResponse | null {
  const j = decodeBase64Object(h);
  return j && typeof j.success === "boolean" ? (j as unknown as X402SettlementResponse) : null;
}

/** PAYMENT-SIGNATURE（x402 v2 exact／EIP-3009）解碼後的欄位；格式不符回 null。 */
export interface DecodedPaymentSignature {
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  };
  authorization: { from: string; to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: string };
  /** 簽署端自己帶的 payment-identifier（合法才會出現）；沒有為 null。 */
  paymentId: string | null;
  /** 完整的 PaymentPayload（SDK 填入 payment-identifier 後重新編碼用）。 */
  raw: Record<string, unknown>;
}

export function decodePaymentSignature(header: string): DecodedPaymentSignature | null {
  const j = decodeBase64Object(header);
  if (!j || typeof j.x402Version !== "number") return null;
  const acc = j.accepted as Record<string, unknown> | undefined;
  // 只認 EIP-3009：Permit2 的 payload 是 permit2Authorization，沒有 authorization → null。
  const a = (j.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  if (!acc || typeof acc !== "object" || !a || typeof a !== "object") return null;
  const int = (v: unknown) => (typeof v === "string" && UINT_STRING.test(v) ? BigInt(v) : null);
  const value = int(a.value);
  const validAfter = int(a.validAfter);
  const validBefore = int(a.validBefore);
  if (value === null || validAfter === null || validBefore === null) return null;
  if (typeof a.to !== "string" || !isAddress(a.to) || typeof a.from !== "string" || !isAddress(a.from)) return null;
  if (
    typeof acc.scheme !== "string" ||
    typeof acc.network !== "string" ||
    typeof acc.amount !== "string" ||
    typeof acc.asset !== "string" ||
    typeof acc.payTo !== "string" ||
    typeof acc.maxTimeoutSeconds !== "number"
  ) {
    return null;
  }
  const extra = acc.extra !== null && typeof acc.extra === "object" ? (acc.extra as Record<string, unknown>) : {};
  const idRaw = ((j.extensions as Record<string, unknown> | undefined)?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined)
    ?.info?.id;
  return {
    x402Version: j.x402Version,
    accepted: {
      scheme: acc.scheme,
      network: acc.network,
      amount: acc.amount,
      asset: acc.asset,
      payTo: acc.payTo,
      maxTimeoutSeconds: acc.maxTimeoutSeconds,
      extra,
    },
    authorization: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: String(a.nonce ?? "") },
    paymentId: isValidPaymentId(idRaw) ? idRaw : null,
    raw: j,
  };
}

/** v2 付款要求是不是 SDK 願意簽的那一種：exact、EIP-3009、authorization flow。 */
function isEip3009Authorization(extra: Record<string, unknown> | undefined): boolean {
  const atm = extra?.assetTransferMethod ?? "eip3009";
  const flow = extra?.paymentFlow ?? "authorization";
  return atm === "eip3009" && flow === "authorization";
}

export class SignalApiClient {
  readonly baseUrl: string;
  readonly maxPaymentAtomic: bigint;
  readonly maxTotalSpendAtomic: bigint;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;
  private readonly payment?: Partial<X402PaymentClient & X402PaymentClientV2>;
  private readonly x402Protocol: "auto" | "v1" | "v2";
  /** v1 的網路名稱（base-sepolia）。 */
  private readonly expectedNetwork: string;
  /** v2 的 CAIP-2（eip155:84532）；設定的網路沒有已知對應時為 null（v2 付款要求一律不符）。 */
  private readonly expectedNetworkCaip2: string | null;
  private readonly expectedAsset: string;
  private readonly payToAllowlist: Set<string> | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly paymentSignTimeoutMs: number | undefined;
  /** 已承諾金額：已送出的授權 + 進行中的預留（atomic）。累計上限對它檢查。 */
  private committed = 0n;
  /** 已送出、但沒有拿到結算證明的授權（atomic）。validBefore 之前仍可能被結算。 */
  private unsettled = 0n;

  constructor(cfg: SignalApiClientConfig) {
    if (!cfg?.baseUrl || !(cfg.baseUrl.startsWith("https://") || cfg.baseUrl.startsWith("http://"))) {
      throw new Error("SignalApiClient 需要 baseUrl（http/https）；SDK 不預設部署網址");
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.retry = {
      retries: Math.max(0, cfg.retry?.retries ?? 2),
      baseDelayMs: cfg.retry?.baseDelayMs ?? 300,
      maxDelayMs: cfg.retry?.maxDelayMs ?? 5_000,
      maxRetryAfterSec: cfg.retry?.maxRetryAfterSec ?? 10,
    };
    this.payment = cfg.payment as Partial<X402PaymentClient & X402PaymentClientV2> | undefined;
    if (
      this.payment &&
      typeof this.payment.createPaymentHeader !== "function" &&
      typeof this.payment.createPaymentSignature !== "function"
    ) {
      throw new Error("payment 必須實作 createPaymentHeader（x402 v1）或 createPaymentSignature（x402 v2）至少其一");
    }
    this.x402Protocol = cfg.x402Protocol ?? "auto";
    if (!["auto", "v1", "v2"].includes(this.x402Protocol)) {
      throw new Error(`x402Protocol 必須是 auto｜v1｜v2：${String(cfg.x402Protocol)}`);
    }
    this.maxPaymentAtomic = cfg.maxPaymentAtomic ?? DEFAULT_MAX_PAYMENT_ATOMIC;
    this.maxTotalSpendAtomic = cfg.maxTotalSpendAtomic ?? DEFAULT_MAX_TOTAL_SPEND_ATOMIC;
    if (this.maxPaymentAtomic <= 0n) throw new Error("maxPaymentAtomic 必須 > 0");
    if (this.maxTotalSpendAtomic <= 0n) throw new Error("maxTotalSpendAtomic 必須 > 0");
    if (
      cfg.paymentSignTimeoutMs !== undefined &&
      !(Number.isSafeInteger(cfg.paymentSignTimeoutMs) && cfg.paymentSignTimeoutMs > 0)
    ) {
      throw new Error(`paymentSignTimeoutMs 必須是正整數（ms）：${cfg.paymentSignTimeoutMs}`);
    }
    this.paymentSignTimeoutMs = cfg.paymentSignTimeoutMs;
    if ((cfg.expectedNetwork === undefined) !== (cfg.expectedAsset === undefined)) {
      throw new Error("expectedNetwork 與 expectedAsset 必須同時設定（或同時省略以使用 Base Sepolia 官方 USDC）");
    }
    if (cfg.expectedAsset !== undefined && !isAddress(cfg.expectedAsset)) {
      throw new Error(`expectedAsset 不是合法地址：${cfg.expectedAsset}`);
    }
    const net = cfg.expectedNetwork ?? DEFAULT_X402_NETWORK;
    if (net.includes(":")) {
      // 以 CAIP-2 設定：v1 比對時換回名稱（沒有已知名稱就維持原值，v1 付款要求一律不符）。
      this.expectedNetworkCaip2 = net;
      this.expectedNetwork = Object.entries(X402_NETWORK_CAIP2).find(([, c]) => c === net)?.[0] ?? net;
    } else {
      this.expectedNetwork = net;
      this.expectedNetworkCaip2 = X402_NETWORK_CAIP2[net] ?? null;
    }
    this.expectedAsset = (cfg.expectedAsset ?? OFFICIAL_BASE_SEPOLIA_USDC).toLowerCase();
    this.payToAllowlist = cfg.payToAllowlist
      ? new Set(cfg.payToAllowlist.map((a) => {
          if (!isAddress(a)) throw new Error(`payToAllowlist 含非法地址：${a}`);
          return a.toLowerCase();
        }))
      : null;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = cfg.random ?? Math.random;
    this.now = cfg.now ?? Date.now;
  }

  /**
   * 已承諾金額（atomic）＝ 所有已送出的付款授權（不論結果）＋ 進行中請求的預留。
   * 保守計算：寧可高估。累計上限 maxTotalSpendAtomic 對這個數字檢查。
   */
  spentAtomic(): bigint {
    return this.committed;
  }

  /** 已送出但沒有取得結算證明（X-PAYMENT-RESPONSE）的金額（atomic）。需要對帳。 */
  unsettledAtomic(): bigint {
    return this.unsettled;
  }

  /**
   * 對帳後釋放：呼叫端以 facilitator／鏈上 USDC 轉帳紀錄確認某些「未結算」授權的結果
   * （已結算，或 validBefore 已過且確定沒被結算）之後，把那部分從 unsettledAtomic() 移除。
   *
   * **只減少 unsettledAtomic()，不會減少 spentAtomic()**：授權已經送出過，累計上限照算，
   * 這個 API 不能用來騰出額度。要重新取得額度，請建立新的 client（並在簽署端另做跨實例總額控管）。
   *
   * @param amountAtomic 要釋放的金額（atomic，> 0，且 ≤ 目前的 unsettledAtomic()）。
   * @returns 釋放後的 unsettledAtomic()。
   */
  releaseUnsettled(amountAtomic: bigint): bigint {
    if (typeof amountAtomic !== "bigint" || amountAtomic <= 0n) {
      throw new RangeError(`releaseUnsettled：金額必須是 > 0 的 bigint（收到 ${String(amountAtomic)}）`);
    }
    if (amountAtomic > this.unsettled) {
      throw new RangeError(`releaseUnsettled：${amountAtomic} 超過目前未結算金額 ${this.unsettled}`);
    }
    this.unsettled -= amountAtomic;
    return this.unsettled;
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
  getSignal(trader: string, opts: PaidRequestOptions = {}): Promise<PaidResult<TraderPerformance>> {
    if (!isAddress(trader)) throw new TypeError(`trader 不是合法地址：${trader}`);
    return this.getPaid<TraderPerformance>(this.url(`/signals/${getAddress(trader)}`), opts);
  }

  /** GET /oracle/{asset}（0.005 USDC）。asset 分大小寫（sBTC）。 */
  getOracleSnapshot(asset: string, opts: PaidRequestOptions = {}): Promise<PaidResult<OracleSnapshot>> {
    return this.getPaid<OracleSnapshot>(this.url(`/oracle/${encodeURIComponent(asset)}`), opts);
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
        /^\d+$/.test(String(r.maxAmountRequired)) &&
        // x402 client 以 validBefore = now + maxTimeoutSeconds 簽署：不接受超長的授權有效期。
        Number.isInteger(r.maxTimeoutSeconds) &&
        r.maxTimeoutSeconds > 0 &&
        r.maxTimeoutSeconds <= MAX_PAYMENT_TIMEOUT_SEC,
    );
    if (candidates.length === 0) {
      throw new PaymentRejectedError(
        `402 沒有符合條件的付款要求（需要 scheme=exact、network=${this.expectedNetwork}、asset=${this.expectedAsset}、` +
          `0 < maxTimeoutSeconds ≤ ${MAX_PAYMENT_TIMEOUT_SEC}${this.payToAllowlist ? "、payTo 在白名單內" : ""}）`,
        accepts,
      );
    }
    // 多個符合時取最便宜的。
    return candidates.reduce((a, b) => (BigInt(b.maxAmountRequired) < BigInt(a.maxAmountRequired) ? b : a));
  }

  /**
   * 簽出的 X-PAYMENT 必須與挑選的付款要求一致，否則不送出（簽署端被換掉、有 bug、或被誘導簽給別人）。
   * 回傳實際簽出的金額。
   */
  private checkSignedPayment(header: string, req: PaymentRequirements, x402Version: number, required: bigint): bigint {
    const d = decodeXPayment(header);
    if (!d) throw new PaymentRejectedError("payment client 回傳的 X-PAYMENT 無法解析（需要 x402 v1 exact／EVM 格式）", [req]);
    const reject = (why: string) => {
      throw new PaymentRejectedError(`簽出的 X-PAYMENT 與付款要求不符：${why}`, [req]);
    };
    if (d.x402Version !== x402Version) reject(`x402Version ${d.x402Version} ≠ ${x402Version}`);
    if (d.scheme !== "exact") reject(`scheme ${d.scheme} ≠ exact`);
    if (d.network !== this.expectedNetwork || d.network !== req.network) reject(`network ${d.network} ≠ ${this.expectedNetwork}`);
    if (d.authorization.to.toLowerCase() !== req.payTo.toLowerCase()) {
      reject(`收款人 authorization.to ${d.authorization.to} ≠ payTo ${req.payTo}`);
    }
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    const latest = nowSec + BigInt(req.maxTimeoutSeconds) + BigInt(PAYMENT_VALIDITY_SKEW_SEC);
    if (d.authorization.validBefore > latest) {
      reject(`validBefore ${d.authorization.validBefore} 超過 now + maxTimeoutSeconds + ${PAYMENT_VALIDITY_SKEW_SEC}s（${latest}）`);
    }
    const signed = d.authorization.value;
    if (signed > required || signed > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({
        requiredAtomic: signed,
        limitAtomic: required < this.maxPaymentAtomic ? required : this.maxPaymentAtomic,
        kind: "per-request",
      });
    }
    return signed;
  }

  /**
   * 呼叫簽署端；設定了 paymentSignTimeoutMs 時加上逾時。逾時後 race 已經以 PaymentSignTimeoutError
   * 結束，簽署端之後才回傳的簽章沒有任何參照會拿到它 → 被丟棄，不可能被送出。
   */
  private async sign(resource: string, call: (signal?: AbortSignal) => Promise<string>): Promise<string> {
    const timeoutMs = this.paymentSignTimeoutMs;
    if (timeoutMs === undefined) return call();
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signing = Promise.resolve().then(() => call(ac.signal));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new PaymentSignTimeoutError({ url: resource, timeoutMs }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([signing, timeout]);
    } finally {
      clearTimeout(timer);
      signing.catch(() => {}); // 逾時後簽署端才失敗：不要變成 unhandled rejection
    }
  }

  private async getPaid<T>(url: string, opts: PaidRequestOptions = {}): Promise<PaidResult<T>> {
    if (opts.paymentId !== undefined && !isValidPaymentId(opts.paymentId)) {
      throw new TypeError("paymentId 必須是 16–128 個字元，只含英數、底線與連字號");
    }
    // 1) 沒帶付款的探測：付款前的守門錯誤（400／payto_unsafe／price_stale）在這一步就會丟出。
    const first = await this.getWithRetry(url);
    if (first.status < 400) return { body: first.body as PaidEnvelope<T>, payment: null };
    if (first.status !== 402) throw toSignalApiError(first, url);
    if (!this.payment) throw toSignalApiError(first, url);

    // 2) 依伺服器宣告與簽署端能力決定協定版本。
    const requiredV2 = decodePaymentRequiredHeader(first.headers.get("payment-required"));
    const body402 = first.body as X402PaymentRequiredBody;
    const offersV1 = Array.isArray(body402?.accepts);
    const canV1 = typeof this.payment.createPaymentHeader === "function";
    const canV2 = typeof this.payment.createPaymentSignature === "function";
    const want = this.x402Protocol;
    if (want !== "v1" && requiredV2 && canV2) return this.payV2<T>(url, requiredV2, opts);
    if (want === "v2") {
      throw new PaymentRejectedError(
        !canV2
          ? "x402Protocol 設為 v2，但 payment client 沒有 createPaymentSignature"
          : "x402Protocol 設為 v2，但伺服器的 402 沒有 PAYMENT-REQUIRED header（只提供 v1）",
        offersV1 ? body402.accepts : [],
      );
    }
    if (!canV1) {
      // 簽署端只會 v2，而這個 402 沒有（合法的）v2 付款要求。
      throw new PaymentRejectedError(
        "伺服器的 402 沒有 x402 v2 的付款要求（PAYMENT-REQUIRED header），而 payment client 只實作了 v2",
        offersV1 ? body402.accepts : [],
      );
    }
    if (want === "auto" && !offersV1 && requiredV2) {
      throw new PaymentRejectedError(
        "伺服器只提供 x402 v2 的付款要求，而 payment client 只實作了 v1（createPaymentHeader）",
        requiredV2.accepts,
      );
    }
    return this.payV1<T>(url, body402);
  }

  /** x402 v1：X-PAYMENT／X-PAYMENT-RESPONSE。 */
  private async payV1<T>(url: string, body402: X402PaymentRequiredBody): Promise<PaidResult<T>> {
    const payment = this.payment as X402PaymentClient;
    // 2) 檢查付款要求與單筆上限。
    const req = this.selectRequirements(body402);
    const x402Version = typeof body402.x402Version === "number" ? body402.x402Version : 1;
    const required = BigInt(req.maxAmountRequired);
    if (required > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: required, limitAtomic: this.maxPaymentAtomic, kind: "per-request" });
    }

    // 3) 累計上限：檢查與預留之間沒有 await（JS 單執行緒 → 並行請求不會同時通過）。
    if (this.committed + required > this.maxTotalSpendAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: this.committed + required, limitAtomic: this.maxTotalSpendAtomic, kind: "total" });
    }
    this.committed += required;

    // 4) 呼叫端簽署並檢查。這一段失敗（含簽署逾時）= 授權沒有送出 → 回滾預留。
    let header: string;
    let signed: bigint;
    try {
      header = await this.sign(url, (signal) =>
        payment.createPaymentHeader({
          requirements: req,
          x402Version,
          maxValueAtomic: this.maxPaymentAtomic,
          resource: url,
          ...(signal ? { signal } : {}),
        }),
      );
      signed = this.checkSignedPayment(header, req, x402Version, required);
    } catch (err) {
      this.committed -= required;
      throw err;
    }
    this.committed -= required - signed; // 預留調整為實際簽出的金額（≤ required）

    // 5) 送出付款請求 —— 只送一次，永不重試。從這裡開始不論結果都保留記帳：
    //    授權已交出，validBefore 之前都可能被結算。
    let paid: RawResponse;
    try {
      paid = await this.once(url, { "X-PAYMENT": header });
    } catch (err) {
      this.unsettled += signed;
      throw new PaymentOutcomeUnknownError({ url, signedAtomic: signed, cause: err });
    }
    const settlementHeader = paid.headers.get("x-payment-response");
    if (!settlementHeader) this.unsettled += signed;
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
        x402Version: 1,
        paymentId: null,
      },
    };
  }

  // ── x402 v2 ────────────────────────────────────────────────────────────────

  private selectRequirementsV2(pr: X402PaymentRequiredV2): PaymentRequirementsV2 {
    const accepts = Array.isArray(pr.accepts) ? pr.accepts : [];
    const candidates = accepts.filter(
      (r) =>
        r?.scheme === "exact" &&
        this.expectedNetworkCaip2 !== null &&
        r.network === this.expectedNetworkCaip2 &&
        typeof r.asset === "string" &&
        r.asset.toLowerCase() === this.expectedAsset &&
        typeof r.payTo === "string" &&
        isAddress(r.payTo) &&
        (!this.payToAllowlist || this.payToAllowlist.has(r.payTo.toLowerCase())) &&
        typeof r.amount === "string" &&
        UINT_STRING.test(r.amount) &&
        Number.isInteger(r.maxTimeoutSeconds) &&
        r.maxTimeoutSeconds > 0 &&
        r.maxTimeoutSeconds <= MAX_PAYMENT_TIMEOUT_SEC &&
        // 只簽 EIP-3009 的事後結算：Permit2、upfront／escrow（先結算再給資料）一律不接受。
        isEip3009Authorization(r.extra),
    );
    if (candidates.length === 0) {
      throw new PaymentRejectedError(
        `402（x402 v2）沒有符合條件的付款要求（需要 scheme=exact、network=${this.expectedNetworkCaip2 ?? `${this.expectedNetwork}（沒有對應的 CAIP-2）`}、` +
          `asset=${this.expectedAsset}、0 < maxTimeoutSeconds ≤ ${MAX_PAYMENT_TIMEOUT_SEC}、EIP-3009／authorization flow` +
          `${this.payToAllowlist ? "、payTo 在白名單內" : ""}）`,
        accepts,
      );
    }
    return candidates.reduce((a, b) => (BigInt(b.amount) < BigInt(a.amount) ? b : a));
  }

  /**
   * 簽出的 PAYMENT-SIGNATURE 必須與挑選的付款要求一致，否則不送出。與 v1 的 checkSignedPayment 逐項對應，
   * 另外核對 `accepted`（v2 的 PaymentPayload 會回帶付款要求；伺服器要求它與宣告的完全相同）。
   * 回傳實際簽出的金額與解碼結果。
   */
  private checkSignedPaymentV2(header: string, req: PaymentRequirementsV2, required: bigint): { signed: bigint; decoded: DecodedPaymentSignature } {
    const d = decodePaymentSignature(header);
    if (!d) {
      throw new PaymentRejectedError("payment client 回傳的 PAYMENT-SIGNATURE 無法解析（需要 x402 v2 exact／EIP-3009 格式）", [req]);
    }
    const reject = (why: string) => {
      throw new PaymentRejectedError(`簽出的 PAYMENT-SIGNATURE 與付款要求不符：${why}`, [req]);
    };
    if (d.x402Version !== 2) reject(`x402Version ${d.x402Version} ≠ 2`);
    if (d.accepted.scheme !== "exact") reject(`scheme ${d.accepted.scheme} ≠ exact`);
    if (d.accepted.network !== this.expectedNetworkCaip2 || d.accepted.network !== req.network) {
      reject(`network ${d.accepted.network} ≠ ${this.expectedNetworkCaip2}`);
    }
    if (d.accepted.asset.toLowerCase() !== req.asset.toLowerCase()) reject(`asset ${d.accepted.asset} ≠ ${req.asset}`);
    if (d.accepted.payTo.toLowerCase() !== req.payTo.toLowerCase()) reject(`accepted.payTo ${d.accepted.payTo} ≠ payTo ${req.payTo}`);
    if (d.accepted.amount !== req.amount) reject(`accepted.amount ${d.accepted.amount} ≠ ${req.amount}`);
    if (d.accepted.maxTimeoutSeconds !== req.maxTimeoutSeconds) {
      reject(`accepted.maxTimeoutSeconds ${d.accepted.maxTimeoutSeconds} ≠ ${req.maxTimeoutSeconds}`);
    }
    if (!isEip3009Authorization(d.accepted.extra)) reject("accepted.extra 宣告了 EIP-3009／authorization 以外的付款方式");
    if (d.authorization.to.toLowerCase() !== req.payTo.toLowerCase()) {
      reject(`收款人 authorization.to ${d.authorization.to} ≠ payTo ${req.payTo}`);
    }
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    const latest = nowSec + BigInt(req.maxTimeoutSeconds) + BigInt(PAYMENT_VALIDITY_SKEW_SEC);
    if (d.authorization.validBefore > latest) {
      reject(`validBefore ${d.authorization.validBefore} 超過 now + maxTimeoutSeconds + ${PAYMENT_VALIDITY_SKEW_SEC}s（${latest}）`);
    }
    const signed = d.authorization.value;
    if (signed > required || signed > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({
        requiredAtomic: signed,
        limitAtomic: required < this.maxPaymentAtomic ? required : this.maxPaymentAtomic,
        kind: "per-request",
      });
    }
    return { signed, decoded: d };
  }

  /** x402 v2：PAYMENT-REQUIRED／PAYMENT-SIGNATURE／PAYMENT-RESPONSE。步驟與 payV1 逐一對應。 */
  private async payV2<T>(url: string, pr: X402PaymentRequiredV2, opts: PaidRequestOptions): Promise<PaidResult<T>> {
    const payment = this.payment as X402PaymentClientV2;
    // 2) 檢查付款要求與單筆上限。
    const req = this.selectRequirementsV2(pr);
    const required = BigInt(req.amount);
    if (required > this.maxPaymentAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: required, limitAtomic: this.maxPaymentAtomic, kind: "per-request" });
    }

    // 3) 累計上限：檢查與預留之間沒有 await。
    if (this.committed + required > this.maxTotalSpendAtomic) {
      throw new PaymentLimitExceededError({ requiredAtomic: this.committed + required, limitAtomic: this.maxTotalSpendAtomic, kind: "total" });
    }
    this.committed += required;

    // 4) 呼叫端簽署並檢查。這一段失敗（含簽署逾時）= 授權沒有送出 → 回滾預留。
    let header: string;
    let signed: bigint;
    let paymentId: string | null = null;
    try {
      const raw = await this.sign(url, (signal) =>
        payment.createPaymentSignature({
          paymentRequired: pr,
          requirements: req,
          maxValueAtomic: this.maxPaymentAtomic,
          resource: url,
          ...(signal ? { signal } : {}),
        }),
      );
      const checked = this.checkSignedPaymentV2(raw, req, required);
      signed = checked.signed;
      header = raw;
      // payment-identifier：預設不送，只有呼叫端指定才填入（簽署端自己帶的原樣保留）。id 不在 EIP-712
      // 簽章範圍內（簽章只涵蓋 authorization），所以由 SDK 在這裡填入並重新編碼。伺服器有宣告這個擴充
      // 時保留宣告的其他欄位（照規格回顯）。
      paymentId = checked.decoded.paymentId;
      if (opts.paymentId !== undefined) {
        paymentId = opts.paymentId;
        const declared = pr.extensions?.[PAYMENT_IDENTIFIER];
        const d = (declared !== null && typeof declared === "object" ? declared : {}) as { info?: Record<string, unknown> };
        const extensions = {
          ...((checked.decoded.raw.extensions as Record<string, unknown> | undefined) ?? {}),
          [PAYMENT_IDENTIFIER]: { ...d, info: { ...(d.info ?? {}), id: paymentId } },
        };
        header = Buffer.from(JSON.stringify({ ...checked.decoded.raw, extensions })).toString("base64");
      }
    } catch (err) {
      this.committed -= required;
      throw err;
    }
    this.committed -= required - signed; // 預留調整為實際簽出的金額（≤ required）

    // 5) 送出付款請求 —— 只送一次，永不重試。從這裡開始不論結果都保留記帳。
    let paid: RawResponse;
    try {
      paid = await this.once(url, { "PAYMENT-SIGNATURE": header });
    } catch (err) {
      this.unsettled += signed;
      throw new PaymentOutcomeUnknownError({ url, signedAtomic: signed, cause: err, paymentId });
    }
    // v2 的 PAYMENT-RESPONSE 在結算失敗時也會出現：只有 success === true 才是結算證明。
    const settlement = decodeSettlementV2(paid.headers.get("payment-response"));
    if (settlement?.success !== true) this.unsettled += signed;
    if (paid.status >= 400) throw toSignalApiError(paid, url, true);
    return {
      body: paid.body as PaidEnvelope<T>,
      payment: {
        paidAtomic: signed,
        paidUsdc: formatUsdcAtomic(signed),
        payTo: req.payTo,
        network: req.network,
        asset: req.asset,
        settlement,
        x402Version: 2,
        paymentId,
      },
    };
  }
}
