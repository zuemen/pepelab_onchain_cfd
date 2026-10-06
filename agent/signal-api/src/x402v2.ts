// x402 v2 付費牆（docs/ADR-010-x402-v2-migration.md）。
//
// 由環境變數 X402_PROTOCOL 啟用（v1｜v2｜both，預設 v1）。**預設模式下這個模組只被 import、
// 不會建立任何東西、不會打任何網路**：createX402V2() 只有在 v2／both 才被呼叫，而且連
// facilitator 的 /supported 也是等到第一個付費路由請求才去拿（見 ensureInitialized）。
//
// 為什麼不直接用 @x402/hono 的 paymentMiddleware：
//   1. 它依賴 @x402/extensions（ajv、siwe、jose、tweetnacl…），全部會被 esbuild 內聯進
//      commit 進 repo 的 Vercel bundle；我們只需要 @x402/core 與 @x402/evm。
//   2. 它的 adapter 有 getBody() → c.req.json()，而 Vercel Node runtime 上讀 request body
//      會**永遠 hang**（serverless 坑 1，見 app.ts 的 /demo/buy-signal）。這裡的 adapter
//      刻意不實作 getBody。
//   3. 它在建立 middleware 的當下就背景呼叫 facilitator（/supported）；serverless 冷啟動時
//      背景 promise 不可靠，而且預設 v1 模式也會因此多打一次網路。
//   4. facilitator 出錯時它回 402（body {}）或通用 500／502，買方分不出「請重付」與
//      「facilitator 掛了」（docs/KNOWN_LIMITATIONS.md §16）。這裡用 hook 取得原始錯誤，
//      轉成與 v1 相同的 429 facilitator_rate_limited／502 facilitator_unavailable。
//
// 流程本身逐步對照 @x402/hono 2.28.0 的 paymentMiddlewareFromHTTPServer（authorization flow）：
//   processHTTPRequest（verify）→ handler → status < 400 才 processSettlement（settle）→ 回應。
// 升級 @x402/core 時請重新對照上游 typescript/packages/http/hono/src/index.ts。
import type { Context, Next } from "hono";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  getFacilitatorResponseError,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RouteConfig,
} from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { decodeBase64Json } from "./paymentIdentifier.ts";

// ── 協定選擇 ─────────────────────────────────────────────────────────────────

export type X402Protocol = "v1" | "v2" | "both";

/**
 * 讀 X402_PROTOCOL。未設或設成無法辨識的值 → **v1**（正式站在營運方明確切換之前行為不變；
 * 打錯字不可以悄悄變成別的模式，也不可以讓整個服務起不來）。
 */
export function resolveX402Protocol(env: NodeJS.ProcessEnv = process.env): X402Protocol {
  const raw = env.X402_PROTOCOL?.trim().toLowerCase();
  if (!raw || raw === "v1") return "v1";
  if (raw === "v2" || raw === "both") return raw;
  console.error(
    `[x402] X402_PROTOCOL="${env.X402_PROTOCOL}" 無法辨識（只接受 v1｜v2｜both）→ 維持 v1。`,
  );
  return "v1";
}

/** v1 的網路名稱 → v2 的 CAIP-2。已經是 CAIP-2 就原樣回傳；其餘丟錯（只在 v2／both 才會呼叫）。 */
const V1_NETWORK_TO_CAIP2: Record<string, `${string}:${string}`> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};
export function toCaip2Network(network: string): `${string}:${string}` {
  const mapped = V1_NETWORK_TO_CAIP2[network];
  if (mapped) return mapped;
  if (/^[a-z0-9-]{3,8}:[A-Za-z0-9-]{1,64}$/.test(network)) return network as `${string}:${string}`;
  throw new Error(
    `[x402] X402_NETWORK="${network}" 沒有對應的 CAIP-2 網路（v2 需要，例如 eip155:84532）。`,
  );
}

