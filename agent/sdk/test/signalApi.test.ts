// signal-api client：逾時、重試（只對冪等 GET）、型別化錯誤、x402 付款流程與上限。
// 完全離線（假 fetch），不付任何錢、不簽任何東西（payment client 是假的）。
//   cd agent && npx tsx sdk/test/signalApi.test.ts
import assert from "node:assert";

import {
  DEFAULT_MAX_PAYMENT_ATOMIC,
  DEFAULT_MAX_TOTAL_SPEND_ATOMIC,
  PaymentLimitExceededError,
  PaymentOutcomeUnknownError,
  PaymentRejectedError,
  PaymentRequiredError,
  PaymentSignTimeoutError,
  PayToUnsafeError,
  PriceStaleError,
  RateLimitedError,
  ServiceUnavailableError,
  SignalApiClient,
  SignalApiError,
  SignalApiNetworkError,
  SignalApiTimeoutError,
  decodePaymentSignature,
  generatePaymentId,
  isValidPaymentId,
  type PaymentRequirements,
  type PaymentRequirementsV2,
  type SignalApiClientConfig,
  type X402PaymentClient,
  type X402PaymentClientV2,
  type X402PaymentRequiredV2,
} from "../src/index.ts";
import { OFFICIAL_BASE_SEPOLIA_USDC } from "../../shared/src/env.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const BASE = "https://api.test";
const PAY_TO = "0x1234567890123456789012345678901234567890";
const TRADER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

type Step = Response | Error | "hang";
interface Call {
  url: string;
  headers: Headers;
}

/** 依序回應 steps 的假 fetch；記錄每次請求。 */
function fakeFetch(steps: Step[]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const s = steps.shift();
    if (s === undefined) throw new Error("fakeFetch：沒有更多預設回應");
    if (s === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (s instanceof Error) throw s;
    return s;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const req = (o: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "5000",
  resource: `${BASE}/oracle/sBTC`,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  asset: OFFICIAL_BASE_SEPOLIA_USDC,
  ...o,
});
const r402 = (accepts: PaymentRequirements[] = [req()]) =>
  json(402, { error: "X-PAYMENT header is required", accepts, x402Version: 1 });
const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;
interface XPayOverrides {
  x402Version?: number;
  scheme?: string;
  network?: string;
  to?: string;
  validBefore?: string;
}
/** x402 0.5.3 exact／EVM 格式的 X-PAYMENT（簽章為假值；SDK 不驗簽，那是 facilitator 的事）。 */
const xPayment = (value: string, o: XPayOverrides = {}) =>
  Buffer.from(
    JSON.stringify({
      x402Version: o.x402Version ?? 1,
      scheme: o.scheme ?? "exact",
      network: o.network ?? "base-sepolia",
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: {
          from: "0x" + "fe".repeat(20),
          to: o.to ?? PAY_TO,
          value,
          validAfter: String(NOW_S - 600),
          validBefore: o.validBefore ?? String(NOW_S + 60),
          nonce: "0x" + "01".repeat(32),
        },
      },
    }),
  ).toString("base64");

/** 假 payment client：記錄被呼叫的參數，回傳指定金額的 X-PAYMENT。 */
function fakePayment(value = "5000", o: XPayOverrides = {}) {
  const seen: Parameters<X402PaymentClient["createPaymentHeader"]>[0][] = [];
  const client: X402PaymentClient = {
    async createPaymentHeader(args) {
      seen.push(args);
      return xPayment(value, o);
    },
  };
  return { client, seen };
}

const sleeps: number[] = [];
const mk = (steps: Step[], extra: Partial<SignalApiClientConfig> = {}) => {
  const f = fakeFetch(steps);
  sleeps.length = 0;
  const api = new SignalApiClient({
    baseUrl: BASE + "/",
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    now: () => NOW_MS,
    ...extra,
  });
  return { api, calls: f.calls };
};

// 1) 預設上限沿用 agent 的 x402 client
assert.equal(DEFAULT_MAX_PAYMENT_ATOMIC, 20_000n, "0.02 USDC");
assert.equal(DEFAULT_MAX_TOTAL_SPEND_ATOMIC, 1_000_000n, "1 USDC");
assert.throws(() => new SignalApiClient({ baseUrl: BASE, maxPaymentAtomic: 0n }), /> 0/);
assert.throws(() => new SignalApiClient({} as SignalApiClientConfig), /baseUrl/, "baseUrl 必填（審查 L3）");
assert.throws(() => new SignalApiClient({ baseUrl: "ftp://x" }), /baseUrl/);
assert.throws(() => new SignalApiClient({ baseUrl: BASE, expectedNetwork: "base" }), /同時設定/, "network 與 asset 必須同時設定（審查 L4）");
assert.throws(() => new SignalApiClient({ baseUrl: BASE, expectedAsset: OFFICIAL_BASE_SEPOLIA_USDC }), /同時設定/);
assert.throws(() => new SignalApiClient({ baseUrl: BASE, expectedNetwork: "base", expectedAsset: "nope" }), /合法地址/);
ok("預設單筆 0.02 USDC、累計 1 USDC；0 上限拒絕；baseUrl 必填；network／asset 必須成對");

// 2) 免費端點：URL 組裝、Accept、healthz 純文字
{
  const { api, calls } = mk([
    json(200, { ok: true, symbol: "sBTC", candles: [] }),
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
  ]);
  const c = await api.getCandles("sBTC", { interval: "1h", limit: 2 });
  assert.equal(c.symbol, "sBTC");
  assert.equal(calls[0]!.url, `${BASE}/candles/sBTC?interval=1h&limit=2`);
  assert.equal(calls[0]!.headers.get("accept"), "application/json");
  assert.equal(await api.healthz(), "ok");
  ok("免費端點：URL／query 組裝、Accept: application/json、healthz 純文字");
}

// 3) 重試：502、網路錯誤 → 最後成功；指數退避
{
  const { api, calls } = mk([json(502, { ok: false, error: "revenue_unavailable" }), new TypeError("fetch failed"), json(200, { model: "x", onChain: false, totals: {} })]);
  const r = await api.getRevenue({ trader: TRADER });
  assert.equal(r.onChain, false);
  assert.equal(calls.length, 3);
  assert.ok(calls[0]!.url.endsWith(`/revenue?trader=${TRADER}`));
  assert.deepEqual(sleeps, [225, 450], "300ms × 2^attempt × (0.5 + random/2)，random=0.5");
  ok("GET 在 502／網路錯誤時重試，最後成功");
}

