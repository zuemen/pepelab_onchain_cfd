// 共用 Hono app 工廠：本機 node 伺服器（src/index.ts）與 Vercel serverless
// （api/index.ts）共用同一份路由與 x402 paymentMiddleware，只差啟動外殼。
//
// serverless 注意事項：
//   - 結算（routeExternalRevenue）在回應前 **await**，並把 tx 一起回傳——serverless
//     不保證「回應後背景跑」，fire-and-forget 會被砍掉。
//   - /revenue 直接讀鏈上（X402 FeeRouter），因 in-memory 帳務每次 invocation 歸零。
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";
import { computeRoutePatterns, findMatchingRoute } from "x402/shared";
import { ethers } from "ethers";
import {
  resolvePayTo,
  assetIdOf,
  classifyTradeFreshness,
  ADDRESSES,
  makeProvider,
  makeContracts,
  makeSigner,
  getSessionManagerAddress,
  getTraderPerformance,
  getOracleSnapshot,
  jsonSafe,
  parseDidPkh,
  agentDid,
  buildAgentVerification,
  resolveSettlementToken,
  ASSET_IDS,
  AGENT_CHAIN_ID,
  V2_ADDRESSES,
  assessPayoutAddress,
  isCompromisedAddress,
  checkPayoutDenylistEnv,
  redactSecrets,
  type CodeReader,
  type PayoutAssessment,
  type ContractTarget,
} from "@pepelab/shared";
import { isSettlementEnabled } from "./settlement.ts";
import { randomUUID } from "node:crypto";
import {
  isLedgerEnabled,
  enqueueSettlement,
  enqueueSettlementOnce,
  authorizationMarkerKey,
  deriveIdempotencyKey,
  deriveIdempotencyKeyV2,
  recordUnknownSettlement,
  type LedgerEntry,
} from "./ledger.ts";
import {
  createX402V2,
  decodePaymentSignature,
  resolveX402Protocol,
  type FacilitatorFailure,
  type X402Protocol,
  type X402V2Options,
  type X402V2Paywall,
} from "./x402v2.ts";
import { readPaymentIdentifier } from "./paymentIdentifier.ts";
import type { FacilitatorClient } from "@x402/core/server";
import { getOnchainRevenue, isOnchainRevenueEnabled } from "./onchainRevenue.ts";
import {
  getCandles,
  INTERVAL_KEYS,
  MAX_LIMIT,
  UnknownMarketError,
  BadIntervalError,
} from "./candles.ts";
import { getBenchmarks, BadDateError } from "./benchmarks.ts";
import { LruCache } from "./lru.ts";
import {
  createExposureService,
  providerReader,
  type ExposureReader,
  type ExposureTargets,
} from "./exposure.ts";

const NETWORK = (process.env.X402_NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const PAY_TO = resolvePayTo(ADDRESSES.FeeRouter);
// x402 協定版本（docs/ADR-010）：v1（預設，行為與遷移前逐位元相同）｜v2｜both。
const X402_PROTOCOL: X402Protocol = resolveX402Protocol();
// 單一來源（shared/env.ts）。這裡與 settlement.ts 以前各有一份**不同**的預設值
// （官方 USDC vs MockUSDC），導致 `_assertCurrencyMatch` 永遠抓不到錯配。
const SETTLEMENT_TOKEN = resolveSettlementToken();

// 單一定價來源：付費牆、帳務、文件共用。
export const PRICE_SIGNALS = 0.01; // USDC
export const PRICE_ORACLE = 0.005; // USDC

// x402 付款授權的有效期上限（秒）。client 用它算 EIP-3009 的 validBefore。
// 不設時 x402-hono 0.5.3 預設 300。改成 60：這兩個端點都是單次 GET、回應在秒級，
// 一張簽好的授權沒有理由活五分鐘。
//
// ⚠ 這是**宣告**，不是強制：2026-09-17 實測 x402.org/facilitator 只檢查
// validBefore >= now+6，不檢查上界（validBefore = now+30 天照樣通過時間檢查）。
// 見 docs/KNOWN_LIMITATIONS.md §15 與 signal-api/scripts/probe-facilitator.ts。
export const MAX_TIMEOUT_SECONDS = 60;

// 2026-09-29（P0）：以前這裡有一個 DEFAULT_DEMO_TRADER，寫死成舊 deployer 地址
// —— 那正是 2026-08-06 稽核確認私鑰外洩、鏈上已被 EIP-7702 sweeper 接管的地址，
// 而 /oracle 的 70% 分潤就落在 resolveTrader() 的回傳值上。
// 現在：demo 只用 DEMO_TRADER_ADDRESS 或鏈上第一個已註冊 trader，都沒有就明說；
// /oracle 的受益人改由 ORACLE_BENEFICIARY_ADDRESS 明確指定（見下方 handler）。

const provider = makeProvider();
const contracts = makeContracts(provider);

// ── ERC-8126 verification layer ───────────────────────────────────────────────
// Verifier identity that signs agent verification attestations. Prefers
// VERIFIER_PRIVATE_KEY; falls back to a process-stable random wallet so the
// endpoint works out-of-the-box (each attestation self-describes its verifier
// DID, and tamper-detection still holds within a process lifetime).
const VERIFIER_IS_EPHEMERAL = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  return !(pk && pk.startsWith("0x") && pk.length === 66);
})();
const VERIFIER_WALLET = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  if (!VERIFIER_IS_EPHEMERAL) return new ethers.Wallet(pk!);
  console.warn("[verifier] 未設 VERIFIER_PRIVATE_KEY → 使用臨時隨機 verifier；正式環境請固定設定以保身分穩定。");
  return ethers.Wallet.createRandom();
})();

// Public base URL for the WAV (web-accessible) self-check.
//
// 稽核（四·Medium）：舊版在缺 SIGNAL_API_PUBLIC_URL 時直接取 `new URL(c.req.url).origin`
// —— 而 serverless 的 request URL 是由**呼叫者可控的 Host header** 組出來的。於是這個
// 免費、未認證的端點會照著攻擊者給的 Host 去發外連請求（SSRF-ish 放大器）。
// 現在：env 優先；否則只接受白名單內的 origin；都不符就退回固定預設值。
const PUBLIC_URL_ALLOWLIST = (process.env.SIGNAL_API_URL_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const FALLBACK_API_BASE_URL = "http://localhost:4021";

export function resolveApiBaseUrl(reqUrl: string): string {
  const fromEnv = process.env.SIGNAL_API_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const origin = new URL(reqUrl).origin;
    if (PUBLIC_URL_ALLOWLIST.includes(origin)) return origin;
    const host = new URL(origin).hostname;
    // localhost 開發一律放行；其餘一律不信任請求帶進來的 host。
    if (host === "localhost" || host === "127.0.0.1") return origin;
  } catch {
    /* fall through */
  }
  return FALLBACK_API_BASE_URL;
}

