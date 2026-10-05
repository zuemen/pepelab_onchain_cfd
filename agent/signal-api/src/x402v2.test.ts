// x402 v2／both 模式的付費牆測試（docs/ADR-010-x402-v2-migration.md）。
//   cd agent && npx tsx signal-api/src/x402v2.test.ts
//
// 完全離線：本機假 facilitator（testing/mockFacilitator.ts，會真的驗 EIP-712 簽章）、假 Upstash、
// 假 RPC；付款用隨機產生的測試金鑰在記憶體簽署。不連網、不送交易、不付款。
//
// 這支要證明的是：v1 既有的每一項保護，在 v2 路徑上同樣成立——
//   payTo 守門 fail-closed、maxTimeoutSeconds=60、付款前的輸入／registry 閘門、HEAD 405、
//   結算帳本「確定收到錢才入列」與冪等鍵、facilitator 錯誤對應（429／502）、resource 用 https、
//   handler ≥400 不結算。以及 both 模式下 v1、v2 兩種付款都能走完，且未付款的 402 body 與 v1 相同。
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWalletClient, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createPaymentHeader as createV1PaymentHeader } from "x402/client";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { startMockFacilitator } from "./testing/mockFacilitator.ts";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";
import { startRpcStub } from "./testing/rpcStub.ts";

const facilitator = await startMockFacilitator();
const upstash = await startFakeUpstash();
const rpc = await startRpcStub();

process.env.X402_FACILITATOR_URL = facilitator.url;
process.env.X402_NETWORK = "base-sepolia";
process.env.BASE_SEPOLIA_RPC_URL = rpc.url;
process.env.UPSTASH_REDIS_REST_URL = upstash.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
for (const k of ["X402_PROTOCOL", "PAY_TO", "SIGNAL_API_PUBLIC_URL", "X402_FACILITATOR_TIMEOUT_MS"]) delete process.env[k];

const { createApp, MAX_TIMEOUT_SECONDS } = await import("./app.ts");
const { QUEUE_KEY, UNKNOWN_SETTLEMENT_KEY, deriveIdempotencyKeyV2, authorizationMarkerKey } = await import("./ledger.ts");
const { runWorker } = await import("./settlement-worker.ts");
const { classifyV2FacilitatorError, resolveX402Protocol, toCaip2Network, resolveFacilitatorTimeoutMs } = await import(
  "./x402v2.ts"
);
const { readPaymentIdentifier, isValidPaymentId, PAYMENT_IDENTIFIER } = await import("./paymentIdentifier.ts");

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

const PAYTO = "0x4444444444444444444444444444444444444444";
const TRADER = "0x5555555555555555555555555555555555555555";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE = "https://signal.example";
const SIGNALS = `${BASE}/signals/${TRADER}`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));
const queue = () =>
  upstash.list(QUEUE_KEY).map((s) => JSON.parse(s) as { trader: string; feeUsd: number; source: string; idempotencyKey?: string; paymentId?: string });
const unknownQueue = () => upstash.list(UNKNOWN_SETTLEMENT_KEY).map((s) => JSON.parse(s) as Record<string, any>);
/** 執行 fn 期間攔下 console.error／warn（不輸出），回傳每一行。 */
const captureLogs = async <T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> => {
  const { warn, error } = console;
  const lines: string[] = [];
  console.warn = console.error = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

let signalReads = 0;
let signalFails = false;
function makeApp(protocol: "v1" | "v2" | "both", over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    payTo: PAYTO,
    payoutCodeReader: { getCode: async () => "0x" },
    isRegisteredTrader: async () => true,
    x402Protocol: protocol,
    signalReader: async (trader) => {
      signalReads += 1;
      if (signalFails) throw new Error("rpc down (fake)");
      return { trader, winRate: 0.5, fake: true };
    },
    ...over,
  });
}