// 4) 重試用盡 → 型別化錯誤
{
  const { api, calls } = mk([json(503, { ok: false, error: "exposure_unavailable" }), json(503, { ok: false, error: "exposure_unavailable" }), json(503, { ok: false, error: "exposure_unavailable" })]);
  await assert.rejects(api.getRiskExposure(), (e: unknown) => e instanceof ServiceUnavailableError && e.code === "exposure_unavailable" && e.status === 503);
  assert.equal(calls.length, 3, "1 + retries(2)");
  const t = mk(["hang", "hang"], { timeoutMs: 20, retry: { retries: 1 } });
  await assert.rejects(t.api.discover(), SignalApiTimeoutError);
  assert.equal(t.calls.length, 2);
  const net = mk([new TypeError("ECONNRESET")], { retry: { retries: 0 } });
  await assert.rejects(net.api.discover(), SignalApiNetworkError);
  ok("重試用盡：503 → ServiceUnavailableError；逾時 → SignalApiTimeoutError；連線 → SignalApiNetworkError");
}

// 5) 429：Retry-After 短 → 等待後重試；長 → 直接丟 RateLimitedError
{
  const a = mk([json(429, { ok: false, error: "rate_limited" }, { "retry-after": "2" }), json(200, { ok: true })]);
  await a.api.getBenchmarks({ date: "2026-09-01" });
  assert.deepEqual(sleeps, [2000], "照 Retry-After 等");
  assert.ok(a.calls[0]!.url.endsWith("/benchmarks?date=2026-09-01"));
  const b = mk([json(429, { ok: false, error: "rate_limited" }, { "retry-after": "600" })]);
  await assert.rejects(b.api.discover(), (e: unknown) => e instanceof RateLimitedError && e.retryAfterSec === 600);
  assert.equal(b.calls.length, 1);
  assert.throws(() => a.api.getBenchmarks({ date: "2026/09/01" }), TypeError);
  ok("429：短 Retry-After 等待重試、長的直接丟 RateLimitedError(retryAfterSec)");
}

// 6) 付費端點的付款前守門錯誤：不重試、不呼叫 payment client
{
  const pay = fakePayment();
  const a = mk(
    [json(503, { ok: false, error: "payto_unsafe", reason: "compromised", payTo: PAY_TO }, { "retry-after": "600" })],
    { payment: pay.client },
  );
  await assert.rejects(a.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PayToUnsafeError && e.payTo === PAY_TO && e.retryAfterSec === 600);
  assert.equal(a.calls.length, 1, "payto_unsafe 不重試");
  const b = mk([json(503, { ok: false, error: "price_stale", asset: "sBTC", ageSec: 30000, maxPriceAgeSec: 21600 })], { payment: pay.client });
  await assert.rejects(b.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PriceStaleError && e.ageSec === 30000);
  assert.equal(b.calls.length, 1, "price_stale 不重試");
  const c = mk([json(400, { ok: false, error: "trader_not_registered" })], { payment: pay.client });
  await assert.rejects(c.api.getSignal(TRADER), (e: unknown) => e instanceof SignalApiError && e.status === 400 && e.code === "trader_not_registered");
  assert.equal(pay.seen.length, 0, "守門錯誤時從未要求簽署");
  assert.throws(() => c.api.getSignal("0x123"), TypeError);
  ok("payto_unsafe／price_stale／400：型別化錯誤、不重試、不簽署");
}

// 7) 沒有 payment client → PaymentRequiredError（不付款）
{
  const { api } = mk([r402()]);
  await assert.rejects(api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentRequiredError && !e.afterPayment && e.accepts.length === 1 && e.x402Version === 1);
  ok("未注入 payment client：402 → PaymentRequiredError（附 accepts）");
}

// 8) 正常付款流程
{
  const pay = fakePayment("5000");
  const settlement = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc" })).toString("base64");
  const { api, calls } = mk(
    [r402([req({ maxAmountRequired: "9000", payTo: "0x9999999999999999999999999999999999999999", network: "base" }), req()]),
     json(200, { ok: true, settled: true, data: { asset: "sBTC", price: 60000 } }, { "x-payment-response": settlement })],
    { payment: pay.client },
  );
  const r = await api.getOracleSnapshot("sBTC");
  assert.equal(r.body.data.price, 60000);
  assert.equal(pay.seen.length, 1);
  assert.equal(pay.seen[0]!.requirements.network, "base-sepolia", "只挑符合網路的要求");
  assert.equal(pay.seen[0]!.maxValueAtomic, 20_000n);
  assert.equal(pay.seen[0]!.resource, `${BASE}/oracle/sBTC`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.get("x-payment"), null, "第一次不帶付款");
  assert.equal(calls[1]!.headers.get("x-payment"), xPayment("5000"));
  assert.equal(r.payment!.paidAtomic, 5000n);
  assert.equal(r.payment!.paidUsdc, "0.005");
  assert.deepEqual(r.payment!.settlement, { success: true, transaction: "0xabc" });
  assert.equal(api.spentAtomic(), 5000n);
  ok("付款流程：挑選正確的付款要求 → 呼叫端簽 → 帶 X-PAYMENT 送一次 → 記帳與結算證明");
}

// 9) 上限：單筆超過、累計超過、簽出金額大於要求 —— 都在送出前擋下
{
  const pay = fakePayment();
  const a = mk([r402([req({ maxAmountRequired: "30000" })])], { payment: pay.client });
  await assert.rejects(a.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentLimitExceededError && e.kind === "per-request" && e.requiredAtomic === 30_000n);
  assert.equal(pay.seen.length, 0, "超過上限：不要求簽署");
  assert.equal(a.calls.length, 1);

  const twice = mk(
    [r402(), json(200, { ok: true, settled: true, data: {} }), r402()],
    { payment: pay.client, maxTotalSpendAtomic: 8_000n },
  );
  await twice.api.getOracleSnapshot("sBTC");
  await assert.rejects(twice.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentLimitExceededError && e.kind === "total");
  assert.equal(twice.api.spentAtomic(), 5000n);
  assert.equal(twice.calls.length, 3);

  const greedy = fakePayment("9000");
  const g = mk([r402()], { payment: greedy.client });
  await assert.rejects(g.api.getOracleSnapshot("sBTC"), PaymentLimitExceededError);
  assert.equal(g.calls.length, 1, "簽出金額 > 要求：不送出");
  const garbage: X402PaymentClient = { createPaymentHeader: async () => "not-base64-json" };
  const gg = mk([r402()], { payment: garbage });
  await assert.rejects(gg.api.getOracleSnapshot("sBTC"), PaymentRejectedError);
  assert.equal(gg.calls.length, 1);
  ok("單筆上限、累計上限、簽出金額 > 要求、無法解析的 X-PAYMENT：全部在送出前擋下");
}

// 10) 付款要求不符：網路、幣別、payTo 白名單
{
  const pay = fakePayment();
  for (const bad of [req({ network: "base" }), req({ asset: "0x" + "11".repeat(20) }), req({ scheme: "upto" as "exact" }), req({ maxAmountRequired: "1e3" })]) {
    const { api } = mk([r402([bad])], { payment: pay.client });
    await assert.rejects(api.getOracleSnapshot("sBTC"), PaymentRejectedError);
  }
  const { api } = mk([r402()], { payment: pay.client, payToAllowlist: ["0x" + "22".repeat(20)] });
  await assert.rejects(api.getOracleSnapshot("sBTC"), /白名單/);
  assert.equal(pay.seen.length, 0);
  assert.throws(() => new SignalApiClient({ baseUrl: BASE, payToAllowlist: ["nope"] }), /非法地址/);
  ok("付款要求的網路／幣別／scheme／金額格式／payTo 白名單不符 → PaymentRejectedError，未簽署");
}

