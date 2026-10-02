// x402-mock-e2e.ts — 用**本機假 facilitator** 把 x402 v1 與 v2 的付款各跑通一次。
//
// 完全離線：不連網、不送鏈上交易、不付任何款項。金鑰是當場隨機產生的測試金鑰（沒有任何資產）。
//   cd agent && npx tsx examples/x402-mock-e2e.ts
//
// 跑的是真的東西，只有「錢」是假的：
//   - 伺服器：真的 signal-api（createApp，X402_PROTOCOL=both），聽在本機隨機 port 的真 HTTP 上。
//   - facilitator：signal-api/src/testing/mockFacilitator.ts —— /verify 會真的驗 EIP-712 簽章、
//     收款人、金額、有效期；/settle 不上鏈，只回一個假的 tx hash。
//   - 付款端：官方 client 套件（v1 = x402-fetch 0.5.x；v2 = @x402/fetch + @x402/evm 2.x）加上本專案的
//     簽章守門（guardViemAccount）與計量（meteredFetch），以及 SDK 的 SignalApiClient。
//
// 四段流程（對同一個端點 GET /signals/:trader，0.01 USDC）：
//   A. v1：x402-fetch            → X-PAYMENT           → X-PAYMENT-RESPONSE
//   B. v2：@x402/fetch           → PAYMENT-SIGNATURE   → PAYMENT-RESPONSE
//   C. SDK（auto → v2，呼叫端選用 payment-identifier：只當中繼資料，不參與去重）
//   D. SDK（x402Protocol: "v1"）
// 最後印出結算帳本佇列裡的四筆與各自的冪等鍵。每一步都有 assert，所以它同時是一支測試
// （npm run test:api 會跑）。
//
// 見 docs/ADR-010-x402-v2-migration.md。
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createWalletClient, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment as wrapFetchV1 } from "x402-fetch";
import { createPaymentHeader as createV1PaymentHeader } from "x402/client";
import { wrapFetchWithPayment as wrapFetchV2, x402Client } from "@x402/fetch";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { startMockFacilitator } from "../signal-api/src/testing/mockFacilitator.ts";
import { startFakeUpstash } from "../signal-api/src/testing/fakeUpstash.ts";
import { startRpcStub } from "../signal-api/src/testing/rpcStub.ts";

const PAYTO = "0x4444444444444444444444444444444444444444";
const TRADER = "0x5555555555555555555555555555555555555555";

// ── 1) 假的外部依賴：facilitator、Upstash、RPC ───────────────────────────────
const facilitator = await startMockFacilitator();
const upstash = await startFakeUpstash();
const rpc = await startRpcStub();

// app.ts 與簽章守門在 import／呼叫時讀 env：先設好再動態載入。這支不讀 agent/.env。
process.env.X402_FACILITATOR_URL = facilitator.url;
process.env.X402_NETWORK = "base-sepolia";
process.env.BASE_SEPOLIA_RPC_URL = rpc.url;
process.env.UPSTASH_REDIS_REST_URL = upstash.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";
process.env.X402_PAYTO_ALLOWLIST = PAYTO; // 簽章守門：只准付給這個收款地址
for (const k of ["PAY_TO", "X402_PROTOCOL", "X402_MAX_PAYMENT_USDC", "X402_MAX_TOTAL_SPEND_USDC", "LOOP_MAX_SPEND_USDC", "X402_MAX_VALIDITY_SEC"]) {
  delete process.env[k];
}

const { createApp } = await import("../signal-api/src/app.ts");
const { QUEUE_KEY } = await import("../signal-api/src/ledger.ts");
const {
  guardViemAccount, meteredFetch, resolveX402MaxValue, formatUsdcAtomic,
  x402V2SpendControls, x402V2Eip3009OnlyPolicy, x402SignedTotal, resetX402GuardStateForTesting,
} = await import("@pepelab/shared");
const { SignalApiClient } = await import("../sdk/src/index.ts");

// ── 2) 伺服器：真的 signal-api，both 模式，本機隨機 port ─────────────────────
const app = createApp({
  x402Protocol: "both",
  payTo: PAYTO,
  // 以下三個是 createApp 的測試接縫：收款地址當成 EOA、trader 當成已註冊、訊號不讀鏈。
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => true,
  signalReader: async (trader) => ({ trader, note: "mock signal (x402-mock-e2e)" }),
});
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const URL_SIGNALS = `${BASE}/signals/${TRADER}`;
console.log(`▶ signal-api（X402_PROTOCOL=both）  ${BASE}`);
console.log(`▶ mock facilitator                 ${facilitator.url}\n`);