// ETV targets: settlement token + core protocol contract (must exist on-chain).
const ETV_TARGETS: ContractTarget[] = [
  { label: "USDC (settlement)", address: SETTLEMENT_TOKEN },
  { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
];
// SCV targets: core contracts whose source should be explorer-verified.
const SCV_TARGETS: ContractTarget[] = [
  { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
  { label: "FeeRouter", address: ADDRESSES.FeeRouter },
  { label: "AgentSessionManager", address: getSessionManagerAddress() },
];

// 解析分析對象（demo 用）：明確指定 > DEMO_TRADER_ADDRESS > 鏈上第一個已註冊 trader。
// 都沒有 → 回 null，由呼叫端優雅回應；**不再**退回任何寫死的地址。
async function resolveTrader(want?: string): Promise<string | null> {
  if (want && /^0x[0-9a-fA-F]{40}$/.test(want)) return want;
  const envT = process.env.DEMO_TRADER_ADDRESS?.trim();
  if (envT && /^0x[0-9a-fA-F]{40}$/.test(envT)) return envT;
  const list = (await contracts.registry.getAllTraders()) as string[];
  return list.length ? list[0] : null;
}

/**
 * /oracle 收入的 70% 受益人。只認 env `ORACLE_BENEFICIARY_ADDRESS`，而且不可是
 * 已知外洩地址。沒設（或設錯）→ 回 reason，這筆收入就不排入分潤（款項留在 payTo）。
 */
export function resolveOracleBeneficiary(): { address: string } | { reason: string } {
  const raw = process.env.ORACLE_BENEFICIARY_ADDRESS?.trim();
  if (!raw) {
    return {
      reason:
        "未設 ORACLE_BENEFICIARY_ADDRESS：這筆 /oracle 收入不排入 70/20/10 分潤" +
        "（款項已進 payTo，未分配）。",
    };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/.test(raw)) {
    return { reason: `ORACLE_BENEFICIARY_ADDRESS 不是合法地址（${raw}），不排入分潤。` };
  }
  if (isCompromisedAddress(raw)) {
    return { reason: `ORACLE_BENEFICIARY_ADDRESS=${raw} 是已知外洩地址，拒絕把 70% 分潤送過去。` };
  }
  return { address: raw };
}

// /demo/buy-signal 速率限制（best-effort）：per-IP 冷卻 + per-instance 硬上限。
// 注意：serverless 上記憶體是 per-instance、X-Forwarded-For 可偽造，故 IP 冷卻只是
// 第一道；真正防線是「demo treasury 只放 dust」(見 README 安全備註) + 這個總量硬上限。
const DEMO_COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? "15000");
const DEMO_MAX_BUYS = Number(process.env.DEMO_MAX_BUYS ?? "50"); // 每個暖實例壽命內上限
const lastBuyByIp = new Map<string, number>();
let demoBuyCount = 0;

/** `lastBuyByIp` 以前永不淘汰 → 長壽實例的記憶體無上界。定期清掉過期項目。 */
function pruneIpMap(map: Map<string, number>, ttlMs: number, cap = 5_000): void {
  const now = Date.now();
  for (const [k, t] of map) if (now - t > ttlMs) map.delete(k);
  // 極端情況（大量不同 IP 在 TTL 內湧入）仍要有硬上限。
  if (map.size > cap) {
    const excess = map.size - cap;
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++i >= excess) break;
    }
  }
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

// ── 免費端點的節流（稽核 四·Low：CORS 全開且免費端點無節流）────────────────
// 免費端點每一個都會打 RPC / 外部 API，未節流時任何人都能把它當放大器。
// serverless 上這是 per-instance 的 best-effort，與 /demo 的硬上限同一等級的防線。
const FREE_RATE_WINDOW_MS = Number(process.env.FREE_RATE_WINDOW_MS ?? "60000");
const FREE_RATE_MAX = Number(process.env.FREE_RATE_MAX ?? "60"); // 每 IP 每視窗
const freeHits = new Map<string, { count: number; resetAt: number }>();