// 11) 帶了付款的請求永不重試
{
  const pay = fakePayment();
  const a = mk([r402(), new TypeError("socket hang up")], { payment: pay.client });
  await assert.rejects(a.api.getSignal(TRADER), (e: unknown) => e instanceof PaymentOutcomeUnknownError && e.signedAtomic === 5000n);
  assert.equal(a.calls.length, 2, "付款請求失敗不重試");
  const t = mk([r402(), "hang"], { payment: pay.client, timeoutMs: 20 });
  await assert.rejects(t.api.getSignal(TRADER), PaymentOutcomeUnknownError);
  assert.equal(t.calls.length, 2);
  const b = mk([r402(), json(502, { ok: false, error: "facilitator_unavailable", note: "x", facilitator: "https://x402.org/facilitator" })], { payment: pay.client });
  await assert.rejects(b.api.getSignal(TRADER), ServiceUnavailableError);
  assert.equal(b.calls.length, 2, "付款後 502 不重試");
  assert.equal(b.api.spentAtomic(), 5000n, "授權已送出 → 保留記帳（審查 H1）");
  assert.equal(b.api.unsettledAtomic(), 5000n, "沒有結算證明 → 記為 unsettled");
  const c = mk([r402(), json(402, { error: "invalid_payment", accepts: [req()], x402Version: 1 })], { payment: pay.client });
  await assert.rejects(c.api.getSignal(TRADER), (e: unknown) => e instanceof PaymentRequiredError && e.afterPayment);
  assert.equal(c.calls.length, 2);
  const d = mk([r402(), json(429, { ok: false, error: "facilitator_rate_limited", note: "x", facilitator: "f" }, { "retry-after": "5" })], { payment: pay.client });
  await assert.rejects(d.api.getSignal(TRADER), (e: unknown) => e instanceof RateLimitedError && e.retryAfterSec === 5);
  assert.equal(d.calls.length, 2, "付款後 429 也不自動重試");
  ok("帶 X-PAYMENT 的請求：網路錯誤／逾時 → PaymentOutcomeUnknownError；502／402／429 皆不重試");
}

// 12) 付款探測那一趟（尚未付款）可以重試
{
  const pay = fakePayment();
  const { api, calls } = mk([json(502, { ok: false, error: "x" }), r402(), json(200, { ok: true, settled: false, data: {} })], { payment: pay.client });
  const r = await api.getSignal(TRADER);
  assert.equal(r.body.settled, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[1]!.headers.get("x-payment"), null);
  ok("付款前的探測請求（沒帶 X-PAYMENT）照常重試");
}

// ── 審查 PR #201 的修正 ─────────────────────────────────────────────────────

/** 只在帶 X-PAYMENT 時延遲回應的假 fetch（模擬並行請求在付款途中交錯）。 */
function payingFetch(paidResponse: () => Response | Error, delayMs = 20) {
  let sent = 0;
  const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get("x-payment")) {
      sent++;
      await new Promise((r) => setTimeout(r, delayMs));
      const r = paidResponse();
      if (r instanceof Error) throw r;
      return r;
    }
    return r402();
  }) as typeof globalThis.fetch;
  return { fetch, sent: () => sent };
}

// 13) H1：並行請求不能一起穿過累計上限（PoC3）
{
  const pay = fakePayment();
  const f = payingFetch(() => json(200, { ok: true, settled: true, data: {} }, { "x-payment-response": "e30=" }));
  const api = new SignalApiClient({ baseUrl: BASE, fetch: f.fetch, payment: pay.client, maxTotalSpendAtomic: 5_000n, now: () => NOW_MS });
  const rs = await Promise.allSettled([api.getOracleSnapshot("sBTC"), api.getOracleSnapshot("sBTC"), api.getOracleSnapshot("sBTC")]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of rs) {
    if (r.status === "rejected") assert.ok(r.reason instanceof PaymentLimitExceededError && r.reason.kind === "total");
  }
  assert.equal(pay.seen.length, 1, "只簽一次");
  assert.equal(f.sent(), 1, "只送出一張授權");
  assert.equal(api.spentAtomic(), 5_000n);
  assert.equal(api.unsettledAtomic(), 0n, "有結算證明");
  ok("H1：3 筆並行、累計上限 5000 → 只簽出並送出 1 筆，其餘在簽署前被擋");
}

// 14) H1：付款後失敗（502／逾時／402）仍記帳 → 不能無限重簽（PoC3c）
{
  const pay = fakePayment();
  const f = payingFetch(() => json(502, { ok: false, error: "facilitator_unavailable", note: "", facilitator: "" }));
  const api = new SignalApiClient({ baseUrl: BASE, fetch: f.fetch, payment: pay.client, maxTotalSpendAtomic: 5_000n, now: () => NOW_MS });
  const errs: unknown[] = [];
  for (let i = 0; i < 5; i++) await api.getOracleSnapshot("sBTC").catch((e) => errs.push(e));
  assert.equal(f.sent(), 1, "5 次呼叫只有第 1 次送出授權");
  assert.ok(errs[0] instanceof ServiceUnavailableError && (errs[0] as ServiceUnavailableError).paymentSent);
  for (const e of errs.slice(1)) assert.ok(e instanceof PaymentLimitExceededError && e.paymentSent === false);
  assert.equal(api.spentAtomic(), 5_000n);
  assert.equal(api.unsettledAtomic(), 5_000n);

  const t = payingFetch(() => new TypeError("socket hang up"));
  const api2 = new SignalApiClient({ baseUrl: BASE, fetch: t.fetch, payment: pay.client, maxTotalSpendAtomic: 9_000n, now: () => NOW_MS });
  await assert.rejects(api2.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentOutcomeUnknownError && e.paymentSent);
  await assert.rejects(api2.getOracleSnapshot("sBTC"), PaymentLimitExceededError);
  assert.equal(t.sent(), 1);
  assert.equal(api2.unsettledAtomic(), 5_000n, "結果不明也算 unsettled");
  ok("H1：付款後 502／網路錯誤仍保留記帳並記為 unsettled，不能繞過累計上限重簽");
}