// ── 3) 付款端：隨機測試金鑰 + 簽章守門 + 計量 ────────────────────────────────
resetX402GuardStateForTesting();
const account = guardViemAccount(privateKeyToAccount(generatePrivateKey()));
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc.url) }).extend(publicActions);
const meter = meteredFetch();
const b64json = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);
const queue = () => upstash.list(QUEUE_KEY).map((s) => JSON.parse(s) as { source: string; feeUsd: number; idempotencyKey: string; paymentId?: string });

// 未付款的 402：both 模式同時宣告 v1（body）與 v2（PAYMENT-REQUIRED header）。
{
  const r = await fetch(URL_SIGNALS);
  assert.equal(r.status, 402);
  const body = (await r.json()) as { x402Version: number; accepts: { network: string; maxAmountRequired: string; maxTimeoutSeconds: number }[] };
  const v2 = b64json(r.headers.get("PAYMENT-REQUIRED"));
  assert.equal(body.x402Version, 1);
  assert.equal(v2.x402Version, 2);
  console.log("未付款 → 402");
  console.log(`  v1（body）                 network=${body.accepts[0]!.network}  maxAmountRequired=${body.accepts[0]!.maxAmountRequired}  maxTimeoutSeconds=${body.accepts[0]!.maxTimeoutSeconds}`);
  console.log(`  v2（PAYMENT-REQUIRED）     network=${v2.accepts[0].network}  amount=${v2.accepts[0].amount}  maxTimeoutSeconds=${v2.accepts[0].maxTimeoutSeconds}  extensions=${Object.keys(v2.extensions ?? {}).join(",")}\n`);
}

// ── A) v1：x402-fetch ────────────────────────────────────────────────────────
{
  const payFetch = wrapFetchV1(
    meter.fetch,
    wallet as unknown as Parameters<typeof wrapFetchV1>[1],
    resolveX402MaxValue(),
  ) as unknown as typeof fetch;
  const res = await payFetch(URL_SIGNALS, { method: "GET" });
  assert.equal(res.status, 200);
  const settle = b64json(res.headers.get("X-PAYMENT-RESPONSE"));
  assert.equal(settle.success, true);
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), null);
  const body = (await res.json()) as { ok: boolean; settled: boolean };
  assert.deepEqual([body.ok, body.settled], [true, true]);
  console.log(`A. v1  x402-fetch          200  X-PAYMENT-RESPONSE.transaction=${settle.transaction.slice(0, 18)}…  settled=${body.settled}`);
}

// ── B) v2：@x402/fetch ───────────────────────────────────────────────────────
const v2Client = new x402Client().register("eip155:84532", new ExactEvmScheme(account));
v2Client.setSpendControls(x402V2SpendControls()); // 單筆上限沿用 X402_MAX_PAYMENT_USDC（套件預設是 $1）
v2Client.registerPolicy(x402V2Eip3009OnlyPolicy as Parameters<typeof v2Client.registerPolicy>[0]); // 不選 Permit2／upfront
{
  const payFetch = wrapFetchV2(meter.fetch, v2Client);
  const res = await payFetch(URL_SIGNALS, { method: "GET" });
  assert.equal(res.status, 200);
  const settle = b64json(res.headers.get("PAYMENT-RESPONSE"));
  assert.equal(settle.success, true);
  assert.equal(settle.network, "eip155:84532");
  assert.equal(res.headers.get("X-PAYMENT-RESPONSE"), null);
  const body = (await res.json()) as { ok: boolean; settled: boolean };
  assert.deepEqual([body.ok, body.settled], [true, true]);
  console.log(`B. v2  @x402/fetch         200  PAYMENT-RESPONSE.transaction=${settle.transaction.slice(0, 18)}…    settled=${body.settled}`);
}