// ── 付款端：官方 v2 client（@x402/core + @x402/evm）與 v1 client（x402 0.5.3）──
function buyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const v2 = new x402Client().register("eip155:84532", new ExactEvmScheme(account));
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc.url) }).extend(publicActions);
  return {
    address: account.address,
    /** 由 402 回應產生 PAYMENT-SIGNATURE（可選擇帶 payment-identifier、或竄改 payload）。 */
    async signV2(res402: Response, opts: { paymentId?: string; mutate?: (p: any) => void } = {}): Promise<string> {
      const required = unb64(res402.headers.get("PAYMENT-REQUIRED"));
      const payload: any = await v2.createPaymentPayload(required);
      if (opts.paymentId !== undefined) {
        payload.extensions = {
          ...payload.extensions,
          [PAYMENT_IDENTIFIER]: {
            ...payload.extensions?.[PAYMENT_IDENTIFIER],
            info: { ...payload.extensions?.[PAYMENT_IDENTIFIER]?.info, id: opts.paymentId },
          },
        };
      }
      opts.mutate?.(payload);
      return b64(payload);
    },
    /** 由 v1 的 402 body 產生 X-PAYMENT。 */
    async signV1(res402: Response): Promise<string> {
      const body = (await res402.clone().json()) as { x402Version: number; accepts: any[] };
      return createV1PaymentHeader(wallet as any, body.x402Version, body.accepts[0]);
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 純函式
// ════════════════════════════════════════════════════════════════════════════
{
  assert.equal(resolveX402Protocol({}), "v1");
  assert.equal(resolveX402Protocol({ X402_PROTOCOL: "" }), "v1");
  assert.equal(resolveX402Protocol({ X402_PROTOCOL: " V2 " }), "v2");
  assert.equal(resolveX402Protocol({ X402_PROTOCOL: "both" }), "both");
  assert.equal(await quiet(async () => resolveX402Protocol({ X402_PROTOCOL: "v3" })), "v1", "無法辨識 → v1");
  assert.equal(await quiet(async () => resolveX402Protocol({ X402_PROTOCOL: "2" })), "v1", "只接受 v1｜v2｜both");
  assert.equal(toCaip2Network("base-sepolia"), "eip155:84532");
  assert.equal(toCaip2Network("base"), "eip155:8453");
  assert.equal(toCaip2Network("eip155:84532"), "eip155:84532");
  assert.throws(() => toCaip2Network("polygon-amoy"), /CAIP-2/);
  assert.equal(resolveFacilitatorTimeoutMs({}), 20_000);
  assert.equal(resolveFacilitatorTimeoutMs({ X402_FACILITATOR_TIMEOUT_MS: "5000" }), 5_000);
  assert.equal(await quiet(async () => resolveFacilitatorTimeoutMs({ X402_FACILITATOR_TIMEOUT_MS: "90000" })), 20_000, "超過 55 秒（Vercel 上限 60）→ 預設");
  ok("X402_PROTOCOL 解析（預設 v1、無法辨識 → v1）、v1 網路名稱 → CAIP-2、facilitator 逾時上限");
}
{
  assert.equal(isValidPaymentId("pay_7d5d747be160e280504c099d984bcfe0"), true);
  assert.equal(isValidPaymentId("short"), false);
  assert.equal(isValidPaymentId("a".repeat(129)), false);
  assert.equal(isValidPaymentId("has space 0123456789"), false);
  assert.equal(isValidPaymentId("has:colon:0123456789"), false, "冒號不可出現（會混進冪等鍵的分隔符）");
  assert.deepEqual(readPaymentIdentifier({}), { id: null, valid: true });
  assert.deepEqual(readPaymentIdentifier({ extensions: { [PAYMENT_IDENTIFIER]: { info: { required: false } } } }), { id: null, valid: true });
  assert.deepEqual(readPaymentIdentifier({ extensions: { [PAYMENT_IDENTIFIER]: { info: { required: false, id: "pay_0123456789abcdef" } } } }), { id: "pay_0123456789abcdef", valid: true });
  assert.deepEqual(readPaymentIdentifier({ extensions: { [PAYMENT_IDENTIFIER]: { info: { id: "bad id" } } } }), { id: null, valid: false });
  assert.deepEqual(readPaymentIdentifier({ extensions: { [PAYMENT_IDENTIFIER]: { info: { id: 12345678901234567890 } } } }), { id: null, valid: false });

  const tx = "0x" + "ab".repeat(32);
  const A = "0x" + "11".repeat(20);
  const B = "0x" + "22".repeat(20);
  const payload = (id?: string, from = A) => ({
    payload: { authorization: { from, nonce: "0x" + "CD".repeat(32) } },
    ...(id ? { extensions: { [PAYMENT_IDENTIFIER]: { info: { required: false, id } } } } : {}),
  });
  const settle = (payer?: string) => b64({ success: true, transaction: tx, network: "eip155:84532", ...(payer ? { payer } : {}) });
  assert.equal(deriveIdempotencyKeyV2(settle(A), payload()), `tx:${tx}`, "結算 tx hash（與 v1 相同）");
  assert.equal(deriveIdempotencyKeyV2(settle(A), payload("pay_0123456789abcdef")), `tx:${tx}`, "帶了 payment-identifier 仍是 tx 鍵（id 不參與去重）");
  assert.equal(deriveIdempotencyKeyV2(settle(B), payload("pay_0123456789abcdef", A)), `tx:${tx}`);
  assert.equal(deriveIdempotencyKeyV2("garbage", payload()), `auth:${A}:0x${"cd".repeat(32)}`, "沒有 tx hash 才用付款人 + nonce");
  assert.equal(deriveIdempotencyKeyV2("garbage", payload("pay_0123456789abcdef")), `auth:${A}:0x${"cd".repeat(32)}`, "沒有 tx hash、帶了 id → 仍是 auth 鍵");
  assert.equal(deriveIdempotencyKeyV2(null, null), undefined);
  ok("payment-identifier 驗證（16–128 字元、英數_-）與 v2 冪等鍵：tx:<hash> > auth:<付款人>:<nonce>（payment-identifier 不參與）");
}
{
  const ve = Object.assign(new Error("x"), { name: "VerifyError", statusCode: 400, invalidReason: "invalid_exact_evm_payload_signature" });
  assert.equal(classifyV2FacilitatorError(ve, "verify"), null, "結構化的驗證失敗維持 402");
  const rl = Object.assign(new Error("rate_limit_exceeded"), { name: "VerifyError", statusCode: 200, invalidReason: "rate_limit_exceeded" });
  assert.equal(classifyV2FacilitatorError(rl, "verify")?.status, 429);
  assert.equal(classifyV2FacilitatorError(new Error("Facilitator verify failed (429): {}"), "verify")?.status, 429);
  assert.equal(classifyV2FacilitatorError(new Error("Facilitator settle failed (503): "), "settle")?.status, 502);
  assert.equal(classifyV2FacilitatorError(new TypeError("fetch failed"), "verify")?.status, 502);
  assert.equal(
    classifyV2FacilitatorError(new Error("Failed to initialize: no supported payment kinds loaded from any facilitator.", { cause: new Error("Facilitator getSupported failed (429): x") }), "supported")?.status,
    429,
  );
  assert.equal(classifyV2FacilitatorError(new TypeError("Cannot read properties of undefined"), "verify"), null, "自己的 bug 不包裝成 facilitator 掛了");
  ok("classifyV2FacilitatorError：限流 → 429、無法使用 → 502、結構化拒絕與自己的 bug → 不轉換");
}

// ════════════════════════════════════════════════════════════════════════════
// v2 模式
// ════════════════════════════════════════════════════════════════════════════
const v1Golden = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "testing", "golden", "x402-v1-402.json"), "utf8"),
) as { name: string; status: number; headers: [string, string][]; body?: string }[];
const goldenAccept = JSON.parse(v1Golden[0]!.body!).accepts[0] as Record<string, any>;