function freeRateLimited(ip: string): { limited: boolean; retryAfterSec: number } {
  const now = Date.now();
  const e = freeHits.get(ip);
  if (!e || now >= e.resetAt) {
    freeHits.set(ip, { count: 1, resetAt: now + FREE_RATE_WINDOW_MS });
    if (freeHits.size > 5_000) {
      for (const [k, v] of freeHits) if (now >= v.resetAt) freeHits.delete(k);
    }
    return { limited: false, retryAfterSec: 0 };
  }
  e.count += 1;
  if (e.count > FREE_RATE_MAX) {
    return { limited: true, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

// CORS：GET 的公開資料維持全開（agent/瀏覽器都要用），但**寫入型**的
// POST /demo/buy-signal 只允許白名單 origin（預設只有本機與正式前端）。
const CORS_ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://localhost:4173,https://pepelab-onchain-cfd-djot.vercel.app"
)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// facilitator 失敗的分類。只認得出來的才轉換，其餘回 null 交還原本的錯誤路徑
// ——不要把「我們自己的 bug」也包裝成「facilitator 掛了」。
const FACILITATOR_RETRY_AFTER_SEC = 5;
export function classifyFacilitatorFailure(message: string | undefined): {
  status: 429 | 502;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} | null {
  if (!message) return null;
  const note = "未扣款：付款授權尚未被 facilitator 結算，可用同一個請求重試（會重新簽一張授權）。";
  if (/too many requests|rate.?limit|\b429\b/i.test(message)) {
    return {
      status: 429,
      body: { ok: false, error: "facilitator_rate_limited", message, note, facilitator: FACILITATOR_URL },
      headers: { "Retry-After": String(FACILITATOR_RETRY_AFTER_SEC) },
    };
  }
  if (/^Failed to verify payment|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)) {
    return {
      status: 502,
      body: { ok: false, error: "facilitator_unavailable", message, note, facilitator: FACILITATOR_URL },
      headers: {},
    };
  }
  return null;
}

/**
 * v2 付費牆的 facilitator 失敗回應：與 v1 的 classifyFacilitatorFailure 同一組錯誤代碼與形狀，
 * 多一個 `phase`。**settle 階段的說明不同**：授權已經交給 facilitator，逾時／斷線時無法斷言
 * 「未扣款」——v1 的 x402-hono 在這個情況回的是一個看不出原因的 402。
 */
export function facilitatorFailureResponse(f: FacilitatorFailure): Response {
  const note =
    f.phase === "settle"
      ? "結算結果未知：付款授權已交給 facilitator，在 validBefore 之前仍可能被結算。" +
        "請先對帳（鏈上 USDC 轉帳紀錄）再決定是否重試；付費資料未回傳。"
      : f.phase === "supported"
        ? "未扣款、未發出付款要求（402）：無法向 facilitator 取得支援的付款方式，請稍後重試。"
        : "未扣款：付款授權尚未被 facilitator 結算，可用同一個請求重試（會重新簽一張授權）。";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (f.status === 429) headers["Retry-After"] = String(FACILITATOR_RETRY_AFTER_SEC);
  return new Response(
    JSON.stringify({
      ok: false,
      error: f.status === 429 ? "facilitator_rate_limited" : "facilitator_unavailable",
      message: f.message,
      note,
      facilitator: FACILITATOR_URL,
      phase: f.phase,
      // 結算結果未知但 facilitator 回了結算 tx hash（例如 settlement_pending）：給買方對帳。
      ...(f.transaction ? { transaction: f.transaction } : {}),
    }),
    { status: f.status, headers },
  );
}

// Hono Context 變數：handler 用 c.set("ledgerEntry", …) 留下這筆該記多少帳，
// 由付費牆外層的 middleware 在確認收到款後讀出來、推進結算佇列（見下）。
type AppVariables = { ledgerEntry?: LedgerEntry };

/**
 * 優先序 1（記帳 + 批次結算）的核心決策：純函式，只吃「這筆該記多少帳」跟
 * 「付費牆處理完之後的 Response」，不碰 Hono context、不碰任何鏈上呼叫。
 *
 * 抽成純函式而不是留在 middleware 裡直接操作 c，是為了讓 ledgerFlow.test.ts
 * 能繞開 /signals、/oracle 的真實 handler——那兩個 handler 會讀鏈上資料
 * （getTraderPerformance/getOracleSnapshot），在沒有真的 Base Sepolia RPC 時
 * （例如 CI）一定會失敗，跟這裡要驗證的「記帳邏輯本身對不對」是兩件事。
 *
 * @param entry handler 用 c.set("ledgerEntry", …) 留下的待分潤項目；沒有就代表
 *              這個 request 不是走 /signals 或 /oracle，原樣放行。
 * @param res   付費牆（含 facilitator settle）處理完之後的 Response。只有
 *              status < 400 且帶 `X-PAYMENT-RESPONSE`（facilitator settle 真的
 *              成功的證明）才會記帳；否則原樣回傳，不動它。
 * @param paymentHeader 請求的 X-PAYMENT（base64），冪等鍵的第二順位來源。
 *
 * 冪等鍵（2026-09-29 P0）：優先用 X-PAYMENT-RESPONSE 裡 facilitator 的結算 tx hash，
 * 其次 X-PAYMENT 的「付款人 + EIP-3009 nonce」；兩者都解不出來（理論上不會）才用
 * 隨機 id——至少保證 worker 端同一筆不會被送兩次。
 *
 * @param protocol 省略或 "v1"：上述行為（X-PAYMENT／X-PAYMENT-RESPONSE），與遷移前完全相同。
 *                 "v2"：結算證明改看 `PAYMENT-RESPONSE`（且 success 不可為 false——v2 的結算失敗
 *                 402 也帶這個 header），`paymentHeader` 是 `PAYMENT-SIGNATURE`；冪等鍵一律
 *                 `tx:<hash>` 優先（見 deriveIdempotencyKeyV2）。client 帶的 payment-identifier
 *                 只當中繼資料存進 LedgerEntry.paymentId，不參與去重。
 */
export async function applyLedgerRecording(
  entry: LedgerEntry | undefined,
  res: Response,
  paymentHeader?: string | null,
  protocol: "v1" | "v2" = "v1",
): Promise<Response> {
  const proofHeader = protocol === "v2" ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE";
  if (!entry || res.status >= 400 || !res.headers.has(proofHeader)) {
    return res;
  }
  if (protocol === "v2") {
    // 縱深防禦：v2 的 PAYMENT-RESPONSE 在結算失敗時也會出現（success:false）。
    try {
      const proof = JSON.parse(Buffer.from(res.headers.get(proofHeader)!, "base64").toString("utf8")) as {
        success?: unknown;
      };
      if (proof?.success !== true) return res;
    } catch {
      return res;
    }
  }
  let settleError: string | undefined;
  let queued = false;
  if (!isLedgerEnabled()) {
    settleError =
      "settlement disabled：未設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN" +
      "（僅保留鏈下帳務 /revenue）";
  } else {
    try {
      // 必須 await：serverless 不保證回應後還能背景跑，fire-and-forget 會被砍掉
      // ——跟這份檔案開頭那條舊註解講的是同一件事，只是現在等的是一次 KV 寫入
      // （通常 <150ms），不再是一筆鏈上交易的 tx.wait()（≥2 秒起跳）。
      const v2Payload = protocol === "v2" ? decodePaymentSignature(paymentHeader) : null;
      let idempotencyKey =
        protocol === "v2"
          ? deriveIdempotencyKeyV2(res.headers.get(proofHeader), v2Payload)
          : deriveIdempotencyKey(res.headers.get("X-PAYMENT-RESPONSE"), paymentHeader);
      if (!idempotencyKey) {
        idempotencyKey = `req:${randomUUID()}`;
        // 理論上不會發生（X-PAYMENT-RESPONSE 應帶結算 tx hash）。隨機鍵只防 worker 端
        // 重送，**無法**辨認同一筆付款的重複入列，所以要留下痕跡。
        console.warn(
          `[ledger] 無法從 ${proofHeader} / ${protocol === "v2" ? "PAYMENT-SIGNATURE" : "X-PAYMENT"} 推導冪等鍵，改用隨機鍵 ${idempotencyKey}：` +
            JSON.stringify(entry),
        );
      }
      const pid = v2Payload ? readPaymentIdentifier(v2Payload) : null;
      const full: LedgerEntry = { ...entry, idempotencyKey, ...(pid?.valid && pid.id ? { paymentId: pid.id } : {}) };
      // v2: one revenue row per EIP-3009 authorization, whichever tx hash the facilitator
      // reported (ledger.ts AUTHZ_MARKER_PREFIX). `accepted` was matched exactly against our
      // requirements by the paywall, so its network/asset are ours.
      const v2 = v2Payload as { accepted?: { network?: unknown; asset?: unknown }; payload?: { authorization?: { from?: unknown; nonce?: unknown } } } | null;
      const marker = v2
        ? authorizationMarkerKey({
            network: v2.accepted?.network,
            asset: v2.accepted?.asset,
            payer: v2.payload?.authorization?.from,
            nonce: v2.payload?.authorization?.nonce,
          })
        : null;
      if (marker) {
        if ((await enqueueSettlementOnce(full, marker)) === "already_credited") {
          console.warn(`[ledger] authorization already credited (${marker}); not queued again: ${JSON.stringify(full)}`);
        }
      } else {
        await enqueueSettlement(full);
      }
      queued = true;
    } catch (err) {
      settleError = "ledger_enqueue_failed：已收款但分潤紀錄未能排入佇列（已記錄於伺服器 log）";
      // 買方已經拿到資料且已扣款，這筆分潤紀錄卻可能遺失——沒有其他地方會
      // 保留這筆待結算的原始資料，所以至少留在 log 裡供人工回補。
      console.error(`[ledger] enqueue 失敗，entry 可能遺失：${JSON.stringify(entry)}`, err);
    }
  }
  // `settled` 語意變更：現在代表「已排入結算佇列」，不代表已上鏈。
  // 見 docs/KNOWN_LIMITATIONS.md §14。
  const body = (await res.clone().json()) as Record<string, unknown>;
  const headers = new Headers(res.headers);
  return new Response(JSON.stringify({ ...body, settled: queued, settleError }), {
    status: res.status,
    headers,
  });
}

// /signals/:trader 付款前的「已註冊」檢查結果快取（有上界；5 分鐘）。
const REGISTRY_CACHE_TTL_MS = 5 * 60_000;
const registryCache = new LruCache<{ at: number; registered: boolean }>(1_000);

/** 預設：讀鏈上 StrategyRegistry.traders(addr).isRegistered，結果快取 5 分鐘。 */
async function isRegisteredOnchain(trader: string): Promise<boolean> {
  const key = trader.toLowerCase();
  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < REGISTRY_CACHE_TTL_MS) return hit.registered;
  const t = (await contracts.registry.traders(trader)) as { isRegistered: boolean } & unknown[];
  const registered = Boolean(t?.isRegistered ?? t?.[0]);
  registryCache.set(key, { at: Date.now(), registered });
  return registered;
}

export interface CreateAppOptions {
  /** 覆寫 payTo（測試用；正式環境一律走 PAY_TO env）。 */
  payTo?: string;
  /** 覆寫 payTo 安全檢查用的 getCode 來源（測試用；預設是 app 的 provider）。 */
  payoutCodeReader?: CodeReader;
  /** 覆寫「trader 是否已註冊」的查詢（測試用；預設讀鏈上 StrategyRegistry）。 */
  isRegisteredTrader?: (trader: string) => Promise<boolean>;
  /** 覆寫 /risk/exposure 的鏈上讀取來源（測試用；預設是 app 的 provider）。 */
  exposureReader?: ExposureReader;
  /** 覆寫 x402 協定版本（測試用；正式環境一律走 X402_PROTOCOL env，預設 v1）。 */
  x402Protocol?: X402Protocol;
  /** 覆寫 v2 的 facilitator client（測試用；預設是 X402_FACILITATOR_URL 的 HTTP client）。 */
  x402FacilitatorClient?: FacilitatorClient;
  /** 覆寫 X402_NETWORK（測試用）。 */
  x402Network?: string;
  /** 覆寫 v2 付費牆的時鐘、計時器、退避與逾時（測試用）。 */
  x402V2Timing?: Pick<X402V2Options, "now" | "timer" | "initBackoffMs" | "unpaidInitTimeoutMs" | "initTimeoutMs">;
  /** 覆寫 /signals/:trader 的資料來源（測試用；預設讀鏈上 getTraderPerformance）。 */
  signalReader?: (trader: string) => Promise<unknown>;
}

/** /risk/exposure 讀的合約：全部來自 addresses.ts（前端同源），不寫死。 */
export function exposureTargets(): ExposureTargets {
  return {
    chainId: AGENT_CHAIN_ID,
    exchange: ADDRESSES.PerpetualExchange,
    mockOracle: ADDRESSES.MockOracle,
    guardedOracle: V2_ADDRESSES?.GuardedOracle ?? null,
    insuranceVaultFallback: ADDRESSES.InsuranceVault,
    assetVaultV2: V2_ADDRESSES?.AssetVaultV2 ?? null,
    assets: { ...ASSET_IDS },
  };
}