/** facilitator 單次請求逾時（ms）。上游預設 90 秒，超過 Vercel 的 maxDuration（60 秒）。 */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 20_000;
/** 第一次取得 /supported 的整體期限（ms）：上游對 429 會重試三次，最壞情況會拖過 function 上限。 */
export const DEFAULT_INIT_TIMEOUT_MS = 25_000;
/**
 * /supported 失敗後的退避（負快取，ms）：這段期間內的付費請求直接沿用上一次的失敗，
 * 不再每個請求都打一次 facilitator（facilitator 掛住時每個請求都會被拖住）。
 */
export const DEFAULT_INIT_BACKOFF_MS = 30_000;
/**
 * both 模式在**未付款**的 v1 402 上疊加 v2 header 時，等 /supported 的上限（ms）。逾時就只回
 * v1 的 402（不帶 v2 header）——v1 client 不可以被 v2 的基礎設施拖慢。
 */
export const DEFAULT_UNPAID_INIT_TIMEOUT_MS = 2_500;

/** facilitator 回 `settlement_pending`：結算交易已送出、尚未確認（@x402/core 會自動重試一次）。 */
export const SETTLEMENT_PENDING_REASON = "settlement_pending";

/** 可取消的計時器（測試注入用；預設是 setTimeout）。 */
export type X402Timer = (ms: number) => { promise: Promise<void>; cancel(): void };
const defaultTimer: X402Timer = (ms) => {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
};

export function resolveFacilitatorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.X402_FACILITATOR_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FACILITATOR_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1_000 || n > 55_000) {
    console.error(
      `[x402] X402_FACILITATOR_TIMEOUT_MS="${raw}" 不是 1000–55000 的整數 → 使用預設 ${DEFAULT_FACILITATOR_TIMEOUT_MS}。`,
    );
    return DEFAULT_FACILITATOR_TIMEOUT_MS;
  }
  return n;
}

// ── facilitator 錯誤分類 ─────────────────────────────────────────────────────

export type FacilitatorPhase = "supported" | "verify" | "settle";

export interface FacilitatorFailure {
  status: 429 | 502;
  message: string;
  phase: FacilitatorPhase;
  /** settle 結果未知、但 facilitator 回了結算 tx hash（例如 settlement_pending）時附上，供買方對帳。 */
  transaction?: string;
}

const RATE_LIMIT_RE = /too many requests|rate.?limit|\b429\b/i;
const NETWORK_ERROR_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|terminated|timed out/i;
/** @x402/core HTTPFacilitatorClient 對「非 2xx 且不是結構化回應」丟的訊息。 */
const FACILITATOR_HTTP_ERROR_RE = /^Facilitator (verify|settle|getSupported) failed \((\d{3})\)/;

/**
 * 把 @x402/core 丟出的錯誤分成「facilitator 限流」「facilitator 無法使用」「其他」。
 * 只認得出來的才轉換，其餘回 null ——
 *   - VerifyError／SettleError 是 facilitator 給的**結構化拒絕**（簽章錯、餘額不足、nonce 用過…），
 *     那是付款本身的問題，維持 402；只有限流才轉 429。
 *   - 我們自己的 bug（TypeError 之類）不可以被包裝成「facilitator 掛了」。
 */