{
  facilitator.reset();
  const app = makeApp("v2");
  const res = await app.request(SIGNALS);
  assert.equal(res.status, 402);
  assert.equal(await res.text(), "{}", "v2 的 402 body 是 {}（付款要求在 header）");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-PAYMENT-RESPONSE"), null);
  const required = unb64(res.headers.get("PAYMENT-REQUIRED"));
  assert.equal(required.x402Version, 2);
  assert.equal(required.error, "Payment required");
  assert.equal(required.resource.url, SIGNALS, "resource.url 保留 https");
  assert.equal(required.resource.mimeType, "application/json");
  assert.equal(required.accepts.length, 1);
  const a = required.accepts[0];
  assert.deepEqual(
    { scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, extra: a.extra },
    { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
  );
  // 與 v1 宣告的是同一筆交易條件（同幣別、同金額、同收款人、同有效期、同 EIP-712 domain）。
  assert.equal(a.asset, goldenAccept.asset);
  assert.equal(a.amount, goldenAccept.maxAmountRequired);
  assert.equal(a.payTo, goldenAccept.payTo);
  assert.equal(a.maxTimeoutSeconds, goldenAccept.maxTimeoutSeconds);
  assert.equal(a.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.deepEqual(a.extra, goldenAccept.extra);
  assert.equal(a.extra.assetTransferMethod, undefined, "不宣告 Permit2（預設 eip3009）");
  assert.equal(required.extensions?.[PAYMENT_IDENTIFIER], undefined, "不宣告 payment-identifier（沒有實作規格要求的請求層冪等）");
  assert.equal(facilitator.count("/supported"), 1, "第一個付費路由請求才去拿 /supported");
  assert.equal(facilitator.count("/verify"), 0);

  const oracle = await app.request(`${BASE}/oracle/sBTC`);
  assert.equal(oracle.status, 402);
  assert.equal(unb64(oracle.headers.get("PAYMENT-REQUIRED")).accepts[0].amount, "5000");
  assert.equal(facilitator.count("/supported"), 1, "/supported 只拿一次（同一個實例）");
  ok("v2 未付款：402 + PAYMENT-REQUIRED（x402Version 2、CAIP-2、amount、maxTimeoutSeconds=60、https resource、不宣告 payment-identifier），條件與 v1 相同");
}

{
  // v1 模式完全不碰 facilitator、也不建立 v2 付費牆。
  facilitator.reset();
  const app = makeApp("v1");
  const res = await app.request(SIGNALS);
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  assert.equal(await res.text(), v1Golden[0]!.body);
  assert.equal(facilitator.calls.length, 0, "v1 未付款的 402 不呼叫 facilitator（含 /supported）");
  const disc = (await (await app.request(`${BASE}/`)).json()) as Record<string, unknown>;
  assert.equal("x402" in disc, false, "v1 模式的 GET / 不多出 x402 欄位");
  ok("v1 模式：402 與 golden 相同、不呼叫 facilitator、GET / 不變");
}

{
  // ── 付款前的閘門（在 402 之前；v2 與 v1 相同）──
  facilitator.reset();
  const unsafe = makeApp("v2", { payoutCodeReader: { getCode: async () => "0xef0100" + "ab".repeat(20) }, payTo: "0x6666666666666666666666666666666666666666" });
  const r = await quiet(() => unsafe.request(SIGNALS));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "payto_unsafe");
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), null, "payTo 不安全時不發出任何付款要求");
  // 帶了有效格式的付款也一樣：不驗證、不結算。
  const r2 = await quiet(() => unsafe.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": b64({ x402Version: 2 }) } }));
  assert.equal(r2.status, 503);
  assert.equal(facilitator.calls.length, 0, "payTo 不安全：facilitator 一次都沒被呼叫");

  // getCode 失敗（RPC 掛了）且沒有快取 → fail-closed
  const down = makeApp("v2", { payoutCodeReader: { getCode: async () => { throw new Error("ECONNREFUSED"); } }, payTo: "0x7777777777777777777777777777777777777777" });
  assert.equal((await quiet(() => down.request(SIGNALS))).status, 503, "RPC 失敗 → fail-closed 503");

  const app = makeApp("v2");
  assert.equal((await app.request(`${BASE}/signals/not-an-address`)).status, 400);
  assert.equal((await app.request(`${BASE}/oracle/sDOGE`)).status, 400);
  const unreg = makeApp("v2", { isRegisteredTrader: async () => false });
  const ru = await unreg.request(SIGNALS);
  assert.equal(ru.status, 400);
  assert.equal(((await ru.json()) as { error: string }).error, "trader_not_registered");
  const head = await app.request(SIGNALS, { method: "HEAD" });
  assert.equal(head.status, 405, "HEAD 不可免費執行 handler");
  // 路徑變形：與 v1 相同，經正規化後走同一組閘門。
  for (const p of [`/SIGNALS/${TRADER}`, `//signals/${TRADER}`, `/signals/${TRADER}/`, `/signals%2F${TRADER}`]) {
    const status = (await quiet(() => unsafe.request(`${BASE}${p}`))).status;
    assert.equal(status, 503, `${p} 在 payTo 不安全時必須是 503（不可繞過守門拿到 402）`);
    // 安全的 payTo：同一組變形要嘛是 402（正規化後就是付費路由），要嘛被擋下，絕不會免費執行 handler。
    const safe = await app.request(`${BASE}${p}`);
    assert.ok([402, 404].includes(safe.status), `${p} → ${safe.status}`);
  }
  assert.equal(signalReads, 0, "路徑變形沒有任何一個免費執行到 handler");
  assert.equal(facilitator.count("/verify") + facilitator.count("/settle"), 0);
  ok("v2 付款前閘門：payTo 守門 fail-closed（503、不發 PAYMENT-REQUIRED、不碰 facilitator）、輸入／registry 400、HEAD 405、路徑變形不可繞過");
}

{
  // ── 付款成功：200 + PAYMENT-RESPONSE + 入列 ──
  facilitator.reset();
  upstash.list(QUEUE_KEY).length = 0;
  signalReads = 0;
  const app = makeApp("v2");
  const me = buyer();
  const res402 = await app.request(SIGNALS);
  const sig = await me.signV2(res402);
  const sent = unb64(sig);
  assert.equal(sent.x402Version, 2);
  assert.equal(sent.accepted.payTo, PAYTO);
  const auth = sent.payload.authorization;
  const now = Math.floor(Date.now() / 1000);
  assert.equal(auth.to, PAYTO);
  assert.equal(auth.value, "10000");
  assert.equal(auth.validAfter, "0", "v2 的官方 client 以 validAfter=0 簽署（v1 是 now-600）");
  assert.ok(Number(auth.validBefore) <= now + MAX_TIMEOUT_SECONDS + 2 && Number(auth.validBefore) > now, "validBefore = now + maxTimeoutSeconds(60)");

  const paid = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } });
  assert.equal(paid.status, 200);
  const settle = unb64(paid.headers.get("PAYMENT-RESPONSE"));
  assert.equal(settle.success, true);
  assert.equal(settle.network, "eip155:84532");
  assert.equal(settle.payer, me.address);
  assert.match(settle.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(paid.headers.get("X-PAYMENT-RESPONSE"), null, "v2 不回 v1 的 header");
  assert.match(paid.headers.get("Cache-Control") ?? "", /private/);
  const body = (await paid.json()) as { ok: boolean; settled: boolean; settleError?: string; data: { fake: boolean } };
  assert.equal(body.ok, true);
  assert.equal(body.settled, true, "已排入結算佇列");
  assert.equal(body.data.fake, true);
  assert.equal(signalReads, 1);
  assert.deepEqual([facilitator.count("/verify"), facilitator.count("/settle")], [1, 1]);
  assert.equal(facilitator.calls.find((c) => c.path === "/verify")!.x402Version, 2);
  const q = queue();
  assert.equal(q.length, 1);
  assert.deepEqual({ trader: q[0]!.trader, feeUsd: q[0]!.feeUsd, source: q[0]!.source }, { trader: TRADER, feeUsd: 0.01, source: "signals" });
  assert.equal(q[0]!.idempotencyKey, `tx:${settle.transaction}`, "沒帶 payment-identifier → 結算 tx hash");
  // 成功路徑同時寫下「這張授權已入帳」標記（鏈＋token＋付款人＋nonce），對帳不會再以別的 tx 鍵入帳。
  const marker = authorizationMarkerKey({ network: "eip155:84532", asset: sent.accepted.asset, payer: auth.from, nonce: auth.nonce })!;
  assert.equal(upstash.strings.get(marker), `tx:${settle.transaction}`, "授權標記與入帳鍵一起寫入");

  // 同一張授權重送：facilitator 拒絕（nonce 已用）→ 402，不再入列、不再交付資料。
  const replay = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } });
  assert.equal(replay.status, 402);
  assert.equal(unb64(replay.headers.get("PAYMENT-REQUIRED")).error, "authorization_nonce_already_used");
  assert.equal(queue().length, 1, "重送不會多記一筆");
  assert.equal(signalReads, 1, "重送沒有執行 handler");
  ok("v2 付款成功：官方 client 簽的 EIP-3009（validBefore ≤ now+60）→ 200 + PAYMENT-RESPONSE + settled:true，帳本入列一筆（tx 鍵）；同一張授權重送 → 402、不重複入列");
}

