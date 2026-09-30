// signal-api 回應型別。以 docs/api/openapi.yaml 為準手寫，並由 test/openapi-schema.test.ts
// 比對：每個 schema 的「欄位集合」與「必填集合」都必須與 openapi.yaml 完全相同。
//
// OracleSnapshot / TraderPerformance / AgentVerification 直接重用 agent/shared 的型別
// （type-only import，不會在執行期載入 shared）—— 伺服器就是用那幾個型別產生回應的。
import type { OracleSnapshot, TraderPerformance } from "../../shared/src/aggregate.ts";
import type { AgentVerification } from "../../shared/src/verification.ts";

export type { OracleSnapshot, TraderPerformance, AgentVerification };

// ── 通用錯誤本文 ─────────────────────────────────────────────────────────────

export interface ErrorBodyKnown {
  ok: false;
  /** 原因代碼（例如 payto_unsafe、trader_not_registered）或說明。 */
  error: string;
  message?: string;
  note?: string;
  known?: string[];
}

/** openapi 的 Error：additionalProperties: true。 */
export type ErrorBody = ErrorBodyKnown & { [extra: string]: unknown };

export interface PayToUnsafeBody {
  ok: false;
  error: "payto_unsafe";
  reason: string;
  payTo: string;
  note?: string;
}

export interface PriceStaleBody {
  ok: false;
  error: "price_stale";
  message?: string;
  asset: string;
  ageSec: number;
  maxPriceAgeSec: number;
}

export interface FacilitatorErrorBody {
  ok: false;
  error: "facilitator_rate_limited" | "facilitator_unavailable";
  message?: string;
  note: string;
  facilitator: string;
}

// ── x402 ─────────────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  /** 結算代幣最小單位（官方 USDC 6 位小數）的整數字串。 */
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequiredBody {
  error: unknown;
  accepts: PaymentRequirements[];
  payer?: string;
  x402Version: 1;
}

export interface PaidEnvelope<T> {
  ok: true;
  /** true = 分潤已排入結算佇列，**不代表已上鏈**。 */
  settled: boolean;
  settleError?: string;
  data: T;
}

// ── 免費端點 ─────────────────────────────────────────────────────────────────

export interface Discovery {
  service: "pepelab-signal-api";
  discoverable?: boolean;
  description?: string;
  network: string;
  asset: string;
  payTo: string;
  payToSafety: {
    safe?: boolean;
    reason?: string;
    source?: string;
    checkedAt?: string | null;
    note?: string;
  };
  revenueModel?: string;
  endpoints: Record<string, unknown>;
  example?: Record<string, unknown>;
}

export interface Revenue {
  model: string;
  onChain: boolean;
  note?: string;
  network?: string;
  settlementToken?: string;
  feeRouter?: string;
  totals: {
    count?: null;
    countNote?: string;
    feeUsd?: number;
    traderShare?: number;
    platformShare?: number;
    vaultShare?: number;
  };
  trader?: { address?: string; traderEarningsUsdc?: number };
}

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleResponse {
  ok: true;
  symbol: string;
  assetId?: string;
  underlying: string;
  interval: CandleInterval;
  candles: Candle[];
  source: {
    kind: "exchange" | "delayed" | "simulated" | "none";
    name: string;
    url: string;
    attribution: string;
    reference: string;
    fetchedAt: number;
  };
  degraded?: boolean;
  exhausted?: boolean;
  sourceError?: string;
  disclaimer: string;
}

export interface BenchmarkPoint {
  value: number;
  at: number;
}

export interface BenchmarkResult {
  ok: boolean;
  key: "spx" | "bond" | "gold" | "btc";
  name: string;
  symbol: string;
  current?: BenchmarkPoint;
  previousClose?: BenchmarkPoint;
  series?: { t?: number; c?: number }[];
  atDate?: BenchmarkPoint & { date?: string };
  error?: string;
}

export interface BenchmarksResponse {
  ok: true;
  asOf: number;
  requestedDate: string | null;
  benchmarks: {
    spx?: BenchmarkResult;
    bond?: BenchmarkResult;
    gold?: BenchmarkResult;
    btc?: BenchmarkResult;
  };
}

export type ExposureUnavailableCode =
  | "CALL_REVERTED"
  | "BAD_DATA"
  | "RPC_TIMEOUT"
  | "RPC_ERROR"
  | "NOT_CONFIGURED"
  | "REPORT_DEADLINE";