export function classifyV2FacilitatorError(err: unknown, phase: FacilitatorPhase): FacilitatorFailure | null {
  const e = err as { name?: string; message?: string; statusCode?: unknown; invalidReason?: unknown; errorReason?: unknown; cause?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (e?.name === "VerifyError" || e?.name === "SettleError") {
    const reason = String(e.invalidReason ?? e.errorReason ?? "");
    if (e.statusCode === 429 || RATE_LIMIT_RE.test(reason) || RATE_LIMIT_RE.test(message)) {
      return { status: 429, message, phase };
    }
    return null;
  }
  // FacilitatorTimeoutError／FacilitatorResponseError（逾時、回應不是合法 JSON 或不符 schema）。
  if (err instanceof Error && getFacilitatorResponseError(err)) return { status: 502, message, phase };
  const http = FACILITATOR_HTTP_ERROR_RE.exec(message);
  if (http) return { status: http[2] === "429" ? 429 : 502, message, phase };
  // initialize() 把最後一個錯誤放在 cause：往下找一層。
  if (e?.cause !== undefined && e.cause !== err) {
    const inner = classifyV2FacilitatorError(e.cause, phase);
    if (inner) return { ...inner, message: `${message}（${inner.message}）` };
  }
  if (NETWORK_ERROR_RE.test(message)) return { status: 502, message, phase };
  if (/^Failed to initialize: no supported payment kinds/.test(message)) return { status: 502, message, phase };
  return null;
}

/**
 * facilitator 的 /settle 回 HTTP 5xx、本文卻是 JSON（`success:false`）時，@x402/core 丟出的是
 * SettleError——與「facilitator 明確拒絕結算」（200 + success:false）在 hook 裡長得一模一樣。
 * 5xx 不是拒絕：facilitator 自己出錯，交易可能已經送出。把它換成這個錯誤，classify 才認得出
 * 「結果未知」（訊息格式與 HTTPFacilitatorClient 對非 JSON 5xx 丟的相同）。
 */
export class FacilitatorSettleServerError extends Error {
  readonly statusCode: number;
  readonly errorReason?: string;
  readonly transaction?: string;
  readonly payer?: string;
  constructor(statusCode: number, src: { errorReason?: unknown; transaction?: unknown; payer?: unknown }) {
    const reason = typeof src.errorReason === "string" && src.errorReason ? src.errorReason : "unknown";
    super(`Facilitator settle failed (${statusCode}): ${reason}`);
    this.name = "FacilitatorSettleServerError";
    this.statusCode = statusCode;
    this.errorReason = typeof src.errorReason === "string" ? src.errorReason : undefined;
    this.transaction = typeof src.transaction === "string" ? src.transaction : undefined;
    this.payer = typeof src.payer === "string" ? src.payer : undefined;
  }
}

/**
 * 包一層 facilitator client：只改 settle 的一種錯誤（HTTP ≥ 500 的 SettleError → FacilitatorSettleServerError），
 * 其餘原樣轉交。`settlement_pending` 不轉換，讓 @x402/core 照上游行為重試一次。
 */
function withSettleServerErrors(client: FacilitatorClient): FacilitatorClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "settle") return value.bind(target);
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          const e = err as { name?: unknown; statusCode?: unknown; errorReason?: unknown; transaction?: unknown; payer?: unknown } | null;
          if (
            e?.name === "SettleError" &&
            typeof e.statusCode === "number" &&
            e.statusCode >= 500 &&
            e.errorReason !== SETTLEMENT_PENDING_REASON
          ) {
            throw new FacilitatorSettleServerError(e.statusCode, e);
          }
          throw err;
        }
      };
    },
  });
}

// ── 結算結果未知（對帳用）──────────────────────────────────────────────────

/**
 * 授權已交給 facilitator、但不知道有沒有上鏈的付款（逾時、斷線、5xx、回應壞掉、settlement_pending…）。
 * 寫 log 並推進對帳佇列；**不含簽章**。
 */