{
  // ── payment-identifier 只是中繼資料：不參與去重（回歸：兩筆不同的錢不可以被合併成一筆分潤）──
  facilitator.reset();
  upstash.list(QUEUE_KEY).length = 0;
  const app = makeApp("v2");
  const alice = buyer();
  const id = "pay_7d5d747be160e280504c099d984bcfe0";
  const pay = async (who: ReturnType<typeof buyer>, opts: { paymentId?: string; relay?: (sig: string) => string } = {}) => {
    const sig = await who.signV2(await app.request(SIGNALS), { paymentId: opts.paymentId });
    const r = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": opts.relay ? opts.relay(sig) : sig } });
    return { status: r.status, tx: unb64(r.headers.get("PAYMENT-RESPONSE")).transaction as string };
  };

  // 1) 同付款人、同 id、兩張不同授權（例如逾時後帶同一個 id 重簽）→ 兩筆都結算、兩個不同的鍵。
  const a1 = await pay(alice, { paymentId: id });
  const a2 = await pay(alice, { paymentId: id });
  assert.deepEqual([a1.status, a2.status], [200, 200]);
  assert.notEqual(a1.tx, a2.tx);
  let q = queue();
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((e) => e.idempotencyKey), [`tx:${a1.tx}`, `tx:${a2.tx}`], "冪等鍵一律是結算 tx hash");
  assert.deepEqual(q.map((e) => e.paymentId), [id, id], "payment-identifier 存成中繼資料");

  // 2) 中間人（轉送者）替兩筆沒帶 id 的付款補上同一個 id → 一樣是兩個不同的鍵。
  const injected = "pay_relay_injected_000000000001";
  const relay = (sig: string) => {
    const p = unb64(sig);
    p.extensions = { ...p.extensions, [PAYMENT_IDENTIFIER]: { info: { required: false, id: injected } } };
    return b64(p);
  };
  const r1 = await pay(alice, { relay });
  const r2 = await pay(alice, { relay });
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  q = queue();
  assert.equal(q.length, 4);
  assert.deepEqual(q.slice(2).map((e) => e.idempotencyKey), [`tx:${r1.tx}`, `tx:${r2.tx}`]);
  assert.deepEqual(q.slice(2).map((e) => e.paymentId), [injected, injected]);
  assert.equal(new Set(q.map((e) => e.idempotencyKey)).size, 4, "四筆付款 → 四個不同的鍵");

  // 3) 格式不合的 id：不報錯、照常付款，只是不記。
  const before = facilitator.count("/verify");
  const bad = await pay(alice, { paymentId: "bad id!" });
  assert.equal(bad.status, 200);
  assert.equal(facilitator.count("/verify"), before + 1);
  assert.equal(queue().at(-1)!.idempotencyKey, `tx:${bad.tx}`);
  assert.equal(queue().at(-1)!.paymentId, undefined);

  // 4) 交給 worker：五筆都各自分潤一次（沒有任何一筆被當成重複跳過）。
  let settleCalls = 0;
  const summary = await runWorker({
    now: () => 1_000_000_000,
    receiptStatus: async () => "success",
    assessTrader: async (t: string) => ({ address: t, safe: true, reason: "eoa (fake)", source: "rpc" as const }),
    nonceStatus: async () => ({ latest: settleCalls, pending: settleCalls }),
    settle: async (_t, _f, hooks) => {
      settleCalls += 1;
      const txHash = "0x" + String(settleCalls).padStart(64, "0");
      await hooks.onSigned?.({ txHash, nonce: settleCalls - 1, rawTx: "0x02raw" });
      return { status: "settled" as const, tx: txHash };
    },
  });
  assert.equal(settleCalls, 5, "五筆付款 → 五次分潤");
  assert.equal(summary.settled, 5);
  assert.equal(queue().length, 0);
  ok("payment-identifier 只當中繼資料：同付款人同 id 兩張授權、或中間人補上相同 id → 兩個不同的 tx 鍵、兩筆都分潤；格式不合不報錯");
}

