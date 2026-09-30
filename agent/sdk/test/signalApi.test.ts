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
  PayToUnsafeError,
  PriceStaleError,
  RateLimitedError,
  ServiceUnavailableError,
  SignalApiClient,
  SignalApiError,
  SignalApiNetworkError,
  SignalApiTimeoutError,
  type PaymentRequirements,
  type X402PaymentClient,
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
const xPayment = (value: string) =>
  Buffer.from(JSON.stringify({ x402Version: 1, payload: { authorization: { value } } })).toString("base64");

/** 假 payment client：記錄被呼叫的參數，回傳指定金額的 X-PAYMENT。 */
function fakePayment(value = "5000") {
  const seen: Parameters<X402PaymentClient["createPaymentHeader"]>[0][] = [];
  const client: X402PaymentClient = {
    async createPaymentHeader(args) {
      seen.push(args);
      return xPayment(value);
    },
  };
  return { client, seen };
}

const sleeps: number[] = [];
const mk = (steps: Step[], extra: ConstructorParameters<typeof SignalApiClient>[0] = {}) => {
  const f = fakeFetch(steps);
  sleeps.length = 0;
  const api = new SignalApiClient({
    baseUrl: BASE + "/",
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...extra,
  });
  return { api, calls: f.calls };
};

// 1) 預設上限沿用 agent 的 x402 client
assert.equal(DEFAULT_MAX_PAYMENT_ATOMIC, 20_000n, "0.02 USDC");
assert.equal(DEFAULT_MAX_TOTAL_SPEND_ATOMIC, 1_000_000n, "1 USDC");
assert.throws(() => new SignalApiClient({ maxPaymentAtomic: 0n }), /> 0/);
ok("預設單筆 0.02 USDC、累計 1 USDC（沿用 shared/x402Client）；0 上限拒絕");

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
  assert.throws(() => new SignalApiClient({ payToAllowlist: ["nope"] }), /非法地址/);
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
  assert.equal(b.api.spentAtomic(), 0n, "沒有結算證明且失敗 → 不記帳");
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

console.log(`\n✅ sdk signalApi.test.ts 全過（${n} 項）`);