export interface UnknownSettlementRecord {
  /** unix 秒 */
  at: number;
  /** 例如 "GET /signals/0x…"。 */
  route: string;
  network: string;
  asset: string;
  payTo: string;
  payer: string | null;
  /** EIP-3009 nonce。 */
  nonce: string | null;
  /** 授權金額（atomic）。 */
  amount: string | null;
  validBefore: string | null;
  /** facilitator 回了結算 tx hash 才有。 */
  transaction: string | null;
  /** facilitator 的 errorReason 或錯誤訊息（截斷）。 */
  reason: string;
  /**
   * What to credit if the payment turns out to have landed (app.ts, via unknownRecordContext).
   * Absent on rows written before reconciliation existed — those go to a human.
   */
  ledgerEntry?: unknown;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ── PAYMENT-SIGNATURE 的前置檢查 ─────────────────────────────────────────────

/** PAYMENT-SIGNATURE（base64 JSON）→ PaymentPayload；解不開回 null。 */
export function decodePaymentSignature(header: string | null | undefined): PaymentPayload | null {
  const j = decodeBase64Json(header);
  return j && typeof j === "object" && !Array.isArray(j) ? (j as unknown as PaymentPayload) : null;
}

// ── Hono adapter ─────────────────────────────────────────────────────────────

/**
 * @x402/core 的 HTTPAdapter。**刻意不實作 getBody／getQueryParams**：付費路由只有 GET，
 * 而且在 Vercel Node runtime 上讀 request body 會永遠 hang（serverless 坑 1）。
 */
class HonoRequestAdapter implements HTTPAdapter {
  /**
   * @param probe true = 只為了取得「未付款的 402 付款要求」：隱藏 PAYMENT-SIGNATURE、
   *              一律當成 API client（不要 HTML 付費牆）。both 模式疊加 v2 header 時使用。
   */
  constructor(
    private readonly c: Context,
    private readonly probe = false,
  ) {}
  getHeader(name: string): string | undefined {
    if (this.probe && name.toLowerCase() === "payment-signature") return undefined;
    return this.c.req.header(name);
  }
  getMethod(): string {
    return this.c.req.method;
  }
  getPath(): string {
    return this.c.req.path;
  }
  /** 完整 URL。Vercel 上的 https 由 vercel-entry.ts 補正（402 的 resource.url 取自這裡）。 */
  getUrl(): string {
    return this.c.req.url;
  }
  getAcceptHeader(): string {
    return this.probe ? "application/json" : this.c.req.header("Accept") || "";
  }
  getUserAgent(): string {
    return this.c.req.header("User-Agent") || "";
  }
}

// ── 付費牆 ───────────────────────────────────────────────────────────────────

export interface X402V2Route {
  /** 例如 "GET /signals/[trader]"（與 v1 的 paidRoutes() 同一份 pattern）。 */
  pattern: string;
  /** 例如 "$0.01"。 */
  price: string;
  description: string;
}

export interface X402V2Options {
  payTo: string;
  /** v1 名稱（base-sepolia）或 CAIP-2（eip155:84532）。 */
  network: string;
  facilitatorUrl: string;
  routes: X402V2Route[];
  maxTimeoutSeconds: number;
  /** 測試用：直接注入 facilitator client（不經 HTTP）。 */
  facilitatorClient?: FacilitatorClient;
  facilitatorTimeoutMs?: number;
  initTimeoutMs?: number;
  /** facilitator 出錯時的回應（由 app.ts 提供，與 v1 的 429／502 同一個形狀）。 */
  onFacilitatorFailure: (c: Context, failure: FacilitatorFailure) => Response;
  /** 結算結果未知時呼叫（寫對帳佇列）。丟錯只會被 log，回應仍是 502 phase=settle。 */
  onSettlementUnknown?: (record: UnknownSettlementRecord) => Promise<void>;
  /**
   * Adds app-side context to an unknown-settlement record — app.ts supplies `ledgerEntry`, which
   * the reconciler needs to credit a payment that turns out to have landed. Merged in BEFORE the
   * record is logged, so the log line stays a complete copy of the queued row: if the queue write
   * is refused (full) or fails, the log is the only copy left, and it must carry the ledger entry.
   * A hook rather than reading the context here keeps this module ignorant of the app's variables.
   */
  unknownRecordContext?: (c: Context) => Pick<UnknownSettlementRecord, "ledgerEntry">;
  /**
   * 就要把授權送去 settle 之前呼叫（同步）。app.ts 的 KYA 用它判斷「付費牆丟例外時，錢有沒有可能已經動了」：
   * 沒呼叫過＝結算前就失敗，可以退回花費預留；呼叫過＝結果不明，保留。
   */
  onSettleStart?: (c: Context) => void;
  /** /supported 失敗後的退避（ms），預設 DEFAULT_INIT_BACKOFF_MS。 */
  initBackoffMs?: number;
  /** both 模式未付款 402 等 /supported 的上限（ms），預設 DEFAULT_UNPAID_INIT_TIMEOUT_MS。 */
  unpaidInitTimeoutMs?: number;
  /** 測試用：時鐘（ms）。 */
  now?: () => number;
  /** 測試用：計時器。 */
  timer?: X402Timer;
}

export interface X402V2Paywall {
  readonly network: `${string}:${string}`;
  /** 這個請求是不是 v2 付費牆會收費的路由（以 Hono 正規化後的 c.req.path 判斷）。 */
  requiresPayment(c: Context): boolean;
  /**
   * 未付款時要附在 402 上的 v2 header（PAYMENT-REQUIRED、Cache-Control）。both 模式用它把
   * v2 的付款要求疊在 v1 的 402 上。拿不到（facilitator /supported 失敗）回 failure。
   */
  unpaidHeaders(c: Context): Promise<{ headers: Record<string, string> } | { failure: FacilitatorFailure }>;
  /** 完整的 v2 付費牆 middleware。 */
  handle(c: Context, next: Next): Promise<Response | void>;
}

function instructionsToResponse(r: HTTPResponseInstructions): Response {
  const headers = new Headers(r.headers);
  if (r.isHtml) return new Response(String(r.body ?? ""), { status: r.status, headers });
  if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers });
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Cache-Control 併入 private（與 @x402/core 的 withPrivateCacheControl 相同）。 */
function withPrivate(value: string | null): string {
  if (!value) return "private";
  return value.split(",").some((d) => d.trim().toLowerCase() === "private") ? value : `${value}, private`;
}