// ── C、D) SDK：同一個簽署端同時實作 v1 與 v2 ─────────────────────────────────
const sdkPayment = {
  // v1
  createPaymentHeader: ({ requirements, x402Version }: { requirements: unknown; x402Version: number }) =>
    createV1PaymentHeader(wallet as never, x402Version, requirements as never),
  // v2：只把 SDK 挑好的那一筆交給官方 client 簽。
  createPaymentSignature: async ({ paymentRequired, requirements }: { paymentRequired: any; requirements: any }) =>
    encodePaymentSignatureHeader(await v2Client.createPaymentPayload({ ...paymentRequired, accepts: [requirements] })),
};
{
  const sdk = new SignalApiClient({ baseUrl: BASE, payment: sdkPayment, payToAllowlist: [PAYTO] });
  const r = await sdk.getSignal(TRADER, { paymentId: "demo_order_0000000000000001" });
  assert.equal(r.payment!.x402Version, 2, "auto：伺服器宣告 v2 且簽署端支援 → v2");
  assert.equal(r.payment!.paymentId, "demo_order_0000000000000001");
  assert.equal(r.body.settled, true);
  assert.equal(sdk.unsettledAtomic(), 0n);
  console.log(`C. v2  SDK（auto）         200  paid=${r.payment!.paidUsdc} USDC  network=${r.payment!.network}  paymentId=${r.payment!.paymentId}`);

  const sdkV1 = new SignalApiClient({ baseUrl: BASE, payment: sdkPayment, payToAllowlist: [PAYTO], x402Protocol: "v1" });
  const r1 = await sdkV1.getSignal(TRADER);
  assert.equal(r1.payment!.x402Version, 1);
  assert.equal(r1.payment!.paymentId, null);
  assert.equal(sdkV1.unsettledAtomic(), 0n);
  console.log(`D. v1  SDK（x402Protocol） 200  paid=${r1.payment!.paidUsdc} USDC  network=${r1.payment!.network}`);
}

// ── 結果 ─────────────────────────────────────────────────────────────────────
const q = queue();
console.log("\n結算帳本佇列（每筆 0.01 USDC 的 70/20/10 分潤，等 worker 處理）：");
for (const [i, e] of q.entries()) console.log(`  ${i + 1}. source=${e.source}  feeUsd=${e.feeUsd}  idempotencyKey=${e.idempotencyKey.slice(0, 60)}${e.idempotencyKey.length > 60 ? "…" : ""}`);
assert.equal(q.length, 4, "四筆付款各入列一筆");
assert.match(q[0]!.idempotencyKey, /^tx:0x[0-9a-f]{64}$/, "A（v1）：結算 tx hash");
assert.match(q[1]!.idempotencyKey, /^tx:0x[0-9a-f]{64}$/, "B（v2，沒帶 payment-identifier）：結算 tx hash");
assert.match(q[2]!.idempotencyKey, /^tx:0x[0-9a-f]{64}$/, "C（v2，帶 payment-identifier）：仍是結算 tx hash");
assert.equal(q[2]!.paymentId, "demo_order_0000000000000001", "C：payment-identifier 只存成中繼資料");
assert.match(q[3]!.idempotencyKey, /^tx:0x[0-9a-f]{64}$/, "D（v1）：結算 tx hash");

const settles = facilitator.calls.filter((c) => c.path === "/settle").map((c) => c.x402Version);
assert.deepEqual(settles, [1, 2, 2, 1], "facilitator 依序結算了 v1、v2、v2、v1");
// A、B 經過 meteredFetch；四筆都經過簽章守門。
assert.equal(meter.totalSentAtomic(), 20_000n);
assert.equal(meter.totalPaidAtomic(), 20_000n);
assert.equal(meter.unsettledAtomic(), 0n);
assert.equal(x402SignedTotal(), 40_000n, "簽章守門：四筆 0.01 USDC 都計入同一個累計");
console.log(
  `\nfacilitator：/supported ×${facilitator.count("/supported")}、/verify ×${facilitator.count("/verify")}、/settle ×${facilitator.count("/settle")}（x402Version ${settles.join("、")}）`,
);
console.log(`meteredFetch（A、B）：sent=${formatUsdcAtomic(meter.totalSentAtomic())}  paid=${formatUsdcAtomic(meter.totalPaidAtomic())}  unsettled=${formatUsdcAtomic(meter.unsettledAtomic())} USDC`);
console.log(`簽章守門累計（A–D）：${formatUsdcAtomic(x402SignedTotal())} USDC（全部是假 facilitator 的假結算，沒有任何鏈上交易）`);

resetX402GuardStateForTesting();
await new Promise<void>((r) => server.close(() => r()));
await facilitator.close();
await upstash.close();
await rpc.close();
console.log("\n✅ x402-mock-e2e.ts 全過：v1 與 v2 各以官方 client 與 SDK 跑通（離線、未付款）");