// 15) H1：確定沒送出時回滾預留（簽署失敗、簽出內容不符）
{
  const boom: X402PaymentClient = { createPaymentHeader: async () => { throw new Error("HSM offline"); } };
  const a = mk([r402()], { payment: boom, maxTotalSpendAtomic: 5_000n });
  await assert.rejects(a.api.getOracleSnapshot("sBTC"), /HSM offline/);
  assert.equal(a.api.spentAtomic(), 0n, "簽署失敗 → 回滾");
  const bad = fakePayment("5000", { to: "0x" + "99".repeat(20) });
  const b = mk([r402(), r402()], { payment: bad.client, maxTotalSpendAtomic: 5_000n });
  await assert.rejects(b.api.getOracleSnapshot("sBTC"), PaymentRejectedError);
  await assert.rejects(b.api.getOracleSnapshot("sBTC"), PaymentRejectedError, "回滾後同一筆預留可再用（第二次仍因內容不符被擋，而不是被累計上限擋）");
  assert.equal(b.api.spentAtomic(), 0n);
  assert.equal(b.calls.length, 2, "兩次都沒送出 X-PAYMENT");
  const cheap = fakePayment("3000");
  const c = mk([r402(), json(200, { ok: true, settled: true, data: {} }, { "x-payment-response": "e30=" })], { payment: cheap.client });
  const r = await c.api.getOracleSnapshot("sBTC");
  assert.equal(r.payment!.paidAtomic, 3_000n);
  assert.equal(c.api.spentAtomic(), 3_000n, "預留調整為實際簽出金額");
  ok("H1：簽署失敗或簽出內容不符 → 預留回滾；簽得比要求少 → 記實際金額");
}

// 16) M1：簽出內容必須與付款要求一致（PoC3b）
{
  const cases: [string, XPayOverrides][] = [
    ["收款人 ≠ payTo", { to: "0x9999999999999999999999999999999999999999" }],
    ["scheme", { scheme: "upto" }],
    ["network", { network: "base" }],
    ["x402Version", { x402Version: 2 }],
    ["validBefore 太遠", { validBefore: String(NOW_S + 60 + 61) }],
    ["validBefore 非整數字串", { validBefore: "soon" }],
  ];
  for (const [label, o] of cases) {
    const pay = fakePayment("5000", o);
    const { api, calls } = mk([r402()], { payment: pay.client });
    await assert.rejects(api.getOracleSnapshot("sBTC"), PaymentRejectedError, label);
    assert.equal(calls.length, 1, `${label}：沒有送出`);
    assert.equal(api.spentAtomic(), 0n);
  }
  // 大小寫不同的同一個收款人可以；validBefore 在容忍範圍內可以
  const okPay = fakePayment("5000", { to: PAY_TO.toUpperCase().replace("0X", "0x"), validBefore: String(NOW_S + 60 + 60) });
  const good = mk([r402(), json(200, { ok: true, settled: true, data: {} })], { payment: okPay.client });
  await good.api.getOracleSnapshot("sBTC");
  // maxTimeoutSeconds：必須是 1–300 的整數
  for (const t of [301, 1.5, 0, -1, Number.NaN]) {
    const pay = fakePayment();
    const { api } = mk([r402([req({ maxTimeoutSeconds: t })])], { payment: pay.client });
    await assert.rejects(api.getOracleSnapshot("sBTC"), PaymentRejectedError, `maxTimeoutSeconds=${t}`);
    assert.equal(pay.seen.length, 0);
  }
  ok("M1：收款人／scheme／network／版本／validBefore 不符 → 不送出；maxTimeoutSeconds 限 1–300 整數");
}

// 17) M2：所有付款後的錯誤都標 paymentSent=true；付款前的都是 false
{
  const pay = fakePayment();
  const pre = mk([json(429, { ok: false, error: "rate_limited" }, { "retry-after": "600" })], { payment: pay.client });
  await assert.rejects(pre.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof RateLimitedError && !e.paymentSent);
  const post = mk([r402(), json(429, { ok: false, error: "facilitator_rate_limited", note: "", facilitator: "f" }, { "retry-after": "5" })], { payment: pay.client });
  await assert.rejects(post.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof RateLimitedError && e.paymentSent && /對帳/.test(e.message));
  const p402 = mk([r402(), r402()], { payment: pay.client });
  await assert.rejects(p402.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentRequiredError && e.paymentSent && e.afterPayment);
  const p400 = mk([r402(), json(400, { ok: false, error: "oracle_unavailable" })], { payment: pay.client });
  await assert.rejects(p400.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof SignalApiError && e.status === 400 && e.paymentSent);
  const unpaid = mk([json(503, { ok: false, error: "payto_unsafe", reason: "x", payTo: PAY_TO })], { payment: pay.client });
  await assert.rejects(unpaid.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PayToUnsafeError && !e.paymentSent);
  ok("M2：付款後的 429／402／400 皆 paymentSent=true（訊息提示先對帳）；付款前的為 false");
}

// ── #203 follow-up ──────────────────────────────────────────────────────────

// 18) L-a：簽署端逾時 → 回滾預留；之後才回來的簽章一律丟棄、絕不送出
{
  // 簽署端懸置：回傳一個由測試控制何時 resolve 的 promise（模擬 HSM 遲遲不回應、之後才回）
  let releaseLate!: (h: string) => void;
  let seenSignal: AbortSignal | undefined;
  let signCalls = 0;
  const slow: X402PaymentClient = {
    createPaymentHeader(args) {
      signCalls++;
      seenSignal = args.signal;
      if (signCalls === 1) return new Promise<string>((r) => { releaseLate = r; });
      return Promise.resolve(xPayment("5000"));
    },
  };
  const f = payingFetch(() => json(200, { ok: true, settled: true, data: {} }, { "x-payment-response": "e30=" }));
  const api = new SignalApiClient({
    baseUrl: BASE, fetch: f.fetch, payment: slow, now: () => NOW_MS,
    maxTotalSpendAtomic: 5_000n, // 剛好一筆：沒回滾的話第二筆會被累計上限擋下
    paymentSignTimeoutMs: 30,
  });
  await assert.rejects(
    api.getOracleSnapshot("sBTC"),
    (e: unknown) => e instanceof PaymentSignTimeoutError && e.paymentSent === false && e.timeoutMs === 30 && /丟棄/.test(e.message),
  );
  assert.ok(seenSignal?.aborted, "逾時後 abort 傳給簽署端的 signal");
  assert.equal(api.spentAtomic(), 0n, "逾時 = 未送出 → 預留回滾");
  assert.equal(f.sent(), 0, "逾時當下沒有送出 X-PAYMENT");

  // 簽署端「稍後」才回傳一張完全合法的簽章 → 必須被丟棄
  releaseLate(xPayment("5000"));
  await new Promise((r) => setTimeout(r, 50)); // 給任何可能的後續處理（若有 bug）足夠時間送出
  assert.equal(f.sent(), 0, "逾時後才回來的簽章絕不送出");
  assert.equal(api.spentAtomic(), 0n, "遲到的簽章不會被記帳");
  assert.equal(api.unsettledAtomic(), 0n);

  // 回滾後額度可再用：第二筆正常簽、送出一次
  const r = await api.getOracleSnapshot("sBTC");
  assert.equal(r.payment!.paidAtomic, 5_000n);
  assert.equal(f.sent(), 1, "只有第二筆（準時簽出的）被送出");
  assert.equal(api.spentAtomic(), 5_000n);

  // 逾時後簽署端才「失敗」也不能變成 unhandled rejection
  let rejectLate!: (e: Error) => void;
  const failing: X402PaymentClient = { createPaymentHeader: () => new Promise<string>((_, j) => { rejectLate = j; }) };
  const b = mk([r402()], { payment: failing, paymentSignTimeoutMs: 10 });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  await assert.rejects(b.api.getOracleSnapshot("sBTC"), PaymentSignTimeoutError);
  rejectLate(new Error("HSM 最後還是失敗了"));
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal(b.calls.length, 1, "沒有送出 X-PAYMENT");

  // 沒設定時行為不變（不提供 signal、無限等待）；設定值必須是正整數
  const plain = fakePayment();
  const c = mk([r402(), json(200, { ok: true, settled: true, data: {} })], { payment: plain.client });
  await c.api.getOracleSnapshot("sBTC");
  assert.equal(plain.seen[0]!.signal, undefined);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new SignalApiClient({ baseUrl: BASE, paymentSignTimeoutMs: bad }), /paymentSignTimeoutMs/, String(bad));
  }
  ok("L-a：paymentSignTimeoutMs 逾時 → PaymentSignTimeoutError、預留回滾、signal abort；遲到的簽章丟棄不送出；遲到的失敗不會 unhandled");
}