{
  // ── 竄改／格式錯誤的 PAYMENT-SIGNATURE ──
  facilitator.reset();
  upstash.list(QUEUE_KEY).length = 0;
  const app = makeApp("v2");
  const me = buyer();
  const res402 = () => app.request(SIGNALS);
  const send = (sig: string) => app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } });

  const notJson = await send("@@not-base64@@");
  assert.equal(notJson.status, 400);
  assert.equal(((await notJson.json()) as { error: string }).error, "invalid_payment_signature");

  const v1InV2 = await send(await me.signV2(await res402(), { mutate: (p) => (p.x402Version = 1) }));
  assert.equal(v1InV2.status, 400);
  assert.equal(((await v1InV2.json()) as { error: string }).error, "unsupported_x402_version");

  // accepted 必須與伺服器宣告的完全相同：改收款人、改金額、改有效期、宣告 Permit2 都不行。
  for (const [what, mutate] of [
    ["payTo", (p: any) => (p.accepted.payTo = "0x" + "99".repeat(20))],
    ["amount", (p: any) => (p.accepted.amount = "1")],
    ["maxTimeoutSeconds", (p: any) => (p.accepted.maxTimeoutSeconds = 3600)],
    ["asset", (p: any) => (p.accepted.asset = "0x" + "88".repeat(20))],
    ["network", (p: any) => (p.accepted.network = "eip155:8453")],
    ["extra.name", (p: any) => (p.accepted.extra = { ...p.accepted.extra, name: "Other" })],
  ] as const) {
    const r = await send(await me.signV2(await res402(), { mutate }));
    assert.equal(r.status, 402, `竄改 accepted.${what} → 402`);
    assert.equal(unb64(r.headers.get("PAYMENT-REQUIRED")).error, "No matching payment requirements");
  }
  assert.equal(facilitator.count("/verify"), 0, "accepted 不符：不送 facilitator");

  // client 在 accepted.extra 自行加上 assetTransferMethod=permit2：伺服器送給 facilitator 的仍是
  // **自己宣告的** requirements（沒有 permit2），不會因為 client 的說法改走 Permit2。
  const p2 = await send(await me.signV2(await res402(), { mutate: (p) => (p.accepted.extra = { ...p.accepted.extra, assetTransferMethod: "permit2" }) }));
  const verifyReq = facilitator.calls.filter((c) => c.path === "/verify").at(-1)!.body.paymentRequirements;
  assert.equal(verifyReq.extra.assetTransferMethod, undefined);
  assert.equal(verifyReq.payTo, PAYTO);
  assert.equal(verifyReq.maxTimeoutSeconds, 60);
  assert.equal(p2.status, 200, "payload 本身是合法的 EIP-3009 → 照常結算");
  upstash.list(QUEUE_KEY).length = 0;

  // 簽給別人的授權（authorization.to ≠ payTo）：facilitator 驗證失敗 → 402，不結算。
  const wrongTo = await send(await me.signV2(await res402(), { mutate: (p) => (p.payload.authorization.to = "0x" + "99".repeat(20)) }));
  assert.equal(wrongTo.status, 402);
  assert.equal(facilitator.count("/settle"), 1, "只有上面那一筆合法付款被結算");
  assert.equal(queue().length, 0);

  // X-PAYMENT 在 v2 模式被忽略（視同未付款）。
  const xp = await app.request(SIGNALS, { headers: { "X-PAYMENT": b64({ x402Version: 1 }) } });
  assert.equal(xp.status, 402);
  assert.ok(xp.headers.get("PAYMENT-REQUIRED"));
  ok("v2：無法解析／x402Version≠2 → 400；accepted 被竄改（payTo、amount、maxTimeoutSeconds、asset、network、extra）→ 402 且不送 facilitator；送給 facilitator 的一律是伺服器自己的 requirements；X-PAYMENT 被忽略");
}

{
  // ── facilitator 錯誤對應（§16）──
  upstash.list(QUEUE_KEY).length = 0;
  signalReads = 0;
  const app = makeApp("v2");
  const me = buyer();
  facilitator.reset();
  const attempt = async (mode: typeof facilitator.mode) => {
    facilitator.mode = "ok";
    const sig = await me.signV2(await app.request(SIGNALS));
    facilitator.mode = mode;
    const r = await quiet(() => app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } }));
    facilitator.mode = "ok";
    return { status: r.status, retryAfter: r.headers.get("Retry-After"), paymentResponse: r.headers.get("PAYMENT-RESPONSE"), required: r.headers.get("PAYMENT-REQUIRED"), body: (await r.json()) as Record<string, any> };
  };

  let r = await attempt("verify_http429");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "facilitator_rate_limited");
  assert.equal(r.body.phase, "verify");
  assert.ok(Number(r.retryAfter) > 0);
  assert.match(r.body.note, /^未扣款/);

  r = await attempt("verify_http503");
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "facilitator_unavailable");
  assert.equal(r.body.facilitator, facilitator.url);

  r = await attempt("verify_invalid_rate_limit");
  assert.equal(r.status, 429, "200 + isValid:false rate_limit_exceeded → 429，不是 402");
  assert.equal(signalReads, 0, "verify 沒過：handler 沒執行");

  // settle 階段：handler 已執行，但結果未知 → 502、不回付費資料、不入列、說明不可寫「未扣款」。
  r = await attempt("settle_http503");
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "facilitator_unavailable");
  assert.equal(r.body.phase, "settle");
  assert.match(r.body.note, /^結算結果未知/);
  assert.equal(r.body.data, undefined, "結算沒成功：不回付費資料");
  assert.equal(unknownQueue().length, 1, "settle 503 → 結果未知，推進對帳佇列");
  upstash.list(UNKNOWN_SETTLEMENT_KEY).length = 0;
  r = await attempt("settle_http429");
  assert.equal(r.status, 429);
  assert.equal(r.body.phase, "settle");

  // facilitator 明確拒絕結算 → 402 + PAYMENT-RESPONSE（success:false），不入列。
  r = await attempt("settle_rejected");
  assert.equal(r.status, 402);
  assert.equal(unb64(r.paymentResponse).success, false);
  assert.equal(unb64(r.paymentResponse).errorReason, "insufficient_funds");
  assert.equal(r.body.data, undefined);
  assert.equal(queue().length, 0, "結算沒成功的任何情況都不入列");
  assert.equal(unknownQueue().length, 0, "限流與明確拒絕不是「結果未知」，不進對帳佇列");

  // 真正的驗證失敗維持 402。
  const badSig = await app.request(SIGNALS, {
    headers: { "PAYMENT-SIGNATURE": await me.signV2(await app.request(SIGNALS), { mutate: (p) => (p.payload.signature = "0x" + "ab".repeat(65)) }) },
  });
  assert.equal(badSig.status, 402);
  assert.equal(unb64(badSig.headers.get("PAYMENT-REQUIRED")).error, "invalid_exact_evm_payload_signature");
  ok("v2 facilitator 錯誤：verify 429 → 429＋Retry-After、verify 503 → 502、isValid:false 限流 → 429；settle 503／429 → 502／429（結果未知、不回資料）；明確拒絕 → 402＋PAYMENT-RESPONSE；皆不入列");
}