export function createX402V2(opts: X402V2Options): X402V2Paywall {
  const network = toCaip2Network(opts.network);
  const facilitator: FacilitatorClient = withSettleServerErrors(
    opts.facilitatorClient ??
      new HTTPFacilitatorClient({
        url: opts.facilitatorUrl,
        timeoutMs: opts.facilitatorTimeoutMs ?? resolveFacilitatorTimeoutMs(),
      }),
  );
  const now = opts.now ?? Date.now;
  const startTimer = opts.timer ?? defaultTimer;
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  // facilitator 呼叫丟出的原始錯誤（以這個請求的 adapter 為鍵）。@x402/core 會把非
  // FacilitatorResponseError 的錯誤吞成一個 402，hook 是唯一拿得到原始錯誤的地方。
  const failures = new WeakMap<object, { error: unknown; phase: FacilitatorPhase }>();
  const adapterOf = (ctx: { transportContext?: unknown }): object | undefined =>
    (ctx.transportContext as { request?: { adapter?: object } } | undefined)?.request?.adapter;
  resourceServer.onVerifyFailure(async (ctx) => {
    const a = adapterOf(ctx);
    if (a) failures.set(a, { error: ctx.error, phase: "verify" });
  });
  resourceServer.onSettleFailure(async (ctx) => {
    const a = adapterOf(ctx);
    if (a) failures.set(a, { error: ctx.error, phase: "settle" });
  });

  const routes: Record<string, RouteConfig> = {};
  for (const r of opts.routes) {
    routes[r.pattern] = {
      accepts: {
        scheme: "exact",
        network,
        payTo: opts.payTo,
        price: r.price,
        maxTimeoutSeconds: opts.maxTimeoutSeconds,
      },
      description: r.description,
      mimeType: "application/json",
      // 不宣告 payment-identifier 擴充：規格要求「同 id 同內容回快取、同 id 不同內容回 409」，
      // 我們沒有實作請求層去重。client 帶了 id 照樣收，只當中繼資料記進帳本（見 ledger.ts）。
    };
  }
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // ── 延後初始化（single-flight）：第一個付費路由請求才去拿 facilitator /supported ──
  //   - 失敗後退避 initBackoffMs（負快取）：期間內直接沿用上一次的失敗，不再打 /supported。
  //   - 等待有上限：付費請求 initTimeoutMs；both 模式的未付款 402 只等 unpaidInitTimeoutMs，
  //     而且同一輪初始化已經讓一個未付款請求等到逾時之後，其他未付款請求就不再等。
  let initPromise: Promise<void> | null = null;
  let initialized = false;
  let lastInitFailure: { at: number; error: unknown } | null = null;
  /** 已經讓未付款請求等到逾時的那一輪初始化。 */
  let slowInit: Promise<void> | null = null;
  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const initBackoffMs = opts.initBackoffMs ?? DEFAULT_INIT_BACKOFF_MS;
  const unpaidInitTimeoutMs = opts.unpaidInitTimeoutMs ?? DEFAULT_UNPAID_INIT_TIMEOUT_MS;

  function startInit(): Promise<void> {
    if (!initPromise) {
      const p: Promise<void> = httpServer.initialize().then(
        () => {
          initialized = true;
          lastInitFailure = null;
        },
        (err) => {
          if (initPromise === p) initPromise = null; // 退避期過後的下一個請求重試
          lastInitFailure = { at: now(), error: err };
          throw err;
        },
      );
      // 逾時後這個 promise 仍在背景跑；它之後才失敗時不要變成 unhandled rejection。
      p.catch(() => {});
      initPromise = p;
    }
    return initPromise;
  }

  async function ensureInitialized(deadlineMs: number, markSlow = false): Promise<void> {
    if (initialized) return;
    if (!initPromise && lastInitFailure) {
      const waited = now() - lastInitFailure.at;
      if (waited < initBackoffMs) {
        const cause = lastInitFailure.error;
        throw new Error(
          `x402 v2 初始化失敗，退避中（${Math.ceil((initBackoffMs - waited) / 1000)} 秒後重試）：` +
            `${(cause as { message?: string } | null)?.message ?? String(cause)}`,
          { cause },
        );
      }
    }
    const p = startInit();
    const t = startTimer(deadlineMs);
    let timedOut = false;
    try {
      await Promise.race([
        p,
        t.promise.then(() => {
          timedOut = true;
          throw new Error(`Facilitator getSupported timed out after ${deadlineMs}ms`);
        }),
      ]);
    } finally {
      t.cancel();
      if (timedOut && markSlow && initPromise === p) slowInit = p;
    }
  }

  const contextOf = (c: Context, probe = false): HTTPRequestContext => ({
    adapter: new HonoRequestAdapter(c, probe),
    path: c.req.path,
    method: c.req.method,
    paymentHeader: probe ? undefined : c.req.header("payment-signature"),
  });

  const initFailure = (err: unknown): FacilitatorFailure =>
    classifyV2FacilitatorError(err, "supported") ?? {
      // 初始化失敗一律不發 402（發不出正確的付款要求）。認不出來的也回 502，但訊息只給代碼，
      // 完整錯誤寫 log（可能含 facilitator URL 的憑證）。
      status: 502,
      message: "x402 v2 初始化失敗（facilitator /supported 或路由設定）",
      phase: "supported",
    };

  return {
    network,

    requiresPayment(c) {
      return httpServer.requiresPayment(contextOf(c));
    },

    async unpaidHeaders(c) {
      if (!initialized && initPromise && slowInit === initPromise) {
        // 這一輪初始化已經讓一個未付款請求等到逾時：其他未付款請求不再等。
        return { failure: { status: 502, message: "facilitator /supported 尚未回應", phase: "supported" } };
      }
      try {
        await ensureInitialized(unpaidInitTimeoutMs, true);
      } catch (err) {
        console.error(`[x402v2] initialize 失敗：${(err as { message?: string } | null)?.message ?? String(err)}`);
        return { failure: initFailure(err) };
      }
      const result = await httpServer.processHTTPRequest(contextOf(c, true));
      if (result.type !== "payment-error") return { headers: {} };
      const { "Content-Type": _ct, "content-type": _ct2, ...rest } = result.response.headers;
      return { headers: rest };
    },

    async handle(c, next) {
      const context = contextOf(c);
      if (!httpServer.requiresPayment(context)) return next();

      // ── PAYMENT-SIGNATURE 的前置檢查（在任何 facilitator 呼叫之前；未扣款）──
      const sigHeader = c.req.header("payment-signature");
      if (sigHeader) {
        const payload = decodePaymentSignature(sigHeader);
        if (!payload) {
          return jsonError(400, {
            ok: false,
            error: "invalid_payment_signature",
            message: "PAYMENT-SIGNATURE 不是 base64 編碼的 JSON。",
            note: "未扣款：付款授權沒有送給 facilitator。",
          });
        }
        if (payload.x402Version !== 2) {
          return jsonError(400, {
            ok: false,
            error: "unsupported_x402_version",
            message: `PAYMENT-SIGNATURE 只接受 x402Version 2（收到 ${String(payload.x402Version)}）；v1 請用 X-PAYMENT。`,
            note: "未扣款：付款授權沒有送給 facilitator。",
          });
        }
        // payment-identifier 不在這裡檢查：伺服器沒有宣告這個擴充，client 帶了也照收（只當中繼資料）。
      }

      try {
        await ensureInitialized(initTimeoutMs);
      } catch (err) {
        console.error("[x402v2] initialize 失敗：", err);
        return opts.onFacilitatorFailure(c, initFailure(err));
      }

      let result: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
      try {
        result = await httpServer.processHTTPRequest(context);
      } catch (err) {
        const f = classifyV2FacilitatorError(err, "verify");
        if (!f) throw err;
        return opts.onFacilitatorFailure(c, f);
      }

      if (result.type === "no-payment-required") return next();

      if (result.type === "payment-error") {
        const failed = failures.get(context.adapter);
        if (failed) {
          failures.delete(context.adapter);
          const f = classifyV2FacilitatorError(failed.error, failed.phase);
          if (f) return opts.onFacilitatorFailure(c, f);
          // facilitator 的結構化拒絕（VerifyError）→ 維持上游的 402；其餘是我們自己的錯，照 v1 丟出去。
          const name = (failed.error as { name?: string } | null)?.name;
          if (name !== "VerifyError" && name !== "SettleError") throw failed.error;
        }
        // facilitator 以 200 + isValid:false 回報限流時，上游把 invalidReason 放進 402 的 error。
        // 402 對 x402 client 的意思是「請付款」，會讓它對一個沒問題的簽章重簽重送（§16）。
        if (sigHeader && result.response.status === 402) {
          const required = decodeBase64Json(result.response.headers["PAYMENT-REQUIRED"]) as { error?: unknown } | null;
          if (typeof required?.error === "string" && RATE_LIMIT_RE.test(required.error)) {
            return opts.onFacilitatorFailure(c, { status: 429, message: required.error, phase: "verify" });
          }
        }
        return instructionsToResponse(result.response);
      }

      // ── payment-verified：先跑 handler，status < 400 才 settle ───────────────
      const { cancellationDispatcher, paymentPayload, paymentRequirements, declaredExtensions } = result;
      try {
        await next();
      } catch (err) {
        await cancellationDispatcher.cancel({ reason: "handler_threw", error: err });
        throw err;
      }
      const handlerRes = c.res;
      if (handlerRes.status >= 400) {
        // status ≥ 400 → 不 settle，買方不被扣款（與 v1 相同）。
        await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: handlerRes.status });
        return;
      }

      // 與 x402-hono／@x402/hono 相同：先把 c.res 清掉，settle 完再整個換上去。
      c.res = undefined as unknown as Response;
      const responseBody = Buffer.from(await handlerRes.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      handlerRes.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      // ── 結算結果未知：502 phase=settle（不是 402「請重付」）＋ log ＋ 對帳佇列 ──
      const auth = (paymentPayload.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
      const settleUnknown = async (
        message: string,
        detail: { transaction?: unknown; payer?: unknown; reason?: unknown },
      ): Promise<Response> => {
        const tx = str(detail.transaction);
        const transaction = tx && TX_RE.test(tx) ? tx : null;
        const reportedPayer = str(detail.payer);
        const payer = reportedPayer && ADDR_RE.test(reportedPayer) ? reportedPayer : str(auth?.from);
        const record: UnknownSettlementRecord = {
          at: Math.floor(now() / 1000),
          route: `${c.req.method} ${c.req.path}`,
          network: paymentRequirements.network,
          asset: paymentRequirements.asset,
          payTo: paymentRequirements.payTo,
          payer,
          nonce: str(auth?.nonce),
          amount: str(auth?.value) ?? str(paymentRequirements.amount),
          validBefore: str(auth?.validBefore),
          transaction,
          reason: (str(detail.reason) ?? message).slice(0, 200),
          ...(opts.unknownRecordContext ? opts.unknownRecordContext(c) : {}),
        };
        console.error(`[x402v2] settlement_unknown ${JSON.stringify(record)}`);
        if (opts.onSettlementUnknown) {
          try {
            await opts.onSettlementUnknown(record);
          } catch (err) {
            console.error(
              `[x402v2] settlement_unknown 寫入對帳佇列失敗（回應仍是 502）：${(err as { message?: string } | null)?.message ?? String(err)}`,
            );
          }
        }
        return opts.onFacilitatorFailure(c, {
          status: 502,
          message,
          phase: "settle",
          ...(transaction ? { transaction } : {}),
        });
      };

      let settle: Awaited<ReturnType<typeof httpServer.processSettlement>>;
      opts.onSettleStart?.(c);
      try {
        settle = await httpServer.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, {
          request: context,
          responseBody,
          responseHeaders,
        });
      } catch (err) {
        const f = classifyV2FacilitatorError(err, "settle");
        if (!f) throw err;
        if (f.status === 502) return settleUnknown(f.message, (err ?? {}) as { transaction?: unknown; payer?: unknown });
        return opts.onFacilitatorFailure(c, f);
      }
      if (!settle.success) {
        const failed = failures.get(context.adapter);
        failures.delete(context.adapter);
        if (settle.errorReason === SETTLEMENT_PENDING_REASON) {
          // facilitator 已送出結算交易、尚未確認（core 已重試一次）。回 402 會叫 client 重付 → 可能付兩次。
          return settleUnknown("settlement_pending：facilitator 已送出結算交易，尚未確認", {
            transaction: settle.transaction,
            payer: settle.payer,
            reason: settle.errorReason,
          });
        }
        if (failed) {
          const f = classifyV2FacilitatorError(failed.error, "settle");
          const e = failed.error as { name?: unknown; transaction?: unknown; payer?: unknown } | null;
          const detail = { transaction: e?.transaction ?? settle.transaction, payer: e?.payer ?? settle.payer };
          if (f?.status === 502) return settleUnknown(f.message, detail);
          if (f) return opts.onFacilitatorFailure(c, f);
          if (e?.name !== "SettleError") {
            // 不是 facilitator 的結構化拒絕（例如 client 端的非預期錯誤）：授權可能已送出，一樣當結果未知。
            console.error("[x402v2] settle 失敗（無法分類）：", failed.error);
            return settleUnknown("x402 v2 結算失敗（原因無法分類）", detail);
          }
        }
        // 結算被 facilitator 明確拒絕：不回傳付費資源，只回 402 + PAYMENT-RESPONSE（success:false）。
        return instructionsToResponse(settle.response);
      }
      const headers = new Headers(handlerRes.headers);
      headers.delete("transfer-encoding");
      headers.delete("content-length");
      headers.delete("settlement-overrides");
      for (const [k, v] of Object.entries(settle.headers)) headers.set(k, v);
      headers.set("Cache-Control", withPrivate(headers.get("Cache-Control")));
      return new Response(responseBody, { status: handlerRes.status, headers });
    },
  };
}