// 19) Info：SignalApiTimeoutError／SignalApiNetworkError 帶 paymentSent=false
{
  const t = mk(["hang", "hang", "hang"], { timeoutMs: 5 });
  await assert.rejects(t.api.discover(), (e: unknown) => e instanceof SignalApiTimeoutError && e.paymentSent === false);
  const net = mk([new TypeError("ECONNREFUSED"), new TypeError("ECONNREFUSED"), new TypeError("ECONNREFUSED")]);
  await assert.rejects(net.api.discover(), (e: unknown) => e instanceof SignalApiNetworkError && e.paymentSent === false);
  // 付款前探測逾時也是 false（尚未簽任何東西）
  const pay = fakePayment();
  const probe = mk(["hang", "hang", "hang"], { timeoutMs: 5, payment: pay.client });
  await assert.rejects(probe.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof SignalApiTimeoutError && e.paymentSent === false);
  assert.equal(pay.seen.length, 0);
  ok("Info：SignalApiTimeoutError／SignalApiNetworkError 的 paymentSent 一律 false（帶付款的逾時改丟 PaymentOutcomeUnknownError）");
}

// 20) Info：releaseUnsettled 只減少 unsettled，不減少 spent → 不能用來繞過累計上限
{
  const pay = fakePayment();
  const f = payingFetch(() => json(502, { ok: false, error: "facilitator_unavailable", note: "", facilitator: "" }));
  const api = new SignalApiClient({ baseUrl: BASE, fetch: f.fetch, payment: pay.client, maxTotalSpendAtomic: 10_000n, now: () => NOW_MS });
  await assert.rejects(api.getOracleSnapshot("sBTC"), ServiceUnavailableError);
  await assert.rejects(api.getOracleSnapshot("sBTC"), ServiceUnavailableError);
  assert.equal(api.spentAtomic(), 10_000n);
  assert.equal(api.unsettledAtomic(), 10_000n);

  assert.equal(api.releaseUnsettled(4_000n), 6_000n, "回傳釋放後的 unsettled");
  assert.equal(api.unsettledAtomic(), 6_000n);
  assert.equal(api.spentAtomic(), 10_000n, "spent 不變");
  assert.equal(api.releaseUnsettled(6_000n), 0n);
  assert.equal(api.spentAtomic(), 10_000n, "全部對帳釋放後 spent 仍不變");

  // 釋放之後仍被累計上限擋下，簽署端沒被呼叫、沒有送出
  const signedBefore = pay.seen.length;
  await assert.rejects(api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentLimitExceededError && e.kind === "total");
  assert.equal(pay.seen.length, signedBefore);
  assert.equal(f.sent(), 2);

  // 不能釋放超過 unsettled、不能是 0／負數／非 bigint（防止把 unsettled 弄成負數或靜默吞錯）
  assert.throws(() => api.releaseUnsettled(1n), RangeError, "unsettled 已是 0");
  for (const bad of [0n, -1n, 5 as unknown as bigint]) assert.throws(() => api.releaseUnsettled(bad), RangeError, String(bad));
  assert.equal(api.unsettledAtomic(), 0n);
  ok("Info：releaseUnsettled 只減少 unsettledAtomic、spentAtomic 不變；釋放後仍被累計上限擋下；超額／非正數拒絕");
}

// ════════════════════════════════════════════════════════════════════════════
// x402 v2（docs/ADR-010）：PAYMENT-REQUIRED／PAYMENT-SIGNATURE／PAYMENT-RESPONSE
// ════════════════════════════════════════════════════════════════════════════
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));
const CAIP2 = "eip155:84532";
const req2 = (o: Partial<PaymentRequirementsV2> = {}): PaymentRequirementsV2 => ({
  scheme: "exact",
  network: CAIP2,
  amount: "5000",
  asset: OFFICIAL_BASE_SEPOLIA_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
  ...o,
});
const PID_DECL = { info: { required: false }, schema: { type: "object" } };
const required2 = (accepts: PaymentRequirementsV2[] = [req2()], withPid = true): X402PaymentRequiredV2 => ({
  x402Version: 2,
  error: "Payment required",
  resource: { url: `${BASE}/oracle/sBTC`, description: "", mimeType: "application/json" },
  accepts,
  ...(withPid ? { extensions: { "payment-identifier": PID_DECL } } : {}),
});
/** v2 的 402：付款要求在 header，body 是 {}（v2 模式）或 v1 的 body（both 模式）。 */
const r402v2 = (pr: X402PaymentRequiredV2 = required2(), v1Body?: unknown) =>
  json(402, v1Body ?? {}, { "payment-required": b64(pr), "cache-control": "no-store" });
interface SigOverrides {
  x402Version?: number;
  accepted?: Partial<PaymentRequirementsV2>;
  to?: string;
  value?: string;
  validBefore?: string;
  permit2?: boolean;
  paymentId?: string;
}
/** @x402/evm exact／EIP-3009 格式的 PAYMENT-SIGNATURE（簽章為假值；SDK 不驗簽）。 */
const paymentSignature = (accepted: PaymentRequirementsV2, o: SigOverrides = {}) =>
  b64({
    x402Version: o.x402Version ?? 2,
    resource: { url: `${BASE}/oracle/sBTC` },
    accepted: { ...accepted, ...o.accepted },
    payload: o.permit2
      ? { signature: "0x" + "ab".repeat(65), permit2Authorization: { permitted: { token: accepted.asset, amount: accepted.amount } } }
      : {
          signature: "0x" + "ab".repeat(65),
          authorization: {
            from: "0x" + "fe".repeat(20),
            to: o.to ?? accepted.payTo,
            value: o.value ?? accepted.amount,
            validAfter: "0",
            validBefore: o.validBefore ?? String(NOW_S + 60),
            nonce: "0x" + "02".repeat(32),
          },
        },
    ...(o.paymentId ? { extensions: { "payment-identifier": { info: { required: false, id: o.paymentId } } } } : {}),
  });
