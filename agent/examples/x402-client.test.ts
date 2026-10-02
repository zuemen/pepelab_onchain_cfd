// x402 client 防護：單筆上限解析 + 實付計量。離線（假 fetch），不付任何錢。
//   cd agent && npx tsx examples/x402-client.test.ts
import assert from "node:assert";
import {
  parseUsdcAtomic,
  formatUsdcAtomic,
  resolveX402MaxValue,
  meteredFetch,
  paymentValueFromHeader,
  hasSettlementProof,
} from "@pepelab/shared";

// ── 金額解析 / 預設上限 ──────────────────────────────────────────────────────
assert.equal(parseUsdcAtomic("0.02"), 20_000n);
assert.equal(parseUsdcAtomic("1"), 1_000_000n);
assert.equal(parseUsdcAtomic("0.000001"), 1n);
assert.throws(() => parseUsdcAtomic("0.0000001"), "超過 6 位小數要拒絕");
assert.throws(() => parseUsdcAtomic("-1"));
assert.equal(formatUsdcAtomic(5_000n), "0.005");
assert.equal(formatUsdcAtomic(1_000_000n), "1");

delete process.env.X402_MAX_PAYMENT_USDC;
assert.equal(resolveX402MaxValue(), 20_000n, "預設 0.02 USDC（不是 x402-fetch 的 0.10）");
process.env.X402_MAX_PAYMENT_USDC = "0.005";
assert.equal(resolveX402MaxValue(), 5_000n);
process.env.X402_MAX_PAYMENT_USDC = "0";
assert.throws(() => resolveX402MaxValue(), "0 不是合法上限");
delete process.env.X402_MAX_PAYMENT_USDC;
console.log("✓ X402_MAX_PAYMENT_USDC 解析，預設 0.02 USDC");

// ── 實付計量 ─────────────────────────────────────────────────────────────────
const xPayment = (value: string) =>
  Buffer.from(JSON.stringify({ payload: { authorization: { value } } })).toString("base64");
assert.equal(paymentValueFromHeader(xPayment("5000")), 5_000n);
assert.equal(paymentValueFromHeader("garbage"), null);

let nextStatus = 200;
let nextPaidHeader = true;
const fakeFetch = (async () =>
  new Response("{}", {
    status: nextStatus,
    headers: nextPaidHeader ? { "X-PAYMENT-RESPONSE": "e30=" } : {},
  })) as unknown as typeof fetch;

const m = meteredFetch(fakeFetch);
// 第一次請求（沒帶 X-PAYMENT，= 402 挑戰那一趟）→ 不計
nextStatus = 402;
nextPaidHeader = false;
await m.fetch("http://x/oracle/sBTC", { method: "GET" });
assert.equal(m.totalPaidAtomic(), 0n);
// 帶 X-PAYMENT 重送、付款成立 → 以簽出的實際金額計
nextStatus = 200;
nextPaidHeader = true;
await m.fetch("http://x/oracle/sBTC", { method: "GET", headers: { "X-PAYMENT": xPayment("5000") } });
await m.fetch("http://x/signals/0x1", { method: "GET", headers: { "X-PAYMENT": xPayment("10000") } });
assert.equal(m.totalPaidAtomic(), 15_000n);
assert.equal(m.lastPaidAtomic(), 10_000n);
// 帶了授權但 facilitator 驗證失敗（402、沒有 X-PAYMENT-RESPONSE）→ 不計
nextStatus = 402;
nextPaidHeader = false;
await m.fetch("http://x/oracle/sBTC", { method: "GET", headers: { "X-PAYMENT": xPayment("5000") } });
assert.equal(m.totalPaidAtomic(), 15_000n);
assert.equal(m.lastPaidAtomic(), null);
console.log("✓ meteredFetch 以實際簽出且成立的金額累計");