/**
 * 路由用的正規化路徑（2026-09-29 審查 High-1）。
 *
 * x402 的 findMatchingRoute 以**不分大小寫**的 regex 比對、先 decodeURIComponent、
 * 並把連續的 `/` 合併；Hono 預設的路由卻是分大小寫、不合併 `//`。於是
 * `/SIGNALS/0x…`、`//signals/…` 會繞過所有 `app.use("/signals/*")` 閘門（輸入驗證、
 * payTo、registry），卻仍被 x402 當成付費路由發出 402。這裡讓 Hono 看到的路徑與
 * x402 一致：合併 `//`、去掉結尾 `/`、第一段轉小寫（第二段保留原樣——資產代號
 * `sBTC` 分大小寫）。
 */
export function normalizeRequestPath(req: Request): string {
  const url = req.url;
  const start = url.indexOf("/", url.indexOf("://") + 3);
  let path = start === -1 ? "/" : url.slice(start);
  path = path.split(/[?#]/)[0] ?? "/";
  // 與 x402 相同：一次做完 decodeURIComponent（%2F → /）。解不開（例如 /%zz）→ 哨兵
  // 路徑，由最前面的 middleware 回 400。解完仍含 `%`（例如 %25zz → %zz）也當成無效：
  // 下游若再解碼一次，各層看到的路徑就會不一致——正是路徑繞過的根源。
  try {
    path = decodeURIComponent(path);
  } catch {
    return INVALID_PATH;
  }
  if (path.includes("%")) return INVALID_PATH;
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path.replace(/^\/([^/]+)/, (_m, seg: string) => `/${seg.toLowerCase()}`) || "/";
}

/** 無法解碼的請求路徑（getPath 不能直接回應，改用哨兵路徑交給 middleware 回 400）。 */
const INVALID_PATH = "/__invalid_path__";

/** 付費端點實際存在的 handler 路徑（正規化後）。 */
const PAID_HANDLER_PATHS = [/^\/signals\/[^/]+$/, /^\/oracle\/[^/]+$/];

/** x402 付費路由（付費牆與「是否為付費路由」的判斷共用同一份設定）。 */
function paidRoutes() {
  return {
    "GET /signals/[trader]": {
      price: `$${PRICE_SIGNALS}`,
      network: NETWORK,
      config: { description: "Trader 即時績效摘要 + 開倉建議", maxTimeoutSeconds: MAX_TIMEOUT_SECONDS },
    },
    "GET /oracle/[asset]": {
      price: `$${PRICE_ORACLE}`,
      network: NETWORK,
      config: {
        description: "決策級快照：價格 + funding + OI 失衡 + 預估清算價 + edge 建議",
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
    },
  };
}

/** 對外錯誤：完整錯誤只寫 log（可能含 RPC URL / API key），回應只給原因代碼。 */
function internalError(where: string, err: unknown): string {
  console.error(`[${where}]`, err);
  return `${where}_unavailable`;
}

export function createApp(opts: CreateAppOptions = {}): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>({ getPath: normalizeRequestPath });
  checkPayoutDenylistEnv();
  const PAID_ROUTE_PATTERNS = computeRoutePatterns(paidRoutes());

  // ── 對外回應的秘密遮蔽（審查 Medium-3）：最外層，涵蓋所有路由。────────────
  // 個別 catch 已改成只回原因代碼；這一層是安全網——例如 ERC-8126 驗證結果的
  // evidence 裡會帶 RPC 錯誤字串（shared/verification.ts），ethers 的錯誤訊息含
  // requestUrl。凡是 JSON 回應，一律把帶憑證的 env 值與 requestUrl 遮掉。
  app.use("*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return;
    const text = await c.res.clone().text();
    const clean = redactSecrets(text);
    if (clean !== text) {
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(clean, { status: c.res.status, headers });
    }
  });
  const payTo = opts.payTo ?? PAY_TO;
  // x402 協定版本。v1（預設）時 x402v2 是 null：下面所有 v2 分支都不會執行，行為與遷移前相同。
  const x402Protocol: X402Protocol = opts.x402Protocol ?? X402_PROTOCOL;
  let x402v2: X402V2Paywall | null = null;
  // v2／both 的付費牆建不起來（例如 X402_NETWORK 沒有對應的 CAIP-2）：不讓整個 app 起不來，
  // 只讓付費端點回 503（免費端點照常），啟動時印一行錯誤。
  let x402v2SetupError: string | null = null;
  if (x402Protocol !== "v1") {
    try {
      x402v2 = createX402V2({
        payTo,
        network: opts.x402Network ?? NETWORK,
        facilitatorUrl: FACILITATOR_URL,
        facilitatorClient: opts.x402FacilitatorClient,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        routes: Object.entries(paidRoutes()).map(([pattern, r]) => ({
          pattern,
          price: r.price,
          description: r.config.description,
        })),
        onFacilitatorFailure: (_c, f) => facilitatorFailureResponse(f),
        // What the handler left for the ledger: if the reconciler later finds the authorization
        // consumed on chain, this is who gets credited and for how much.
        unknownRecordContext: (c) => ({
          ledgerEntry: (c as Context<{ Variables: AppVariables }>).get("ledgerEntry") ?? null,
        }),
        onSettlementUnknown: async (record) => {
          // Full list: the row is persisted to the manual list (not dropped) and the worker
          // raises ::error:: on the overflow counter. Still worth a loud line here.
          if ((await recordUnknownSettlement(record)) === "overflow") {
            console.error("[x402v2] settlement_unknown list full: record persisted to x402:settlement:unknown:manual (reason overflow)");
          }
        },
        ...opts.x402V2Timing,
      });
    } catch (err) {
      x402v2SetupError = (err as { message?: string } | null)?.message ?? String(err);
      console.error(
        `[x402] X402_PROTOCOL=${x402Protocol} 但 v2 付費牆無法建立 → 付費端點一律回 503，免費端點照常：${x402v2SetupError}`,
      );
    }
  }
  const codeReader: CodeReader = opts.payoutCodeReader ?? provider;
  // payTo 必須是 EOA（= FEE_SETTLEMENT_PRIVATE_KEY 的地址）：外洩清單、EIP-7702 委派、
  // 合約（含未設 PAY_TO 時回退的 FeeRouter）一律 unsafe。結果快取 10 分鐘、fail-closed。
  const checkPayTo = (): Promise<PayoutAssessment> =>
    assessPayoutAddress(codeReader, payTo, { requireEoa: true });

  // GET 資料端點對所有來源開放（瀏覽器 demo + 外部 agent 都要用）。
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  // /demo/*（會動用伺服器錢包）額外限制來源。
  // 註：CORS header 只約束瀏覽器讀取回應，擋不住任何非瀏覽器客戶端 —— 所以這裡是
  // 直接**拒絕請求**（403），而不是只把 Access-Control-Allow-Origin 拿掉。
  // 沒有 Origin header 的請求（curl / agent）不受此限，仍受下方的 per-IP 冷卻與
  // 總量硬上限約束。
  app.use("/demo/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const origin = c.req.header("origin")?.replace(/\/$/, "");
    if (origin && !CORS_ALLOWED_ORIGINS.includes(origin)) {
      return c.json({ ok: false, error: `origin 未在白名單內：${origin}` }, 403);
    }
    return next();
  });

  // ── 極簡 liveness（隔離進入點/adapter 問題用，立即回 200） ────────────────
  app.get("/healthz", (c) => c.text("ok"));

  // ── 路徑與方法的前置檢查（複審 5、6）──────────────────────────────────────
  const rawPathOf = (c: Context) => c.req.raw.url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  app.use("*", async (c, next) => {
    if (c.req.path === INVALID_PATH) {
      return c.json({ ok: false, error: "bad_path", message: "請求路徑無法解碼。" }, 400);
    }
    // HEAD 會被 Hono 路由到 GET handler，但 x402 只認 GET——付費路徑上的 HEAD 等於
    // 免費執行 handler。直接 405，不執行 handler。
    if (
      c.req.method === "HEAD" &&
      (PAID_HANDLER_PATHS.some((re) => re.test(c.req.path)) ||
        findMatchingRoute(PAID_ROUTE_PATTERNS, rawPathOf(c), "GET"))
    ) {
      return c.json({ ok: false, error: "method_not_allowed", message: "付費端點只接受 GET。" }, 405, {
        Allow: "GET",
      });
    }
    return next();
  });

  // ── 免費端點節流（healthz 除外，它必須永遠即時回應）──────────────────────
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/healthz") return next();
    // 付費端點由 x402 付款牆自然節流，不重複限流。
    if (p.startsWith("/oracle/") || p.startsWith("/signals/")) return next();
    const { limited, retryAfterSec } = freeRateLimited(clientIp(c));
    if (limited) {
      return c.json(
        { ok: false, error: `rate limited — 每 ${FREE_RATE_WINDOW_MS / 1000}s 上限 ${FREE_RATE_MAX} 次，請 ${retryAfterSec}s 後再試` },
        429,
        { "Retry-After": String(retryAfterSec) },
      );
    }
    return next();
  });

  // ── 免費：可被發現的服務目錄（agent/CLI 先探索） ─────────────────────────
  app.get("/", async (c) => {
    const payToSafety = await checkPayTo();
    return c.json({
      service: "pepelab-signal-api",
      discoverable: true,
      description:
        "Pay-per-call trading signals over x402. The endpoint IS the product — " +
        "any agent with a Base Sepolia USDC wallet can pay and consume directly.",
      network: NETWORK,
      asset: SETTLEMENT_TOKEN,
      payTo,
      payToSafety: {
        safe: payToSafety.safe,
        reason: payToSafety.reason,
        source: payToSafety.source,
        checkedAt: payToSafety.checkedAt ? new Date(payToSafety.checkedAt).toISOString() : null,
        note: payToSafety.safe
          ? undefined
          : "付費端點目前回 503 payto_unsafe，不發出任何 402 付款要求（沒人會付錢進這個地址）。",
      },
      // 誠實描述金流：x402 的付款直接進 payTo，70/20/10 是平台事後另外送的一筆
      // 交易。把兩者寫成同一件事會讓讀者以為買方付的那筆錢就是被分潤的那筆錢。
      revenueModel:
        `x402 付款直接進 payTo（${payTo}），這筆 EIP-3009 交易由 facilitator（${FACILITATOR_URL}）` +
        `送出並支付 gas。70/20/10 分潤是平台另外的一筆 FeeRouter.routeExternalRevenue 交易，` +
        `由結算錢包（FEE_SETTLEMENT_PRIVATE_KEY）送出並支付 gas，累計可於 /revenue 查詢。` +
        `兩者是不同的兩筆交易。` +
        `2026-09-17 起分潤改為非同步：回應裡的 settled 代表「已排入結算佇列」，` +
        `不代表已經上鏈；由單一 worker 定期取出，每筆各送一筆交易` +
        `（見 docs/KNOWN_LIMITATIONS.md §14、docs/COST_MODEL.md）。`,
      endpoints: {
        "GET /signals/:trader": { price: `$${PRICE_SIGNALS}`, paid: true, desc: "trader 績效 + 開倉建議" },
        "GET /oracle/:asset": { price: `$${PRICE_ORACLE}`, paid: true, desc: "決策級快照：價格 / funding / OI 失衡 / 預估清算價 / edge 建議（long·short·no_trade）。與 /signals 一樣：收到款後把分潤記進結算佇列，回應帶 settled（是否成功排入佇列，不代表已上鏈）" },
        "GET /revenue": { price: "free", desc: "鏈上 70/20/10 累計（可選 ?trader=）" },
        "GET /candles/:symbol": {
          price: "free",
          desc:
            "K 線 OHLCV。?interval= 預設 1h，?limit= 預設 300（上限 " +
            `${MAX_LIMIT}）。回應帶 source 出處，圖表須標示。`,
          intervals: INTERVAL_KEYS,
        },
        "GET /benchmarks": {
          price: "free",
          desc:
            "對照指數：S&P 500／黃金／比特幣，同一來源（Yahoo Finance）。" +
            "?date=YYYY-MM-DD 加碼回該日或之前最近一個交易日的收盤。不做模擬保底，" +
            "上游拿不到就在該指數的 error 欄位標明。",
        },
        "GET /risk/exposure": {
          price: "free",
          desc:
            "曝險報表（唯讀）：各資產多空 OI、保險金庫 totalAssets、V2 vault reserveStatus、" +
            "MockOracle／GuardedOracle 價格與年齡（是否一致）、adlEnabled / maxPriceAge / FUNDING_INTERVAL、" +
            "各資產 lastFundingUpdateAt。附 asOfBlock，60 秒快取；讀不到的欄位為 null 並附原因代碼。",
        },
        "GET /agent/:did/verification": { price: "free", desc: "ERC-8126 agent 驗證（ETV/SCV/WAV/WV + 0–100 風險分數，verifier 簽章）" },
        "POST /demo/buy-signal": { price: "free", desc: "訪客試買（免費回訊號；真實 70/20/10 分潤見付費 x402 端點 + /revenue 累計）" },
      },
      example: {
        curl: "curl -s <BASE_URL>/  # discover, then pay with any x402 client",
        node: "see agent/examples/buy-signal.ts (x402-fetch + viem)",
      },
      // 只有啟用 v2 時才出現（v1 模式的回應與遷移前相同）。
      ...(x402v2SetupError
        ? { x402: { protocol: x402Protocol, error: "x402_misconfigured" } }
        : {}),
      ...(x402v2
        ? {
            x402: {
              protocol: x402Protocol,
              versions: x402Protocol === "both" ? [2, 1] : [2],
              network: x402v2.network,
              headers: {
                v2: { required: "PAYMENT-REQUIRED", payment: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE" },
                ...(x402Protocol === "both"
                  ? { v1: { required: "(402 body)", payment: "X-PAYMENT", response: "X-PAYMENT-RESPONSE" } }
                  : {}),
              },
              note:
                "v2 的付款要求在 402 的 PAYMENT-REQUIRED header（base64 JSON）；" +
                "exact／EIP-3009（USDC transferWithAuthorization），不接受 Permit2。" +
                (x402Protocol === "both"
                  ? "同一個請求只能帶一種付款 header（PAYMENT-SIGNATURE 或 X-PAYMENT）。"
                  : "X-PAYMENT（v1）不再被接受。"),
            },
          }
        : {}),
    });
  });

  // ── 免費：鏈上收入（X402 FeeRouter 真實累計） ────────────────────────────
  app.get("/revenue", async (c) => {
    try {
      const trader = c.req.query("trader");
      return c.json(jsonSafe(await getOnchainRevenue(trader)));
    } catch (err) {
      return c.json({ ok: false, error: internalError("revenue", err) }, 502);
    }
  });

  // ── 免費：K 線（OHLCV）──────────────────────────────────────────────────
  //
  // ⚠ 位置有意義：Hono 依註冊順序比對，這條必須留在下面 paymentMiddleware 的
  //   app.use() **之前**，否則會被 x402 付費牆攔下。圖表資料是前端每次載入頁面
  //   都要打的公開資料，不是付費商品。
  app.get("/candles/:symbol", async (c) => {
    try {
      const data = await getCandles(
        c.req.param("symbol"),
        c.req.query("interval") ?? "1h",
        c.req.query("limit"),
        // 往回翻頁：只回早於這個 unix 秒數的蠟燭。省略 = 最新的一段。
        c.req.query("end"),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof UnknownMarketError || err instanceof BadIntervalError) {
        return c.json({ ok: false, error: (err as Error).message }, 400);
      }
      // getCandles 內部有模擬保底，走到這裡代表是預期外的錯誤。
      return c.json({ ok: false, error: internalError("candles", err) }, 502);
    }
  });

  // ── 免費：對照指數（S&P 500／黃金／比特幣）──────────────────────────────
  //
  // Portfolio 頁「你 vs 大盤」與常駐指數列用。位置理由同 /candles：必須留在
  // paymentMiddleware 之前，這是免費公開資料，不是付費商品。
  //
  // 跟 /candles 不同：這裡**不模擬保底**。一個標的失敗只讓那個標的的
  // current/atDate 帶 error，不影響另外兩個；絕不落回假數字（見 benchmarks.ts）。
  app.get("/benchmarks", async (c) => {
    try {
      const data = await getBenchmarks(c.req.query("date"));
      return c.json(data);
    } catch (err) {
      if (err instanceof BadDateError) {
        return c.json({ ok: false, error: (err as Error).message }, 400);
      }
      return c.json({ ok: false, error: internalError("benchmarks", err) }, 502);
    }
  });

  // ── 免費：曝險報表（客戶風控用，唯讀）─────────────────────────────────────
  //
  // 位置理由同 /candles：必須留在 paymentMiddleware 之前。節流走上面的免費端點
  // per-IP 限流；報表本身 60 秒快取（single-flight），讀取失敗的欄位為 null 並在
  // `unavailable` 附原因代碼，不回錯誤原文、不整個 500（見 exposure.ts）。
  const exposure = createExposureService(opts.exposureReader ?? providerReader(provider), exposureTargets());
  app.get("/risk/exposure", async (c) => {
    try {
      const { report, cacheHit, ageSec, ttlSec, remainingSec } = await exposure.get();
      // Cache-Control 與伺服器端這一份的實際剩餘快取時間一致（降級報表 10 秒、正常 60 秒）。
      return c.json(
        jsonSafe({ ...report, cache: { hit: cacheHit, ageSec, ttlSec, remainingSec } }),
        200,
        { "Cache-Control": `public, max-age=${remainingSec}` },
      );
    } catch (err) {
      return c.json({ ok: false, error: internalError("exposure", err) }, 503);
    }
  });

  // ── 免費：ERC-8126 agent 驗證層（對手方/marketplace 可查「這個 agent 可不可信」）──
  app.get("/agent/:did/verification", async (c) => {
    const raw = c.req.param("did");
    let did: string;
    try {
      // 接受 did:pkh 或裸 0x 地址；裸地址轉成 did:pkh。
      did = raw.startsWith("did:") ? raw : agentDid(raw);
      parseDidPkh(did); // 驗證格式；malformed 直接丟錯 → 400（我們自己的訊息，可以回）
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    try {
      const av = await buildAgentVerification({
        did,
        verifier: VERIFIER_WALLET,
        provider,
        apiBaseUrl: resolveApiBaseUrl(c.req.url),
        etvTargets: ETV_TARGETS,
        scvTargets: SCV_TARGETS,
        explorerApiKey:
          process.env.ETHERSCAN_API_KEY?.trim() ||
          process.env.BASESCAN_API_KEY?.trim(),
        paidPath: "/oracle/sBTC",
        // 誠實標示降級：未設 VERIFIER_PRIVATE_KEY 時每個實例一把隨機金鑰，
        // 簽章仍真、但那個 verifier 身分無法被任何人 pin 住。
        verifierEphemeral: VERIFIER_IS_EPHEMERAL,
        // 若伺服器持有的 session key 正好是此 agent，附上持有證明（WV）。
        holderSigner: (() => {
          const s = makeSigner(provider);
          if (!s) return undefined;
          try {
            return ethers.getAddress(s.address) === parseDidPkh(did).address
              ? s
              : undefined;
          } catch {
            return undefined;
          }
        })(),
      });
      return c.json(jsonSafe({ ok: true, verification: av }));
    } catch (err) {
      return c.json({ ok: false, error: internalError("verification", err) }, 502);
    }
  });

  // ── 免費 demo：訪客不需自帶錢包；不付款、不結算，只回真實訊號（原因見下方註解） ──
  app.post("/demo/buy-signal", async (c) => {
    const ip = clientIp(c);
    const now = Date.now();
    pruneIpMap(lastBuyByIp, Math.max(DEMO_COOLDOWN_MS * 10, 600_000));
    const last = lastBuyByIp.get(ip) ?? 0;
    if (now - last < DEMO_COOLDOWN_MS) {
      return c.json(
        { ok: false, error: `rate limited — wait ${Math.ceil((DEMO_COOLDOWN_MS - (now - last)) / 1000)}s` },
        429,
      );
    }
    if (demoBuyCount >= DEMO_MAX_BUYS) {
      return c.json(
        { ok: false, error: "demo spend cap reached — 外部 agent 請自帶錢包經 x402 付費（見 /）" },
        429,
      );
    }
    lastBuyByIp.set(ip, now);
    demoBuyCount += 1;

    try {
      // serverless 關鍵修正：Vercel Node runtime 常已先消化掉 request body，
      // 導致 Hono 的 c.req.json() **永遠 hang**（不 resolve 也不 reject，.catch 救不了）
      // → 整個 function 撐到 30s timeout。這正是 /demo/buy-signal 卡死的真因
      //（GET 端點 /diag、/revenue 不讀 body 故正常）。
      // 解法：body 解析加 1.5s 預算，逾時就當沒帶 body；trader 也接受 ?trader= query。
      const body = (await Promise.race([
        c.req.json().catch(() => ({})),
        new Promise<Record<string, never>>((r) => setTimeout(() => r({}), 1500)),
      ])) as { trader?: string };
      const trader = await resolveTrader(body.trader ?? c.req.query("trader"));
      if (!trader) {
        return c.json(
          {
            ok: false,
            error: "no_demo_trader",
            message:
              "沒有可分析的 trader：請帶 ?trader=0x…，或由營運方設定 DEMO_TRADER_ADDRESS" +
              "（鏈上 StrategyRegistry 目前也沒有已註冊的 trader）。",
          },
          404,
        );
      }
      const signal = await getTraderPerformance(contracts, trader);

      // 免費 demo：**不在請求內做鏈上結算**。理由——鏈上結算要 mint→approve→
      // routeExternalRevenue 最多 3 筆循序 tx，在 serverless 上即使「背景觸發」，
      // 平台仍會等事件圈清空才回應（callbackWaitsForEmptyEventLoop），導致整個
      // function 撐到 30s 上限 → FUNCTION_INVOCATION_TIMEOUT。故 demo 只回訊號，
      // 真實 70/20/10 分潤由「付費 x402 端點」實際結算，累計可於 /revenue 查。
      const settlementTx: string | undefined = undefined;
      const settleError: string | undefined = isSettlementEnabled()
        ? "demo 免費試買不即時結算（避免 serverless 逾時）；真實分潤見付費 x402 端點 + /revenue 鏈上累計"
        : undefined;
      return c.json(
        jsonSafe({
          ok: true,
          paymentInfo: {
            model: "x402 70/20/10 on-chain",
            priceUsd: PRICE_SIGNALS,
            asset: SETTLEMENT_TOKEN,
            note: "demo：免費、不付款、不結算；真實外部 agent 自帶錢包經 x402 付費（見 /）",
          },
          settlementTx,
          settleError,
          trader,
          signal,
        }),
      );
    } catch (err) {
      return c.json({ ok: false, error: internalError("demo_signal", err) }, 502);
    }
  });

  // ── 付費前的新鮮度閘門 ────────────────────────────────────────────────────
  //
  // /oracle/:asset 賣的是價格。當鏈上價格已超過交易所自己的 maxPriceAge 時，
  // 這份資料既不能用來交易（openPosition 會 revert StalePrice），也沒有市場意義。
  // x402 沒有退費機制，所以必須在 402 之前擋下來，而不是收了錢再回一個 isStale:true。
  //
  // 註冊順序有意義：Hono 依序執行 middleware，這一段必須在 paymentMiddleware
  // 之前，否則買方已經付款了。
  //
  // 2026-08-06 的實況：Base Sepolia 的 oracle 已 9.5–44 天未更新，這個端點會用
  // $0.005 賣出 sAAPL $199.15（真實 $311）。
  // ── 付費前的輸入驗證（稽核 四·Medium）──────────────────────────────────────
  //
  // x402 沒有退費機制，所以「這個請求根本不可能成功」必須在 402 之前就回 400。
  // 舊行為：`/oracle/sDOGE` 先付了 $0.005，付款成功後才在 handler 裡 assetIdOf
  // 丟錯回 400 —— 錢已經進了 payTo，買方拿到的是一個錯誤訊息。
  // 註冊順序有意義：這段必須在 paymentMiddleware 之前。
  app.use("/oracle/*", async (c, next) => {
    const asset = c.req.path.split("/")[2] ?? ""; // 已在 normalizeRequestPath 解碼
    if (!asset) {
      return c.json({ ok: false, error: "缺少資產代號，例如 /oracle/sBTC" }, 400);
    }
    if (!(asset in ASSET_IDS)) {
      return c.json(
        {
          ok: false,
          error: `未知資產 "${asset}"`,
          known: Object.keys(ASSET_IDS),
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下（x402 無退費機制）。",
        },
        400,
      );
    }
    return next();
  });

  app.use("/signals/*", async (c, next) => {
    const trader = c.req.path.split("/")[2] ?? ""; // 已在 normalizeRequestPath 解碼
    if (!/^0x[0-9a-fA-F]{40}$/.test(trader)) {
      return c.json(
        {
          ok: false,
          error: `不是合法的 EVM 地址："${trader}"`,
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下（x402 無退費機制）。",
        },
        400,
      );
    }
    if (/^0x0{40}$/.test(trader)) {
      return c.json(
        {
          ok: false,
          error: "trader 不可為零地址（70% 分潤會被送進黑洞）。",
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下。",
        },
        400,
      );
    }
    if (isCompromisedAddress(trader)) {
      return c.json(
        {
          ok: false,
          error: "trader_compromised",
          message: `${trader} 是已知外洩地址，70% 分潤會落到攻擊者手上，不販售。`,
          note: "未付款：在 x402 付費牆之前就被擋下。",
        },
        400,
      );
    }
    return next();
  });

  // ── 付費前的收款地址守門（P0，fail-closed）──────────────────────────────────
  //
  // payTo 被接管（外洩清單、EIP-7702 委派）或不是 EOA 時，**在發出 402 之前**就回
  // 503：402 本身就是「請把錢付到 payTo」的指示，發出去就等於請買方付錢給攻擊者。
  // 註冊順序有意義：必須在 paymentMiddleware 之前，也在任何會打 RPC 的閘門之前。
  const payToGuard = async (c: Context, next: Next) => {
    const a = await checkPayTo();
    if (!a.safe) {
      console.error(`[payto] unsafe payTo=${payTo} source=${a.source} reason=${a.reason}`);
      return c.json(
        {
          ok: false,
          error: "payto_unsafe",
          reason: a.reason,
          payTo,
          note: "未發出付款要求（402）：收款地址未通過安全檢查，請營運方更換 PAY_TO。",
        },
        503,
        { "Retry-After": "600" },
      );
    }
    return next();
  };
  app.use("/signals/*", payToGuard);
  app.use("/oracle/*", payToGuard);

  // ── /signals/:trader 付款前確認 trader 已註冊（2026-09-29 P0）──────────────
  //
  // 以前任何合法地址都能買：付了 $0.01 之後 handler 才發現這個地址根本沒有策略，
  // 70% 分潤還會記給一個不是 trader 的地址。x402 沒有退費——必須在 402 之前擋。
  // 讀不到 registry（RPC 失敗）→ 503、不收錢：無法確認就不該賣。
  const isRegistered = opts.isRegisteredTrader ?? isRegisteredOnchain;
  app.use("/signals/*", async (c, next) => {
    const trader = c.req.path.split("/")[2] ?? "";
    let registered: boolean;
    try {
      registered = await isRegistered(trader);
    } catch (err) {
      console.error(`[registry] traders(${trader}) 失敗：`, err);
      return c.json(
        {
          ok: false,
          error: "registry_unavailable",
          message: `無法確認 ${trader} 是否為已註冊 trader（RPC 暫時無法使用）。`,
          note: "未付款：無法確認就不發出付款要求。",
        },
        503,
      );
    }
    if (!registered) {
      return c.json(
        {
          ok: false,
          error: "trader_not_registered",
          message: `${trader} 不是 StrategyRegistry 上已註冊的 trader，沒有可販售的訊號。`,
          note: "未付款：在 x402 付費牆之前就被擋下（x402 無退費機制）。",
        },
        400,
      );
    }
    return next();
  });

  app.use("/oracle/*", async (c, next) => {
    const asset = c.req.path.split("/")[2];
    if (!asset) return next();
    try {
      const assetId = assetIdOf(asset);
      const [[, updatedAt], maxPriceAge] = await Promise.all([
        contracts.oracle.getPrice(assetId) as Promise<[bigint, bigint]>,
        contracts.perp.maxPriceAge() as Promise<bigint>,
      ]);
      const tf = classifyTradeFreshness({
        updatedAtSec: Number(updatedAt),
        nowSec: Math.floor(Date.now() / 1000),
        maxPriceAgeSec: Number(maxPriceAge),
      });
      if (!tf.fresh) {
        return c.json(
          {
            ok: false,
            error: "price_stale",
            message:
              `${asset} 的鏈上價格已 ${Math.round(tf.ageSec / 3600)} 小時未更新，` +
              `超過交易所的 maxPriceAge（${tf.maxPriceAgeSec} 秒）。此時開倉會 revert ` +
              `StalePrice，故不販售這份快照。`,
            asset,
            ageSec: tf.ageSec,
            maxPriceAgeSec: tf.maxPriceAgeSec,
          },
          503,
        );
      }
    } catch {
      // 讀不到（資產不存在、RPC 抖動）→ 交給下游處理，不要因為監測失敗就擋住服務。
    }
    return next();
  });

  // ── x402 付費牆：保護兩個 GET 端點 ──────────────────────────────────────
  //
  // 包一層是為了 facilitator 本身出錯的情況（見 docs/KNOWN_LIMITATIONS.md §16）。
  // x402-hono 0.5.3 對 /verify 的非 200 回應是直接 throw（`Failed to verify payment:
  // <statusText>`），沒有 catch —— 於是 facilitator 限流時買方拿到的是 Hono 的通用
  // 500，看不出是誰的問題、該不該重試。這裡把它轉成明確的 429 / 502。
  const x402 = paymentMiddleware(
    payTo as `0x${string}`,
    paidRoutes(),
    { url: FACILITATOR_URL as `${string}://${string}` },
  );
  /**
   * v1 付費牆（x402-hono 0.5.3）＋ facilitator 錯誤對應＋記帳。**內容與遷移前逐行相同**，
   * 只是從 app.use 的 callback 抽成具名函式，讓 both 模式可以依付款 header 分流。
   */
  const runV1 = async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    let res: Response | void;
    try {
      // 必須接住回傳值：付費牆在 402 時是 **return** 一個 Response，不是寫進 c.res。
      res = await x402(c, next);
    } catch (err) {
      const f = classifyFacilitatorFailure((err as Error)?.message);
      if (!f) throw err;
      return c.json(f.body, f.status, f.headers);
    }
    if (res) c.res = res;
    // facilitator 以 200 + isValid:false 回報限流（CDP 的 `rate_limit_exceeded`
    // 就是這個形狀）時，x402-hono 會把 invalidReason 原樣塞進 402 的 error。
    // 402 對 x402 client 的意思是「請付款」，會讓它對一個根本沒問題的簽章重簽重送。
    if (c.res.status === 402 && c.req.header("X-PAYMENT")) {
      const body = (await c.res.clone().json().catch(() => null)) as { error?: unknown } | null;
      const f = typeof body?.error === "string" ? classifyFacilitatorFailure(body.error) : null;
      if (f?.status === 429) c.res = c.json(f.body, f.status, f.headers);
    }

    // ── 優先序 1：記帳，不結算 ──────────────────────────────────────────────
    //
    // handler 只在 c.set("ledgerEntry", …) 留下「這筆該分潤多少」；handler 執行時
    // facilitator 的 /settle 還沒發生（x402-hono 先 next() 再 settle），所以這裡
    // 才是第一個知道「錢真的收到了沒有」的地方——`X-PAYMENT-RESPONSE` header 只有
    // facilitator settle 成功時才會被設定。settle 失敗時 x402-hono 會把 c.res 整個
    // 換成 402，這個 middleware 看到的 res 就不會帶那個 header，也就不會走進這裡
    // ——買方沒被扣款，我們就不能記一筆分潤（這正是舊版「先記帳後結算失敗」那個
    // 順序問題的修法：把「記帳」的時間點往後移到「確定收到錢」之後）。
    c.res = await applyLedgerRecording(c.get("ledgerEntry"), c.res, c.req.header("X-PAYMENT"));
  };

  /**
   * v2 付費牆（@x402/core 2.28，見 x402v2.ts）＋記帳。facilitator 錯誤對應在 x402v2.handle 內
   * 完成（429 facilitator_rate_limited／502 facilitator_unavailable）；記帳時間點與 v1 相同：
   * 只有回應帶結算成功的 `PAYMENT-RESPONSE` 才入列。
   */
  const runV2 = async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const res = await x402v2!.handle(c, next);
    if (res) c.res = res;
    c.res = await applyLedgerRecording(c.get("ledgerEntry"), c.res, c.req.header("PAYMENT-SIGNATURE"), "v2");
  };

  app.use(async (c, next) => {
    // 縱深防禦（審查 High-1）：不論前面的路徑閘門有沒有被繞過（大小寫、`//`、
    // %2F 編碼…），只要 x402 會把這個請求當成付費路由，就先確認 payTo 安全。
    // 用 x402 自己的 findMatchingRoute，保證判斷與付費牆完全一致。
    // v2 付費牆有自己的比對（以 c.req.path）；啟用時兩邊任一認定為付費路由都要過這一關。
    const paidRoute =
      Boolean(findMatchingRoute(PAID_ROUTE_PATTERNS, rawPathOf(c), c.req.method.toUpperCase())) ||
      Boolean(x402v2?.requiresPayment(c));
    if (paidRoute) {
      // x402 認為是付費路由、但沒有對應的實際 handler（Hono 路徑對不上）→ 付款前 404，
      // 不發 402（否則買方付了錢拿到的是 404）。
      if (!(c.req.method === "GET" && PAID_HANDLER_PATHS.some((re) => re.test(c.req.path)))) {
        return c.json({ ok: false, error: "not_found", note: "未付款：沒有對應的付費端點。" }, 404);
      }
      if (x402v2SetupError) {
        return c.json(
          {
            ok: false,
            error: "x402_misconfigured",
            message: "x402 付費牆設定錯誤（見伺服器啟動 log），付費端點暫停服務。",
            note: "未扣款：沒有發出付款要求。",
          },
          503,
        );
      }
      const blocked = await payToGuard(c, async () => {});
      if (blocked) return blocked;
    }

    // ── 協定分流（docs/ADR-010）──────────────────────────────────────────────
    //   v1（預設）：一律 v1，PAYMENT-SIGNATURE 被忽略 —— 與遷移前完全相同。
    //   v2        ：一律 v2，X-PAYMENT 被忽略（視同未付款，回 v2 的 402）。
    //   both      ：依付款 header 分流；兩個都帶 → 400（只會處理其中一張，另一張授權白簽）。
    //               都沒帶 → v1 的 402（body 不變）再疊上 v2 的 PAYMENT-REQUIRED header。
    if (!x402v2) return runV1(c, next);
    if (x402Protocol === "v2") return runV2(c, next);
    const hasV2 = Boolean(c.req.header("PAYMENT-SIGNATURE"));
    const hasV1 = Boolean(c.req.header("X-PAYMENT"));
    if (paidRoute && hasV2 && hasV1) {
      return c.json(
        {
          ok: false,
          error: "ambiguous_payment_headers",
          message: "同一個請求同時帶了 PAYMENT-SIGNATURE（v2）與 X-PAYMENT（v1）；請只帶一種。",
          note: "未扣款：兩張付款授權都沒有送給 facilitator。",
        },
        400,
      );
    }
    if (hasV2) return runV2(c, next);
    const out = await runV1(c, next);
    if (out) return out;
    if (paidRoute && !hasV1 && c.res.status === 402) {
      // 未付款的 402：v2 的付款要求放在 header（v2 client 先讀 header，v1 client 只讀 body）。
      const v2 = await x402v2.unpaidHeaders(c);
      if ("failure" in v2) {
        // facilitator /supported 拿不到 → 這一次只宣告 v1（v1 client 不該被 v2 的基礎設施拖垮）。
        console.error(`[x402] both：v2 付款要求產生失敗，本次 402 只宣告 v1：${v2.failure.message}`);
      } else {
        const res = new Response(c.res.body, c.res);
        for (const [k, v] of Object.entries(v2.headers)) res.headers.set(k, v);
        c.res = undefined as unknown as Response;
        c.res = res;
      }
    }
  });

  // ── 付費後才會執行到這裡 ─────────────────────────────────────────────────
  //
  // 兩個 handler 都不再上鏈結算：只留下 c.set("ledgerEntry", …)，實際記帳（推進
  // Upstash 佇列）與是否成功都由上面那個 middleware 在 facilitator settle 確定
  // 成功後處理，並改寫這裡回傳的 JSON 補上 settled/settleError（見上）。
  app.get("/signals/:trader", async (c) => {
    const trader = c.req.param("trader");
    try {
      const perf = opts.signalReader
        ? await opts.signalReader(trader)
        : await getTraderPerformance(contracts, trader);
      c.set("ledgerEntry", {
        trader,
        feeUsd: PRICE_SIGNALS,
        at: Math.floor(Date.now() / 1000),
        source: "signals",
      } satisfies LedgerEntry);
      // settled/settleError 由上層 middleware 補上；這裡先給預設值，避免回應
      // 形狀在 middleware 沒跑到的路徑（理論上不會，防禦性寫法）下缺欄位。
      return c.json(jsonSafe({ ok: true, settled: false, data: perf }));
    } catch (err) {
      // status ≥ 400 → x402-hono 不會 settle，買方不被扣款。
      return c.json({ ok: false, error: internalError("signals", err) }, 400);
    }
  });

  app.get("/oracle/:asset", async (c) => {
    const asset = c.req.param("asset");
    try {
      const snap = await getOracleSnapshot(contracts, asset);
      // 稽核（四·Medium）：/oracle 以前**完全沒有結算** —— 自主 agent 打的正是這個
      // 端點，那筆錢從未進 FeeRouter，而 `GET /` 卻宣稱 70/20/10。現在與 /signals
      // 一致：留下 ledgerEntry，交由 middleware 在確認收到款後記帳。
      //
      // 2026-09-29（P0）：受益人以前是 resolveTrader() —— 沒設 env、registry 又空時
      // 會退回寫死的外洩 deployer 地址。現在只認 ORACLE_BENEFICIARY_ADDRESS；
      // 沒設就不排入分潤，並在回應與 log 裡講清楚（款項仍在 payTo，未分配）。
      const beneficiary = resolveOracleBeneficiary();
      if (!("address" in beneficiary)) {
        console.warn(`[oracle] 不排入分潤：${beneficiary.reason}`);
        return c.json(
          jsonSafe({ ok: true, settled: false, settleError: beneficiary.reason, data: snap }),
        );
      }
      c.set("ledgerEntry", {
        trader: beneficiary.address,
        feeUsd: PRICE_ORACLE,
        at: Math.floor(Date.now() / 1000),
        source: "oracle",
      } satisfies LedgerEntry);
      return c.json(jsonSafe({ ok: true, settled: false, data: snap }));
    } catch (err) {
      // status ≥ 400 → x402-hono 不會 settle，買方不被扣款。
      return c.json({ ok: false, error: internalError("oracle", err) }, 400);
    }
  });

  return app;
}

export const config = { PAY_TO, NETWORK, FACILITATOR_URL, SETTLEMENT_TOKEN, isSettlementEnabled, isOnchainRevenueEnabled };
