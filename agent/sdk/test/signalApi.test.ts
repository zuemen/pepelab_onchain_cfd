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
  type SignalApiClientConfig,
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

console.log(`\n✅ sdk signalApi.test.ts 全過（${n} 項）`);