// ── x402 v2：PAYMENT-SIGNATURE／PAYMENT-RESPONSE ────────────────────────────────
{
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  // v2 的 PaymentPayload：金額同樣在 payload.authorization.value。
  const sig = (value: string) =>
    b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532", amount: value }, payload: { signature: "0x", authorization: { value } } });
  assert.equal(paymentValueFromHeader(sig("5000")), 5_000n);
  // Permit2 payload 沒有 authorization.value → 解不出來（由呼叫端以單筆上限保守計入）。
  assert.equal(paymentValueFromHeader(b64({ x402Version: 2, payload: { permit2Authorization: { permitted: { amount: "5000" } } } })), null);

  const ok = b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:84532" });
  const failed = b64({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
  assert.equal(hasSettlementProof(new Headers({ "PAYMENT-RESPONSE": ok })), true);
  assert.equal(hasSettlementProof(new Headers({ "PAYMENT-RESPONSE": failed })), false, "v2：success:false 不是結算證明");
  assert.equal(hasSettlementProof(new Headers({ "PAYMENT-RESPONSE": "garbage" })), false);
  assert.equal(hasSettlementProof(new Headers({ "X-PAYMENT-RESPONSE": "e30=" })), true, "v1：有 header 就算（只在成功時出現）");
  assert.equal(hasSettlementProof(new Headers()), false);

  let status = 200;
  let responseHeader: string | null = ok;
  const m2 = meteredFetch((async () =>
    new Response("{}", { status, headers: responseHeader ? { "PAYMENT-RESPONSE": responseHeader } : {} })) as unknown as typeof fetch);

  // 成立：200 + PAYMENT-RESPONSE success:true。@x402/fetch 以 Request 物件呼叫底層 fetch。
  await m2.fetch(new Request("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": sig("5000") } }));
  assert.deepEqual([m2.totalSentAtomic(), m2.unsettledAtomic(), m2.totalPaidAtomic(), m2.lastPaidAtomic()], [5_000n, 0n, 5_000n, 5_000n]);

  // 結算被拒：402 + PAYMENT-RESPONSE success:false → 已送出、未結算、不算已付。
  status = 402;
  responseHeader = failed;
  await m2.fetch("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": sig("5000") } });
  assert.deepEqual([m2.totalSentAtomic(), m2.unsettledAtomic(), m2.totalPaidAtomic(), m2.lastPaidAtomic()], [10_000n, 5_000n, 5_000n, null]);

  // 502（facilitator 結算結果未知）→ 已送出、未結算。
  status = 502;
  responseHeader = null;
  await m2.fetch("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": sig("10000") } });
  assert.deepEqual([m2.totalSentAtomic(), m2.unsettledAtomic(), m2.totalPaidAtomic()], [20_000n, 15_000n, 5_000n]);

  // 沒帶付款（402 挑戰那一趟，回應帶 PAYMENT-REQUIRED）→ 不計。
  status = 402;
  await m2.fetch("http://x/oracle/sBTC");
  assert.equal(m2.totalSentAtomic(), 20_000n);

  // 兩種 header 同時帶：各是一張獨立的授權，金額相加。
  status = 400;
  await m2.fetch("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": sig("5000"), "X-PAYMENT": xPayment("10000") } });
  assert.equal(m2.totalSentAtomic(), 35_000n);
  assert.equal(m2.unsettledAtomic(), 30_000n);

  // 帶了 PAYMENT-SIGNATURE 卻解不出金額（例如 Permit2）→ 以單筆上限保守計入。
  await m2.fetch("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": "not-base64-json" } });
  assert.equal(m2.totalSentAtomic(), 35_000n + 20_000n);
  // globalThis.Request 被換掉（@hono/node-server 會這麼做）時，原生 Request 不再是它的 instance ——
  // 計量不可以因此漏掉。x402-mock-e2e.ts 實際踩到過：v2 的付款整筆沒被計入。
  {
    const Native = globalThis.Request;
    const nativeReq = new Native("http://x/oracle/sBTC", { headers: { "PAYMENT-SIGNATURE": sig("5000") } });
    class Patched extends Native {}
    globalThis.Request = Patched as typeof Request;
    try {
      assert.equal(nativeReq instanceof globalThis.Request, false, "前提：原生 Request 不是被換掉後的 Request 的 instance");
      status = 200;
      responseHeader = ok;
      const before = m2.totalSentAtomic();
      await m2.fetch(nativeReq);
      assert.equal(m2.totalSentAtomic(), before + 5_000n, "仍然計入");
      assert.equal(m2.lastPaidAtomic(), 5_000n);
    } finally {
      globalThis.Request = Native;
    }
  }
  console.log("✓ meteredFetch 認得 v2 的 PAYMENT-SIGNATURE／PAYMENT-RESPONSE（success:false 不算結算；兩種 header 相加；解不出來以上限計；globalThis.Request 被換掉也不漏計）");
}

console.log("\n✅ x402-client.test.ts 全過");