/** 假 v2 payment client：照 SDK 給的 requirements 產生 PAYMENT-SIGNATURE。 */
function fakePaymentV2(o: SigOverrides = {}) {
  const seen: Parameters<X402PaymentClientV2["createPaymentSignature"]>[0][] = [];
  const client: X402PaymentClientV2 = {
    async createPaymentSignature(args) {
      seen.push(args);
      return paymentSignature(args.requirements, o);
    },
  };
  return { client, seen };
}
const settled2 = (over: Record<string, unknown> = {}) =>
  b64({ success: true, transaction: "0x" + "ab".repeat(32), network: CAIP2, payer: "0x" + "fe".repeat(20), ...over });

// 21) v2 正常付款流程
{
  const pay = fakePaymentV2();
  const { api, calls } = mk(
    [
      r402v2(required2([req2({ amount: "9000", payTo: "0x9999999999999999999999999999999999999999", network: "eip155:8453" }), req2()])),
      json(200, { ok: true, settled: true, data: { asset: "sBTC", price: 60000 } }, { "payment-response": settled2() }),
    ],
    { payment: pay.client },
  );
  const r = await api.getOracleSnapshot("sBTC");
  assert.equal(r.body.data.price, 60000);
  assert.equal(pay.seen.length, 1);
  assert.equal(pay.seen[0]!.requirements.network, CAIP2, "只挑符合網路的要求（base-sepolia ↔ eip155:84532）");
  assert.equal(pay.seen[0]!.requirements.amount, "5000");
  assert.equal(pay.seen[0]!.paymentRequired.x402Version, 2);
  assert.equal(pay.seen[0]!.maxValueAtomic, 20_000n);
  assert.equal(pay.seen[0]!.resource, `${BASE}/oracle/sBTC`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.get("payment-signature"), null, "第一次不帶付款");
  assert.equal(calls[1]!.headers.get("x-payment"), null, "v2 不送 X-PAYMENT");
  const sent = unb64(calls[1]!.headers.get("payment-signature"));
  assert.equal(sent.x402Version, 2);
  assert.equal(sent.payload.authorization.to, PAY_TO);
  assert.equal(sent.extensions?.["payment-identifier"], undefined, "預設不送 payment-identifier（即使伺服器有宣告）");
  assert.equal(calls[1]!.headers.get("payment-signature"), paymentSignature(pay.seen[0]!.requirements), "簽署端的輸出原封不動送出");
  assert.equal(r.payment!.x402Version, 2);
  assert.equal(r.payment!.paymentId, null);
  assert.equal(r.payment!.paidAtomic, 5000n);
  assert.equal(r.payment!.network, CAIP2);
  assert.equal((r.payment!.settlement as { success: boolean }).success, true);
  assert.equal(api.spentAtomic(), 5000n);
  assert.equal(api.unsettledAtomic(), 0n);
  ok("v2 付款流程：讀 PAYMENT-REQUIRED → 挑選 → 呼叫端簽 → 帶 PAYMENT-SIGNATURE 送一次（預設不帶 payment-identifier）→ 記帳與結算證明");
}

// 22) payment-identifier（選用）：只有呼叫端指定才送；簽署端自帶的原樣保留
{
  assert.ok(isValidPaymentId(generatePaymentId()));
  assert.equal(isValidPaymentId("short"), false);
  const paidOk = () => json(200, { ok: true, settled: true, data: {} }, { "payment-response": settled2() });
  // 呼叫端指定、伺服器有宣告：填入 id，宣告的其他欄位照規格回顯
  let m = mk([r402v2(), paidOk()], { payment: fakePaymentV2().client });
  let r = await m.api.getOracleSnapshot("sBTC", { paymentId: "order_2026-10-01_0001" });
  assert.equal(r.payment!.paymentId, "order_2026-10-01_0001");
  let sent = unb64(m.calls[1]!.headers.get("payment-signature"));
  assert.equal(sent.extensions["payment-identifier"].info.id, "order_2026-10-01_0001");
  assert.equal(sent.extensions["payment-identifier"].info.required, false, "伺服器宣告的 info 原樣保留");
  assert.deepEqual(sent.extensions["payment-identifier"].schema, PID_DECL.schema);
  // 呼叫端指定、伺服器沒有宣告（例如 signal-api）：照樣送（只是中繼資料），不報錯
  m = mk([r402v2(required2([req2()], false)), paidOk()], { payment: fakePaymentV2().client });
  r = await m.api.getOracleSnapshot("sBTC", { paymentId: "order_2026-10-01_0002" });
  assert.equal(r.payment!.paymentId, "order_2026-10-01_0002");
  sent = unb64(m.calls[1]!.headers.get("payment-signature"));
  assert.deepEqual(sent.extensions["payment-identifier"], { info: { id: "order_2026-10-01_0002" } });
  // 簽署端自己帶了 id：沒有指定時原樣送出並回報；有指定時以呼叫端為準
  const signer = fakePaymentV2({ paymentId: "signer_supplied_id_01" });
  m = mk([r402v2(), paidOk()], { payment: signer.client });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.paymentId, "signer_supplied_id_01");
  assert.equal(m.calls[1]!.headers.get("payment-signature"), paymentSignature(req2(), { paymentId: "signer_supplied_id_01" }));
  m = mk([r402v2(), paidOk()], { payment: fakePaymentV2({ paymentId: "signer_supplied_id_01" }).client });
  assert.equal((await m.api.getOracleSnapshot("sBTC", { paymentId: "caller_wins_0123456789" })).payment!.paymentId, "caller_wins_0123456789");
  // 沒指定、伺服器也沒宣告：不送 id，header 原樣送出
  m = mk([r402v2(required2([req2()], false)), paidOk()], { payment: fakePaymentV2().client });
  r = await m.api.getOracleSnapshot("sBTC");
  assert.equal(r.payment!.paymentId, null);
  assert.equal(m.calls[1]!.headers.get("payment-signature"), paymentSignature(req2()), "簽署端的輸出原封不動送出");
  // 格式不合：在任何請求之前就丟錯
  m = mk([], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC", { paymentId: "bad id" }), TypeError);
  assert.equal(m.calls.length, 0);
  ok("payment-identifier（選用）：預設不送；呼叫端指定才送（伺服器宣告與否皆可）；簽署端自帶的原樣保留、呼叫端指定優先；格式不合在送出前丟錯");
}