export interface ExposureOraclePoint {
  price?: number | null;
  updatedAt?: string | null;
  ageSec?: number | null;
}

export interface RiskExposure {
  ok: true;
  chainId: number;
  asOfBlock: number | null;
  asOfBlockTime: string | null;
  generatedAt: string;
  contracts?: {
    exchange?: string;
    mockOracle?: string;
    guardedOracle?: string | null;
    insuranceVault?: string | null;
    assetVaultV2?: string | null;
  };
  exchange: {
    adlEnabled?: boolean | null;
    maxPriceAgeSec?: number | null;
    fundingIntervalSec?: number | null;
  };
  insuranceVault: {
    totalAssets?: number | null;
    totalAssetsRaw?: string | null;
    decimals?: number | null;
  };
  v2Vault: {
    reserveStatus?: {
      reserveRaw?: string;
      liabilityRaw?: string;
      ratioBps?: string;
      ratioUnbounded?: boolean;
      unpriced?: number;
      stale?: boolean;
      halted?: boolean;
    } | null;
    reserveRatioBps?: string | null;
  };
  totals?: { longUsd?: number | null; shortUsd?: number | null } | null;
  assets: {
    symbol?: string;
    assetId?: string;
    openInterest?: {
      method?: "openSize×markPrice" | "globalNotional" | null;
      longUsd?: number | null;
      shortUsd?: number | null;
      netUsd?: number | null;
    };
    oracle?: {
      mock?: ExposureOraclePoint;
      guarded?: ExposureOraclePoint;
      agree?: boolean | null;
      deviationBps?: number | null;
    };
    funding?: {
      lastFundingUpdateAt?: string | null;
      sinceSec?: number | null;
      neverSettled?: boolean | null;
    };
  }[];
  /** 欄位路徑 → 原因代碼。 */
  unavailable: Record<string, ExposureUnavailableCode>;
  notes?: string[];
  cache?: { hit?: boolean; ageSec?: number; ttlSec?: number; remainingSec?: number };
}

export interface AgentVerificationResponse {
  ok: true;
  /** 欄位由 agent/shared/src/verification.ts 定義。 */
  verification: AgentVerification;
}

// ── 與 openapi.yaml 比對用的欄位清單（型別層面保證完整）─────────────────────

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type StringKeys<T> = Extract<keyof T, string>;

/**
 * `schemaKeys<T>()(all, required)`：
 *   all      —— 必須恰好是 T 的全部欄位（少一個或多一個 tsc 都會報錯）；
 *   required —— 必須恰好是 T 的必填欄位。
 * 測試再把這兩個集合與 openapi.yaml 的 properties / required 比對。
 */
function schemaKeys<T>() {
  return <const A extends readonly StringKeys<T>[], const R extends readonly RequiredKeys<T>[]>(
    all: A & (Exclude<StringKeys<T>, A[number]> extends never ? unknown : { missing: Exclude<StringKeys<T>, A[number]> }),
    required: R & (Exclude<RequiredKeys<T>, R[number]> extends never ? unknown : { missingRequired: Exclude<RequiredKeys<T>, R[number]> }),
  ) => ({ all: all as readonly string[], required: required as readonly string[] });
}

