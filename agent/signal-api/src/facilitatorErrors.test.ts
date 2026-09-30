// facilitator 出錯時付費牆回什麼。離線：用本機 stub 取代 facilitator，不打網路、不送交易。
//   cd agent && npx tsx signal-api/src/facilitatorErrors.test.ts
//
// 背景：x402-hono 0.5.3 對 /verify 的非 200 直接 throw，未處理時買方拿到通用 500。
// 見 docs/KNOWN_LIMITATIONS.md §16。
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Mode = "http429" | "http503" | "invalid_rate_limit" | "invalid_signature";
let mode: Mode = "http429";

const stub: Server = createServer((req, res) => {
  if (req.url !== "/verify") {
    res.writeHead(404).end();
    return;
  }
  const payer = "0x1111111111111111111111111111111111111111";
  switch (mode) {
    case "http429":
      res.writeHead(429, { "Content-Type": "application/json" }).end('{"error":"rate_limit_exceeded"}');
      return;
    case "http503":
      res.writeHead(503).end();
      return;
    case "invalid_rate_limit":
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ isValid: false, invalidReason: "rate_limit_exceeded", payer }));
      return;
    case "invalid_signature":
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer }));
  }
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
const port = (stub.address() as AddressInfo).port;

// app.ts 在 import 時讀 env，必須先設好再動態載入。
process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${port}`;
process.env.X402_NETWORK = "base-sepolia";
// app.ts 頂層無條件呼叫 makeProvider()，需要這個 env 才建得起來——CI 上沒有
// agent/.env，不設就會在 import 這一步直接丟錯。沿用 examples/api-gate.test.ts
// 的慣例：假 RPC，反正這支測試從不真的打鏈上。
process.env.BASE_SEPOLIA_RPC_URL ??= "http://127.0.0.1:1";
const { createApp, classifyFacilitatorFailure } = await import("./app.ts");
// P0：payTo 守門會在 402 前檢查收款地址。這支測的是 facilitator 錯誤，所以給一個
// 「安全的 EOA」payTo 與假 getCode（回 "0x" = 無 code），不打 RPC。
const PAYTO_EOA = "0x4444444444444444444444444444444444444444";
const app = createApp({
  payTo: PAYTO_EOA,
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => true, // 這支不測 registry 閘門
});

// ── 純函式 ───────────────────────────────────────────────────────────────────
assert.equal(classifyFacilitatorFailure("Failed to verify payment: Too Many Requests")?.status, 429);
assert.equal(classifyFacilitatorFailure("rate_limit_exceeded")?.status, 429);
assert.equal(classifyFacilitatorFailure("Failed to verify payment: Service Unavailable")?.status, 502);
assert.equal(classifyFacilitatorFailure("fetch failed")?.status, 502);
// 不認得的錯誤不包裝——自己的 bug 不該被說成 facilitator 掛了。
assert.equal(classifyFacilitatorFailure("Cannot read properties of undefined"), null);
assert.equal(classifyFacilitatorFailure("invalid_exact_evm_payload_signature"), null);
assert.equal(classifyFacilitatorFailure(undefined), null);
console.log("classifyFacilitatorFailure ✓");

// ── 經過真正的 paymentMiddleware ─────────────────────────────────────────────
const trader = "0x5555555555555555555555555555555555555555";
const now = Math.floor(Date.now() / 1000);
const xPayment = Buffer.from(
  JSON.stringify({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: PAYTO_EOA,
        value: "10000",
        validAfter: String(now - 600),
        validBefore: String(now + 60),
        nonce: "0x" + "cd".repeat(32),
      },
    },
  }),
).toString("base64");

// 沒帶 X-PAYMENT：包一層之後仍是原本的 402 挑戰，且宣告 maxTimeoutSeconds=60（P3）。
{
  const r0 = await app.request(`/signals/${trader}`);
  assert.equal(r0.status, 402);
  const j0 = (await r0.json()) as { accepts: { maxTimeoutSeconds: number }[] };
  assert.equal(j0.accepts[0].maxTimeoutSeconds, 60);
  console.log("unpaid request → 402 challenge with maxTimeoutSeconds=60 ✓");
}

async function call(m: Mode) {
  mode = m;
  const r = await app.request(`/signals/${trader}`, { headers: { "X-PAYMENT": xPayment } });
  return { status: r.status, retryAfter: r.headers.get("Retry-After"), body: (await r.json()) as Record<string, unknown> };
}

let r = await call("http429");
assert.equal(r.status, 429, `HTTP 429 from facilitator → 429, got ${r.status}`);
assert.equal(r.body.error, "facilitator_rate_limited");
assert.ok(Number(r.retryAfter) > 0, "must carry Retry-After");
console.log("facilitator HTTP 429 → 429 + Retry-After ✓");

r = await call("http503");
assert.equal(r.status, 502, `HTTP 503 from facilitator → 502, got ${r.status}`);
assert.equal(r.body.error, "facilitator_unavailable");
console.log("facilitator HTTP 503 → 502 ✓");

r = await call("invalid_rate_limit");
assert.equal(r.status, 429, `isValid:false rate_limit_exceeded → 429, got ${r.status}`);
console.log("facilitator 200 isValid:false rate_limit_exceeded → 429 ✓");

// 真正的驗證失敗維持 402，行為不變。
r = await call("invalid_signature");
assert.equal(r.status, 402);
assert.equal(r.body.error, "invalid_exact_evm_payload_signature");
console.log("real verification failure stays 402 ✓");

await new Promise<void>((r) => stub.close(() => r()));
console.log("facilitatorErrors.test.ts ✓ all assertions passed");