// 23) v2：上限、累計預留、並行
{
  const expectLimit = async (steps: Step[], extra: Partial<SignalApiClientConfig>, kind: string) => {
    const { api, calls } = mk(steps, extra);
    await assert.rejects(api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentLimitExceededError && e.kind === kind && e.paymentSent === false);
    assert.equal(calls.length, 1, "沒有送出付款");
    assert.equal(api.spentAtomic(), 0n);
  };
  await expectLimit([r402v2(required2([req2({ amount: "20001" })]))], { payment: fakePaymentV2().client }, "per-request");
  await expectLimit([r402v2()], { payment: fakePaymentV2().client, maxTotalSpendAtomic: 4_999n }, "total");
  await expectLimit([r402v2()], { payment: fakePaymentV2({ value: "5001" }).client }, "per-request");

  // 並行 3 筆、累計上限只夠 1 筆 → 只簽出並送出 1 筆。
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let signs = 0;
  const slow: X402PaymentClientV2 = {
    async createPaymentSignature(a) {
      signs++;
      await gate;
      return paymentSignature(a.requirements);
    },
  };
  const { api, calls } = mk(
    [r402v2(), r402v2(), r402v2(), json(200, { ok: true, settled: true, data: {} }, { "payment-response": settled2() })],
    { payment: slow, maxTotalSpendAtomic: 5_000n },
  );
  const all = Promise.allSettled([1, 2, 3].map(() => api.getOracleSnapshot("sBTC")));
  await new Promise((r) => setTimeout(r, 10));
  release();
  const res = await all;
  assert.equal(res.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(signs, 1, "被擋的兩筆沒有呼叫簽署端");
  assert.equal(calls.filter((c) => c.headers.get("payment-signature")).length, 1);
  assert.equal(api.spentAtomic(), 5_000n);
  ok("v2：單筆上限、累計上限、簽出金額 > 要求在送出前擋下；並行 3 筆只簽出 1 筆（預留語意與 v1 相同）");
}

// 24) v2：付款要求不符 → 不簽
{
  const bad: [string, PaymentRequirementsV2[]][] = [
    ["network", [req2({ network: "eip155:8453" })]],
    ["v1 的網路名稱", [req2({ network: "base-sepolia" })]],
    ["asset", [req2({ asset: "0x" + "88".repeat(20) })]],
    ["scheme", [req2({ scheme: "upto" as "exact" })]],
    ["amount 格式", [req2({ amount: "0.005" })]],
    ["maxTimeoutSeconds", [req2({ maxTimeoutSeconds: 301 })]],
    ["Permit2", [req2({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } })]],
    ["upfront flow", [req2({ extra: { name: "USDC", version: "2", paymentFlow: "upfront" } })]],
    ["escrow flow", [req2({ extra: { name: "USDC", version: "2", paymentFlow: "escrow" } })]],
  ];
  for (const [what, accepts] of bad) {
    const pay = fakePaymentV2();
    const { api, calls } = mk([r402v2(required2(accepts))], { payment: pay.client });
    await assert.rejects(api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentRejectedError && e.paymentSent === false, what);
    assert.equal(pay.seen.length, 0, `${what}：不可呼叫簽署端`);
    assert.equal(calls.length, 1);
  }
  const pay = fakePaymentV2();
  const { api } = mk([r402v2()], { payment: pay.client, payToAllowlist: ["0x9999999999999999999999999999999999999999"] });
  await assert.rejects(api.getOracleSnapshot("sBTC"), PaymentRejectedError);
  assert.equal(pay.seen.length, 0);
  // 明確宣告 eip3009／authorization 的可以付。
  const okPay = fakePaymentV2();
  const m = mk(
    [r402v2(required2([req2({ extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009", paymentFlow: "authorization" } })])),
     json(200, { ok: true, settled: true, data: {} }, { "payment-response": settled2() })],
    { payment: okPay.client },
  );
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.paidAtomic, 5000n);
  ok("v2：網路／幣別／scheme／金額格式／有效期／payTo 白名單不符，或 Permit2／upfront／escrow → PaymentRejectedError，未簽署");
}

// 25) v2：簽出內容逐欄核對
{
  const cases: [string, SigOverrides][] = [
    ["x402Version", { x402Version: 1 }],
    ["accepted.payTo", { accepted: { payTo: "0x9999999999999999999999999999999999999999" } }],
    ["accepted.amount", { accepted: { amount: "4999" } }],
    ["accepted.network", { accepted: { network: "eip155:8453" } }],
    ["accepted.asset", { accepted: { asset: "0x" + "88".repeat(20) } }],
    ["accepted.maxTimeoutSeconds", { accepted: { maxTimeoutSeconds: 300 } }],
    ["accepted.extra Permit2", { accepted: { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } } }],
    ["authorization.to", { to: "0x9999999999999999999999999999999999999999" }],
    ["validBefore", { validBefore: String(NOW_S + 60 + 61) }],
    ["Permit2 payload", { permit2: true }],
  ];
  for (const [what, o] of cases) {
    const { api, calls } = mk([r402v2()], { payment: fakePaymentV2(o).client });
    await assert.rejects(api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentRejectedError && e.paymentSent === false, what);
    assert.equal(calls.length, 1, `${what}：不可送出`);
    assert.equal(api.spentAtomic(), 0n, `${what}：預留回滾`);
  }
  // 無法解析
  const garbage: X402PaymentClientV2 = { createPaymentSignature: async () => "not-base64-json" };
  const g = mk([r402v2()], { payment: garbage });
  await assert.rejects(g.api.getOracleSnapshot("sBTC"), PaymentRejectedError);
  assert.equal(g.api.spentAtomic(), 0n);
  // validBefore 在容忍範圍內 → 送出；簽得比要求少 → 記實際金額
  const m = mk(
    [r402v2(), json(200, { ok: true, settled: true, data: {} }, { "payment-response": settled2() })],
    { payment: fakePaymentV2({ validBefore: String(NOW_S + 60 + 60), value: "3000" }).client },
  );
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.paidAtomic, 3_000n);
  assert.equal(m.api.spentAtomic(), 3_000n);
  assert.ok(decodePaymentSignature(paymentSignature(req2())));
  assert.equal(decodePaymentSignature(paymentSignature(req2(), { permit2: true })), null);
  ok("v2：x402Version／accepted 各欄／authorization.to／validBefore／Permit2 payload 不符 → 不送出、預留回滾；簽得較少記實際金額");
}

// 26) v2：送出之後的各種結果
{
  const failed = b64({ success: false, errorReason: "insufficient_funds", transaction: "", network: CAIP2 });
  // 結算被拒：402 + PAYMENT-RESPONSE success:false → 不是結算證明，記為 unsettled
  let m = mk([r402v2(), json(402, {}, { "payment-response": failed })], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), (e: unknown) =>
    e instanceof PaymentRequiredError && e.afterPayment && e.paymentSent && e.code === "insufficient_funds" && e.settlement?.success === false);
  assert.deepEqual([m.api.spentAtomic(), m.api.unsettledAtomic()], [5_000n, 5_000n]);
  assert.equal(m.calls.length, 2, "不重試");

  // 驗證失敗：402 + PAYMENT-REQUIRED.error
  m = mk([r402v2(), r402v2({ ...required2(), error: "invalid_exact_evm_payload_signature" })], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), (e: unknown) =>
    e instanceof PaymentRequiredError && e.code === "invalid_exact_evm_payload_signature" && e.x402Version === 2 && e.acceptsV2.length === 1 && e.paymentSent);

  // facilitator 502（settle 階段，結果未知）／429
  m = mk([r402v2(), json(502, { ok: false, error: "facilitator_unavailable", note: "結算結果未知", facilitator: "https://x402.org/facilitator", phase: "settle" })], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof ServiceUnavailableError && e.paymentSent && e.code === "facilitator_unavailable");
  assert.equal(m.api.unsettledAtomic(), 5_000n);
  assert.equal(m.calls.length, 2, "帶付款的請求永不重試");
  m = mk([r402v2(), json(429, { ok: false, error: "facilitator_rate_limited" }, { "retry-after": "5" })], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof RateLimitedError && e.paymentSent);
  assert.equal(m.calls.length, 2);

  // 網路錯誤／逾時 → PaymentOutcomeUnknownError（帶 paymentId，對帳用）
  m = mk([r402v2(), new TypeError("socket hang up")], { payment: fakePaymentV2().client });
  await assert.rejects(m.api.getOracleSnapshot("sBTC", { paymentId: "reconcile_me_0123456789" }), (e: unknown) =>
    e instanceof PaymentOutcomeUnknownError && e.paymentSent && e.signedAtomic === 5_000n && e.paymentId === "reconcile_me_0123456789");
  assert.deepEqual([m.api.spentAtomic(), m.api.unsettledAtomic()], [5_000n, 5_000n]);

  // 200 但沒有 PAYMENT-RESPONSE → 資料照給，但記為 unsettled
  m = mk([r402v2(), json(200, { ok: true, settled: false, data: {} })], { payment: fakePaymentV2().client });
  const r = await m.api.getOracleSnapshot("sBTC");
  assert.equal(r.payment!.settlement, null);
  assert.equal(m.api.unsettledAtomic(), 5_000n);

  // 簽署逾時（v2）→ 未送出、預留回滾
  const hang: X402PaymentClientV2 = { createPaymentSignature: () => new Promise<string>(() => {}) };
  m = mk([r402v2()], { payment: hang, paymentSignTimeoutMs: 20 });
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), PaymentSignTimeoutError);
  assert.equal(m.api.spentAtomic(), 0n);
  assert.equal(m.calls.length, 1);
  ok("v2：結算被拒（success:false 不算結算證明）／驗證失敗／502／429／斷線 → paymentSent=true、不重試、記 unsettled；簽署逾時回滾");
}