{
  // ── settle 結果未知（五種）：502 phase=settle、不回資料、不入帳；一行結構化 log ＋ 對帳佇列 ──
  upstash.list(QUEUE_KEY).length = 0;
  upstash.list(UNKNOWN_SETTLEMENT_KEY).length = 0;
  // 逾時用短的 client 逾時（不靠牆上時間斷言，只是讓「掛住」快一點結束）。
  const client = new HTTPFacilitatorClient({ url: facilitator.url, timeoutMs: 300 });
  const app = makeApp("v2", { x402FacilitatorClient: client });
  const me = buyer();
  facilitator.reset();
  const cases: { mode: typeof facilitator.mode; settleCalls: number; withTx: boolean }[] = [
    { mode: "settle_pending", settleCalls: 2, withTx: true }, // @x402/core 對 pending 自動重試一次
    { mode: "settle_http500_json", settleCalls: 1, withTx: false },
    { mode: "settle_hang", settleCalls: 1, withTx: false },
    { mode: "settle_destroy", settleCalls: 1, withTx: false },
    { mode: "settle_bad_json", settleCalls: 1, withTx: false },
  ];
  for (const k of cases) {
    facilitator.mode = "ok";
    const sig = await me.signV2(await app.request(SIGNALS));
    const auth = unb64(sig).payload.authorization;
    const signature = unb64(sig).payload.signature as string;
    facilitator.mode = k.mode;
    const settlesBefore = facilitator.count("/settle");
    const { result: res, lines } = await captureLogs(() => app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } }));
    facilitator.mode = "ok";
    const body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 502, `${k.mode}：502，不是 402（402 會叫 client 重付）`);
    assert.equal(body.error, "facilitator_unavailable", k.mode);
    assert.equal(body.phase, "settle", k.mode);
    assert.match(body.note, /^結算結果未知/, k.mode);
    assert.equal(body.data, undefined, `${k.mode}：不回付費資料`);
    assert.equal(res.headers.get("PAYMENT-REQUIRED"), null, k.mode);
    assert.equal(facilitator.count("/settle") - settlesBefore, k.settleCalls, k.mode);
    assert.equal(queue().length, 0, `${k.mode}：不入分潤佇列`);

    const u = unknownQueue().at(-1)!;
    assert.equal(unknownQueue().length, cases.indexOf(k) + 1, `${k.mode}：推進對帳佇列`);
    assert.deepEqual(
      [u.payer.toLowerCase(), u.nonce, u.amount, u.route, u.network, u.payTo],
      [me.address.toLowerCase(), auth.nonce, "10000", `GET /signals/${TRADER}`, "eip155:84532", PAYTO],
      k.mode,
    );
    const logLine = lines.find((l) => l.startsWith("[x402v2] settlement_unknown "));
    assert.ok(logLine, `${k.mode}：一行結構化 log`);
    const logged = JSON.parse(logLine!.slice("[x402v2] settlement_unknown ".length));
    assert.deepEqual(logged, u, `${k.mode}：log 與佇列內容相同`);
    assert.ok(!lines.some((l) => l.includes(signature.slice(2, 40))), `${k.mode}：log 不含簽章`);
    assert.ok(!upstash.list(UNKNOWN_SETTLEMENT_KEY).some((l) => l.includes(signature.slice(2, 40))), `${k.mode}：佇列不含簽章`);
    if (k.withTx) {
      assert.match(body.transaction, /^0x[0-9a-f]{64}$/, `${k.mode}：回應附 tx hash`);
      assert.equal(u.transaction, body.transaction);
    } else {
      assert.equal(body.transaction, undefined, k.mode);
      assert.equal(u.transaction, null, k.mode);
    }
  }

  // 對帳佇列寫入失敗：回應仍是 502 phase=settle，並留下 log。
  const url = process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  const sig = await me.signV2(await app.request(SIGNALS));
  facilitator.mode = "settle_pending";
  const { result: res, lines } = await captureLogs(() => app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } }));
  facilitator.mode = "ok";
  process.env.UPSTASH_REDIS_REST_URL = url;
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { phase: string }).phase, "settle");
  assert.ok(lines.some((l) => l.startsWith("[x402v2] settlement_unknown ")));
  assert.ok(lines.some((l) => l.includes("寫入對帳佇列失敗")), "寫入失敗要 log");
  assert.equal(unknownQueue().length, cases.length);
  ok("v2 settle 結果未知（pending、500+JSON、逾時、斷線、壞 JSON）→ 502 phase=settle（pending 附 tx hash）、不回資料、不入帳；結構化 log（不含簽章）＋對帳佇列；佇列寫入失敗仍 502");
}

{
  // ── /supported 拿不到：不發 402，回 502；退避期內不再打 /supported，期滿後自動復原 ──
  facilitator.reset();
  facilitator.mode = "supported_http503";
  let clock = 5_000_000;
  const app = makeApp("v2", { x402V2Timing: { now: () => clock } });
  const r = await quiet(() => app.request(SIGNALS));
  assert.equal(r.status, 502);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.error, "facilitator_unavailable");
  assert.equal(j.phase, "supported");
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), null);
  const calls = facilitator.count("/supported");
  facilitator.mode = "ok";
  for (let i = 0; i < 5; i += 1) {
    clock += 5_000;
    const again = await quiet(() => app.request(SIGNALS));
    assert.equal(again.status, 502, "退避期內沿用上一次的失敗");
    assert.equal(((await again.json()) as { phase: string }).phase, "supported");
  }
  assert.equal(facilitator.count("/supported"), calls, "退避期（30 秒）內不再打 /supported");
  clock += 5_001; // 距離失敗 30.001 秒
  assert.equal((await app.request(SIGNALS)).status, 402, "退避期過後的下一個請求重試初始化");
  assert.equal(facilitator.count("/supported"), calls + 1);
  // 免費端點不受 facilitator 影響。
  facilitator.mode = "supported_http503";
  const fresh = makeApp("v2");
  assert.equal((await fresh.request(`${BASE}/healthz`)).status, 200);
  facilitator.mode = "ok";
  ok("v2：facilitator /supported 失敗 → 502（phase=supported、不發付款要求），30 秒退避內不再打 /supported，期滿自動重試；免費端點不受影響");
}