/** openapi.yaml `components.schemas.<name>` → SDK 型別的欄位。 */
export const SCHEMA_KEYS = {
  Error: schemaKeys<ErrorBodyKnown>()(["ok", "error", "message", "note", "known"], ["ok", "error"]),
  PayToUnsafe: schemaKeys<PayToUnsafeBody>()(["ok", "error", "reason", "payTo", "note"], ["ok", "error", "reason", "payTo"]),
  PriceStale: schemaKeys<PriceStaleBody>()(
    ["ok", "error", "message", "asset", "ageSec", "maxPriceAgeSec"],
    ["ok", "error", "asset", "ageSec", "maxPriceAgeSec"],
  ),
  FacilitatorError: schemaKeys<FacilitatorErrorBody>()(
    ["ok", "error", "message", "note", "facilitator"],
    ["ok", "error", "note", "facilitator"],
  ),
  X402PaymentRequired: schemaKeys<X402PaymentRequiredBody>()(
    ["error", "accepts", "payer", "x402Version"],
    ["error", "accepts", "x402Version"],
  ),
  PaymentRequirements: schemaKeys<PaymentRequirements>()(
    ["scheme", "network", "maxAmountRequired", "resource", "description", "mimeType", "payTo", "maxTimeoutSeconds", "asset", "outputSchema", "extra"],
    ["scheme", "network", "maxAmountRequired", "resource", "payTo", "maxTimeoutSeconds", "asset"],
  ),
  PaidEnvelope: schemaKeys<PaidEnvelope<unknown>>()(["ok", "settled", "settleError", "data"], ["ok", "settled", "data"]),
  Discovery: schemaKeys<Discovery>()(
    ["service", "discoverable", "description", "network", "asset", "payTo", "payToSafety", "revenueModel", "endpoints", "example"],
    ["service", "network", "asset", "payTo", "payToSafety", "endpoints"],
  ),
  Revenue: schemaKeys<Revenue>()(
    ["model", "onChain", "note", "network", "settlementToken", "feeRouter", "totals", "trader"],
    ["model", "onChain", "totals"],
  ),
  Candle: schemaKeys<Candle>()(["t", "o", "h", "l", "c", "v"], ["t", "o", "h", "l", "c", "v"]),
  CandleResponse: schemaKeys<CandleResponse>()(
    ["ok", "symbol", "assetId", "underlying", "interval", "candles", "source", "degraded", "exhausted", "sourceError", "disclaimer"],
    ["ok", "symbol", "underlying", "interval", "candles", "source", "disclaimer"],
  ),
  BenchmarkPoint: schemaKeys<BenchmarkPoint>()(["value", "at"], ["value", "at"]),
  BenchmarkResult: schemaKeys<BenchmarkResult>()(
    ["ok", "key", "name", "symbol", "current", "previousClose", "series", "atDate", "error"],
    ["ok", "key", "name", "symbol"],
  ),
  BenchmarksResponse: schemaKeys<BenchmarksResponse>()(
    ["ok", "asOf", "requestedDate", "benchmarks"],
    ["ok", "asOf", "requestedDate", "benchmarks"],
  ),
  // shared 的型別全部欄位必填；openapi.yaml 對這兩個 schema 沒有列 required。
  TraderPerformance: schemaKeys<TraderPerformance>()(
    ["trader", "isRegistered", "displayName", "registeredAt", "isEligible", "strategyVersion", "strategy", "positions", "suggestion"],
    ["trader", "isRegistered", "displayName", "registeredAt", "isEligible", "strategyVersion", "strategy", "positions", "suggestion"],
  ),
  OracleSnapshot: schemaKeys<OracleSnapshot>()(
    [
      "asset", "assetId", "price", "updatedAt", "isStale", "ageSec", "maxPriceAgeSec", "tradableNow",
      "fundingRateBps", "fundingRatePercent", "fundingDirection", "longOpenInterest", "shortOpenInterest",
      "oiImbalance", "skewProxyBps", "maintenanceMarginBps", "estLiquidation", "edgeScore",
      "fundingComponent", "oiComponent", "recommendation", "confidence", "reason",
    ],
    [
      "asset", "assetId", "price", "updatedAt", "isStale", "ageSec", "maxPriceAgeSec", "tradableNow",
      "fundingRateBps", "fundingRatePercent", "fundingDirection", "longOpenInterest", "shortOpenInterest",
      "oiImbalance", "skewProxyBps", "maintenanceMarginBps", "estLiquidation", "edgeScore",
      "fundingComponent", "oiComponent", "recommendation", "confidence", "reason",
    ],
  ),
} as const;

/** 內嵌在 paths 裡的回應 schema（不在 components 裡）。 */
export const INLINE_SCHEMA_KEYS = {
  "GET /risk/exposure 200": schemaKeys<RiskExposure>()(
    ["ok", "chainId", "asOfBlock", "asOfBlockTime", "generatedAt", "contracts", "exchange", "insuranceVault", "v2Vault", "totals", "assets", "unavailable", "notes", "cache"],
    ["ok", "chainId", "asOfBlock", "asOfBlockTime", "generatedAt", "exchange", "insuranceVault", "v2Vault", "assets", "unavailable"],
  ),
  "GET /agent/{did}/verification 200": schemaKeys<AgentVerificationResponse>()(["ok", "verification"], ["ok", "verification"]),
} as const;