// 27) 協定選擇
{
  const v1Body = { error: "X-PAYMENT header is required", accepts: [req()], x402Version: 1 };
  const both402 = () => r402v2(required2(), v1Body);
  const paidV1 = () => json(200, { ok: true, settled: true, data: {} }, { "x-payment-response": b64({ success: true, transaction: "0xabc" }) });
  const paidV2 = () => json(200, { ok: true, settled: true, data: {} }, { "payment-response": settled2() });
  const dual = () => ({ ...fakePayment("5000").client, ...fakePaymentV2().client });

  // both 伺服器 + 兩種都會的簽署端 → v2 優先
  let m = mk([both402(), paidV2()], { payment: dual() });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.x402Version, 2);
  assert.ok(m.calls[1]!.headers.get("payment-signature"));
  assert.equal(m.calls[1]!.headers.get("x-payment"), null, "同一個請求只帶一種付款 header");
  // both 伺服器 + 只會 v1 的簽署端 → v1（既有客戶不用改）
  m = mk([both402(), paidV1()], { payment: fakePayment("5000").client });
  const r1 = await m.api.getOracleSnapshot("sBTC");
  assert.equal(r1.payment!.x402Version, 1);
  assert.equal(r1.payment!.paymentId, null);
  assert.ok(m.calls[1]!.headers.get("x-payment"));
  assert.equal(m.calls[1]!.headers.get("payment-signature"), null);
  // x402Protocol: "v1" 強制
  m = mk([both402(), paidV1()], { payment: dual(), x402Protocol: "v1" });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.x402Version, 1);
  // v1 伺服器 + 兩種都會 → v1
  m = mk([r402(), paidV1()], { payment: dual() });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.x402Version, 1);
  // 不相容的組合：一律在簽署前丟 PaymentRejectedError
  const rejects = async (steps: Step[], extra: Partial<SignalApiClientConfig>, re: RegExp) => {
    const x = mk(steps, extra);
    await assert.rejects(x.api.getOracleSnapshot("sBTC"), (e: unknown) => e instanceof PaymentRejectedError && re.test(e.message) && e.paymentSent === false);
    assert.equal(x.calls.length, 1);
  };
  await rejects([r402v2()], { payment: fakePayment("5000").client }, /只提供 x402 v2/);
  await rejects([r402()], { payment: fakePaymentV2().client }, /只實作了 v2/);
  await rejects([r402()], { payment: dual(), x402Protocol: "v2" }, /沒有 PAYMENT-REQUIRED/);
  await rejects([r402v2()], { payment: fakePayment("5000").client, x402Protocol: "v2" }, /沒有 createPaymentSignature/);
  // PAYMENT-REQUIRED 不是 v2（x402Version 不對）→ 當成沒有宣告 v2
  m = mk([json(402, v1Body, { "payment-required": b64({ x402Version: 3, accepts: [] }) }), paidV1()], { payment: dual() });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.x402Version, 1);
  // 設定檢查
  assert.throws(() => new SignalApiClient({ baseUrl: BASE, payment: {} as X402PaymentClient }), /createPaymentHeader/);
  assert.throws(() => new SignalApiClient({ baseUrl: BASE, x402Protocol: "v3" as "v2" }), /x402Protocol/);
  // expectedNetwork 以 CAIP-2 設定：v1、v2 都對得上
  m = mk([r402(), paidV1()], { payment: dual(), expectedNetwork: CAIP2, expectedAsset: OFFICIAL_BASE_SEPOLIA_USDC });
  assert.equal((await m.api.getOracleSnapshot("sBTC")).payment!.network, "base-sepolia");
  // 未注入 payment client：v2 的 402 → PaymentRequiredError 帶 acceptsV2
  m = mk([r402v2()]);
  await assert.rejects(m.api.getOracleSnapshot("sBTC"), (e: unknown) =>
    e instanceof PaymentRequiredError && !e.afterPayment && e.acceptsV2.length === 1 && e.accepts.length === 0 && e.x402Version === 2);
  ok("協定選擇：auto 時伺服器宣告 v2 且簽署端支援 → v2，否則 v1；x402Protocol 可強制；不相容的組合在簽署前丟 PaymentRejectedError");
}

console.log(`\n✅ sdk signalApi.test.ts 全過（${n} 項）`);