{
  // ── handler ≥400 → 不結算 ──
  facilitator.reset();
  upstash.list(QUEUE_KEY).length = 0;
  const app = makeApp("v2");
  const me = buyer();
  const sig = await me.signV2(await app.request(SIGNALS));
  signalFails = true;
  const r = await quiet(() => app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } }));
  signalFails = false;
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("PAYMENT-RESPONSE"), null);
  assert.equal(facilitator.count("/verify"), 1);
  assert.equal(facilitator.count("/settle"), 0, "handler 失敗：不結算，買方不被扣款");
  assert.equal(queue().length, 0);
  // 同一張授權還沒被用掉，handler 恢復後可以再用。
  assert.equal((await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": sig } })).status, 200);
  ok("v2：handler 回 ≥400 → 不 settle、不入列；授權未被消耗");
}

{
  // ── ledger 未設定／寫入失敗：資料照給，settled:false ──
  facilitator.reset();
  const app = makeApp("v2");
  const me = buyer();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  const r = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": await me.signV2(await app.request(SIGNALS)) } });
  process.env.UPSTASH_REDIS_REST_URL = url;
  assert.equal(r.status, 200);
  const j = (await r.json()) as { settled: boolean; settleError?: string; data: unknown };
  assert.equal(j.settled, false);
  assert.match(j.settleError ?? "", /UPSTASH/);
  assert.ok(j.data);
  ok("v2：ledger 未設定 → 資料照給、settled:false、settleError 點名缺的 env（與 v1 相同）");
}

{
  const app = makeApp("v2");
  const disc = (await (await app.request(`${BASE}/`)).json()) as { x402: { protocol: string; versions: number[]; network: string; extensions?: unknown } };
  assert.deepEqual([disc.x402.protocol, disc.x402.versions, disc.x402.network], ["v2", [2], "eip155:84532"]);
  assert.equal(disc.x402.extensions, undefined, "不宣告 payment-identifier");
  ok("v2：GET / 多出 x402 區塊（protocol、versions、network、headers）");
}

{
  // ── X402_NETWORK 無效：app 照常起來，只有付費端點 503，啟動時印一行錯誤 ──
  for (const protocol of ["v2", "both"] as const) {
    facilitator.reset();
    const { result: app, lines } = await captureLogs(async () => makeApp(protocol, { x402Network: "polygon-amoy" }));
    assert.ok(lines.some((l) => l.includes("v2 付費牆無法建立") && l.includes("polygon-amoy")), `${protocol}：啟動時一行錯誤`);
    assert.equal((await app.request(`${BASE}/healthz`)).status, 200, `${protocol}：免費端點照常`);
    const disc = (await (await app.request(`${BASE}/`)).json()) as { x402: { error: string } };
    assert.equal(disc.x402.error, "x402_misconfigured");
    for (const path of [SIGNALS, `${BASE}/oracle/sBTC`]) {
      const r = await app.request(path);
      assert.equal(r.status, 503, `${protocol} ${path}：付費端點 503`);
      assert.equal(((await r.json()) as { error: string }).error, "x402_misconfigured");
      assert.equal(r.headers.get("PAYMENT-REQUIRED"), null);
    }
    // 帶付款 header 也一樣：不送 facilitator。
    const paid = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": b64({ x402Version: 2 }), "X-PAYMENT": b64({ x402Version: 1 }) } });
    assert.equal(paid.status, 503);
    assert.equal(facilitator.calls.length, 0, `${protocol}：完全不碰 facilitator`);
  }
  ok("X402_NETWORK 無效（v2／both）：app 照常啟動、啟動時一行錯誤；付費端點 503 x402_misconfigured（不發 402、不碰 facilitator）；免費端點照常");
}

// ════════════════════════════════════════════════════════════════════════════
// both 模式
// ════════════════════════════════════════════════════════════════════════════
{
  facilitator.reset();
  const app = makeApp("both");
  const res = await app.request(SIGNALS);
  assert.equal(res.status, 402);
  const g = v1Golden[0]!;
  assert.equal(await res.clone().text(), g.body, "both：402 的 body 與 v1 逐字相同");
  const required = unb64(res.headers.get("PAYMENT-REQUIRED"));
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts[0].network, "eip155:84532");
  assert.equal(required.resource.url, SIGNALS);
  // header：v1 的全部保留，只多出 v2 的兩個。
  const got = new Map([...res.headers.entries()]);
  for (const [k, v] of g.headers) assert.equal(got.get(k), v, `v1 的 header ${k} 必須保留`);
  assert.deepEqual([...got.keys()].filter((k) => !g.headers.some(([gk]) => gk === k)).sort(), ["cache-control", "payment-required"]);
  assert.equal(got.get("cache-control"), "no-store");

  // 瀏覽器：v1 的 HTML 付費牆照舊，header 一樣疊上 v2。
  const html = await app.request(SIGNALS, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } });
  assert.equal(html.status, 402);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  assert.ok(html.headers.get("PAYMENT-REQUIRED"));
  // 非付費路由不受影響。
  const free = await app.request(`${BASE}/healthz`);
  assert.equal(free.headers.get("PAYMENT-REQUIRED"), null);
  ok("both 未付款：body 與 v1 golden 逐字相同，v1 的 header 全部保留，只多出 PAYMENT-REQUIRED（v2）與 Cache-Control: no-store");
}

{
  facilitator.reset();
  upstash.list(QUEUE_KEY).length = 0;
  signalReads = 0;
  const app = makeApp("both");
  const me = buyer();

  // v2 付款
  const p2 = await app.request(SIGNALS, { headers: { "PAYMENT-SIGNATURE": await me.signV2(await app.request(SIGNALS), { paymentId: "pay_both_mode_0123456789" }) } });
  assert.equal(p2.status, 200);
  const settleV2 = unb64(p2.headers.get("PAYMENT-RESPONSE"));
  assert.equal(settleV2.success, true);
  assert.equal(p2.headers.get("X-PAYMENT-RESPONSE"), null);
  assert.equal(((await p2.json()) as { settled: boolean }).settled, true);

  // v1 付款（x402 0.5.3 的 client，對同一個 app、同一個路由）
  const xPayment = await me.signV1(await app.request(SIGNALS));
  const sentV1 = unb64(xPayment);
  assert.equal(sentV1.x402Version, 1);
  assert.equal(sentV1.network, "base-sepolia");
  const p1 = await app.request(SIGNALS, { headers: { "X-PAYMENT": xPayment } });
  assert.equal(p1.status, 200);
  const settleV1 = unb64(p1.headers.get("X-PAYMENT-RESPONSE"));
  assert.equal(settleV1.success, true);
  assert.equal(p1.headers.get("PAYMENT-RESPONSE"), null, "v1 付款只回 v1 的 header");
  assert.equal(p1.headers.get("PAYMENT-REQUIRED"), null);
  assert.equal(((await p1.json()) as { settled: boolean }).settled, true);

  const versions = facilitator.calls.filter((c) => c.path === "/settle").map((c) => c.x402Version);
  assert.deepEqual(versions, [2, 1], "facilitator 依序收到 v2 與 v1 的結算");
  const q = queue();
  assert.equal(q.length, 2);
  assert.equal(q[0]!.idempotencyKey, `tx:${settleV2.transaction}`, "v2 也是結算 tx hash");
  assert.equal(q[0]!.paymentId, "pay_both_mode_0123456789", "payment-identifier 只當中繼資料");
  assert.equal(q[1]!.idempotencyKey, `tx:${settleV1.transaction}`, "v1 維持現行鍵（結算 tx hash）");
  assert.equal(signalReads, 2);

  // 兩種 header 同時帶 → 400，兩張授權都不送 facilitator。
  const before = facilitator.calls.length;
  const both = await app.request(SIGNALS, {
    headers: { "PAYMENT-SIGNATURE": await me.signV2(await app.request(SIGNALS)), "X-PAYMENT": await me.signV1(await app.request(SIGNALS)) },
  });
  assert.equal(both.status, 400);
  assert.equal(((await both.json()) as { error: string }).error, "ambiguous_payment_headers");
  assert.equal(facilitator.calls.length, before);
  assert.equal(queue().length, 2);
  ok("both：同一個路由 v2（PAYMENT-SIGNATURE）與 v1（X-PAYMENT）都能付款、各回各的 header、各用各的冪等鍵；兩種 header 同時帶 → 400");
}

