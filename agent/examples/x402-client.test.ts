// x402 client 防護：單筆上限解析 + 實付計量。離線（假 fetch），不付任何錢。
//   cd agent && npx tsx examples/x402-client.test.ts
import assert from "node:assert";
import {
  parseUsdcAtomic,
  formatUsdcAtomic,
  resolveX402MaxValue,
  meteredFetch,
  paymentValueFromHeader,
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

console.log("\n✅ x402-client.test.ts 全過");