{
  // both：v1 的 facilitator 錯誤對應照舊；v2 的基礎設施壞掉不拖垮 v1。
  facilitator.reset();
  const app = makeApp("both");
  const me = buyer();
  const xPayment = await me.signV1(await app.request(SIGNALS));
  facilitator.mode = "verify_http429";
  const r = await app.request(SIGNALS, { headers: { "X-PAYMENT": xPayment } });
  assert.equal(r.status, 429);
  assert.equal(((await r.json()) as { error: string }).error, "facilitator_rate_limited");

  facilitator.reset();
  facilitator.mode = "supported_http503";
  let clock = 9_000_000;
  const degraded = makeApp("both", { x402V2Timing: { now: () => clock } });
  const d = await quiet(() => degraded.request(SIGNALS));
  assert.equal(d.status, 402, "/supported 失敗：仍發出 v1 的 402");
  assert.equal(await d.text(), v1Golden[0]!.body);
  assert.equal(d.headers.get("PAYMENT-REQUIRED"), null, "這一次只宣告 v1");
  facilitator.mode = "ok";
  const supportedCalls = facilitator.count("/supported");
  const d2 = await quiet(() => degraded.request(SIGNALS));
  assert.equal(d2.status, 402);
  assert.equal(d2.headers.get("PAYMENT-REQUIRED"), null, "退避期內仍只宣告 v1");
  assert.equal(facilitator.count("/supported"), supportedCalls, "退避期內不打 /supported");
  clock += 30_001;
  assert.ok((await degraded.request(SIGNALS)).headers.get("PAYMENT-REQUIRED"), "退避期滿、恢復後重新宣告 v2");

  // both 的 payTo 守門
  const unsafe = makeApp("both", { payoutCodeReader: { getCode: async () => "0x6080" }, payTo: "0x8888888888888888888888888888888888888888" });
  const u = await quiet(() => unsafe.request(SIGNALS));
  assert.equal(u.status, 503);
  assert.equal(u.headers.get("PAYMENT-REQUIRED"), null);
  ok("both：v1 的 429／502 對應照舊；v2 的 /supported 失敗時降級為只宣告 v1（30 秒退避）；payTo 守門對兩種協定都 fail-closed");
}

{
  // ── both：/supported 掛住 → 未付款的 v1 402 只等短逾時（2.5 秒），之後同一輪初始化不再等 ──
  facilitator.reset();
  const real = new HTTPFacilitatorClient({ url: facilitator.url });
  let releaseSupported!: () => void;
  const supportedGate = new Promise<void>((r) => (releaseSupported = r));
  let supportedCalls = 0;
  const hungClient: FacilitatorClient = {
    verify: (p, r) => real.verify(p, r),
    settle: (p, r) => real.settle(p, r),
    getSupported: async () => {
      supportedCalls += 1;
      await supportedGate; // 掛住，直到測試放行
      return real.getSupported();
    },
  };
  // 注入的計時器：記下每次等待的上限；短逾時（≤ 3 秒）立即到期，長的永不到期。不用牆上時間。
  const waits: number[] = [];
  const timer = (ms: number) => {
    waits.push(ms);
    return { promise: ms <= 3_000 ? Promise.resolve() : new Promise<void>(() => {}), cancel() {} };
  };
  const app = makeApp("both", { x402FacilitatorClient: hungClient, x402V2Timing: { timer } });

  const first = await quiet(() => app.request(SIGNALS));
  assert.equal(first.status, 402);
  assert.equal(await first.text(), v1Golden[0]!.body, "v1 的 402 本文不變");
  assert.equal(first.headers.get("PAYMENT-REQUIRED"), null, "逾時 → 只宣告 v1");
  assert.deepEqual(waits, [2_500], "未付款 402 只等 2.5 秒");
  assert.equal(supportedCalls, 1);

  for (let i = 0; i < 3; i += 1) {
    const again = await quiet(() => app.request(SIGNALS));
    assert.equal(again.status, 402);
    assert.equal(again.headers.get("PAYMENT-REQUIRED"), null);
  }
  assert.deepEqual(waits, [2_500], "同一輪初始化已逾時過一次：其他未付款請求不再等");
  assert.equal(supportedCalls, 1, "single-flight：只打一次 /supported");

  releaseSupported();
  // 等背景那一輪初始化完成（有上限的事件迴圈輪數，不是牆上時間）。
  let recovered = await quiet(() => app.request(SIGNALS));
  for (let i = 0; i < 200 && !recovered.headers.get("PAYMENT-REQUIRED"); i += 1) {
    await new Promise((r) => setImmediate(r));
    recovered = await quiet(() => app.request(SIGNALS));
  }
  assert.equal(recovered.status, 402);
  assert.ok(recovered.headers.get("PAYMENT-REQUIRED"), "/supported 回來之後重新宣告 v2");
  assert.equal(await recovered.text(), v1Golden[0]!.body);
  ok("both：/supported 掛住 → 未付款 402 只等 2.5 秒就只回 v1（本文不變）、同一輪初始化其他請求不再等；回來後重新宣告 v2");
}

await facilitator.close();
await upstash.close();
await rpc.close();
console.log(`\n✅ x402v2.test.ts 全過（${n} 組）`);
