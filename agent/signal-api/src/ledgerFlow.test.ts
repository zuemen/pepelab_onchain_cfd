// 優先序 1（x402 硬化：記帳 + 批次結算）的離線測試。
//   cd agent && npx tsx signal-api/src/ledgerFlow.test.ts
//
// 直接測 app.ts 匯出的 applyLedgerRecording（純函式：entry + Response → Response），
// 不透過 /signals、/oracle 的真實 handler。那兩個 handler 會讀鏈上資料
// （getTraderPerformance / getOracleSnapshot），沒有真的 Base Sepolia RPC 時
// 一定會失敗——CI（.github/workflows/agent-ci.yml）就是這種環境，
// 而 applyLedgerRecording 本身要驗證的「記帳邏輯對不對」跟「鏈上資料抓不抓得到」
// 是兩件事，這裡只測前者。用真的 Upstash 形狀的 stub 驗證持久化那一步。
//
// 這個測試完全不 import ../src/app.ts 的 createApp、完全不碰任何合約/ethers
// 相關程式碼——這是「付費回應路徑的記帳邏輯本身不依賴任何鏈上呼叫」最直接的證明：
// 這裡連 provider 都沒建過。
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ── stub Upstash REST：只認 RPUSH，維護記憶體內的 list ───────────────────────
const lists = new Map<string, string[]>();
function listFor(key: string): string[] {
  let l = lists.get(key);
  if (!l) {
    l = [];
    lists.set(key, l);
  }
  return l;
}
let upstashDown = false;
const upstash: Server = createServer(async (req, res) => {
  if (upstashDown) {
    res.destroy(); // 模擬連線失敗（不是 HTTP 錯誤，是連不上）
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const [cmd, key, ...args] = JSON.parse(Buffer.concat(chunks).toString() || "[]") as (string | number)[];
  const ok = (result: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
  if (String(cmd).toUpperCase() === "RPUSH") {
    listFor(String(key)).push(String(args[0]));
    ok(listFor(String(key)).length);
  } else {
    res.writeHead(400).end(JSON.stringify({ error: `unhandled cmd ${cmd}` }));
  }
});
await new Promise<void>((r) => upstash.listen(0, "127.0.0.1", r));
const port = (upstash.address() as AddressInfo).port;

process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
// app.ts 頂層無條件呼叫 makeProvider()（供 /oracle、/agent/:did/verification 等
// 其他路由用），只是 import 這個模組就需要這個 env 存在，即使這裡只用到
// applyLedgerRecording、完全不會走到任何鏈上呼叫。CI 上沒有 agent/.env，
// 沿用 examples/api-gate.test.ts 的慣例：假 RPC。
process.env.BASE_SEPOLIA_RPC_URL ??= "http://127.0.0.1:1";

const { applyLedgerRecording } = await import("./app.ts");
const { QUEUE_KEY } = await import("./ledger.ts");

const entry = {
  trader: "0x5555555555555555555555555555555555555555",
  feeUsd: 0.01,
  at: 0,
  source: "signals" as const,
};

function paidResponse(body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ── 1) 沒有 ledgerEntry → 原樣放行，不是這個 request 的事 ────────────────────
{
  const before = listFor(QUEUE_KEY).length;
  const res = paidResponse({ ok: true }, { "X-PAYMENT-RESPONSE": "fake" });
  const out = await applyLedgerRecording(undefined, res);
  assert.strictEqual(out, res, "沒有 entry 時應該原封不動回傳同一個 Response 物件");
  assert.equal(listFor(QUEUE_KEY).length, before);
  console.log("沒有 ledgerEntry → 原樣放行 ✓");
}

// ── 2) 有 entry，但沒有 X-PAYMENT-RESPONSE（facilitator settle 沒成功）
//      → 不記帳。這是順序 bug 的修法本身：只有確定收到錢才記。────────────────
{
  const before = listFor(QUEUE_KEY).length;
  const res402 = new Response(JSON.stringify({ ok: false, error: "settle failed" }), { status: 402 });
  const out = await applyLedgerRecording(entry, res402);
  assert.strictEqual(out, res402);
  assert.equal(listFor(QUEUE_KEY).length, before, "settle 沒成功絕對不能記帳");
  console.log("有 entry 但沒有 X-PAYMENT-RESPONSE（402）→ 不記帳 ✓");
}

// ── 3) 200 但沒帶 X-PAYMENT-RESPONSE（防禦性：理論上不會發生，但邏輯上仍要
//      以 header 為準，不是以 status 為準）────────────────────────────────
{
  const before = listFor(QUEUE_KEY).length;
  const res = paidResponse({ ok: true });
  const out = await applyLedgerRecording(entry, res);
  assert.strictEqual(out, res);
  assert.equal(listFor(QUEUE_KEY).length, before);
  console.log("200 但沒有 X-PAYMENT-RESPONSE → 不記帳 ✓");
}

// ── 4) facilitator settle 成功 + ledger 已設定 → 記一筆帳，settled:true ──────
{
  const before = listFor(QUEUE_KEY).length;
  const res = paidResponse({ ok: true, data: { fake: true } }, { "X-PAYMENT-RESPONSE": "fake" });
  const out = await applyLedgerRecording(entry, res);
  assert.equal(out.status, 200);
  const j = (await out.json()) as { ok: boolean; settled: boolean; settleError?: string; data: unknown };
  assert.equal(j.ok, true, "原本的資料欄位要保留");
  assert.equal(j.settled, true);
  assert.equal(j.settleError, undefined);
  assert.ok(j.data, "原本的 data 欄位不能被記帳邏輯洗掉");

  const after = listFor(QUEUE_KEY);
  assert.equal(after.length, before + 1, "必須剛好新增一筆佇列項目");
  const pushed = JSON.parse(after[after.length - 1]!) as { trader: string; feeUsd: number; source: string };
  assert.equal(pushed.trader, entry.trader);
  assert.equal(pushed.feeUsd, entry.feeUsd);
  assert.equal(pushed.source, entry.source);
  console.log("settle 成功 + ledger 已設定 → 記帳一筆，settled:true ✓");
}

// ── 4b) 冪等鍵：X-PAYMENT-RESPONSE 的結算 tx hash 優先，其次付款人 + EIP-3009 nonce ──
{
  const txHash = "0x" + "ab".repeat(32);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const xPaymentResponse = b64({ success: true, transaction: txHash, network: "base-sepolia", payer: "0x1" });
  const xPayment = b64({ payload: { authorization: { from: "0x" + "11".repeat(20), nonce: "0x" + "cd".repeat(32) } } });

  await applyLedgerRecording(entry, paidResponse({ ok: true }, { "X-PAYMENT-RESPONSE": xPaymentResponse }), xPayment);
  let pushed = JSON.parse(listFor(QUEUE_KEY).at(-1)!) as { idempotencyKey?: string };
  assert.equal(pushed.idempotencyKey, `tx:${txHash}`, "有結算 tx hash 時用它當冪等鍵");

  await applyLedgerRecording(entry, paidResponse({ ok: true }, { "X-PAYMENT-RESPONSE": "fake" }), xPayment);
  pushed = JSON.parse(listFor(QUEUE_KEY).at(-1)!) as { idempotencyKey?: string };
  assert.equal(pushed.idempotencyKey, `auth:0x${"11".repeat(20)}:0x${"cd".repeat(32)}`, "退而求其次：付款人 + nonce");

  await applyLedgerRecording(entry, paidResponse({ ok: true }, { "X-PAYMENT-RESPONSE": "fake" }));
  pushed = JSON.parse(listFor(QUEUE_KEY).at(-1)!) as { idempotencyKey?: string };
  assert.match(pushed.idempotencyKey ?? "", /^req:/, "都解不出來仍要有唯一鍵");
  console.log("冪等鍵：tx hash > 付款人+nonce > 隨機 id ✓");
}

// ── 5) ledger 未設定（沒有 UPSTASH env）→ 資料照給，settled:false + 明確 settleError ──
{
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = paidResponse({ ok: true, data: { fake: true } }, { "X-PAYMENT-RESPONSE": "fake" });
  const out = await applyLedgerRecording(entry, res);
  const j = (await out.json()) as { ok: boolean; settled: boolean; settleError?: string };
  assert.equal(j.ok, true, "ledger 沒設定不影響資料交付——買方已付款，資料照給");
  assert.equal(j.settled, false);
  assert.ok(j.settleError?.includes("UPSTASH"), `settleError 應點名缺的 env，got: ${j.settleError}`);
  console.log("ledger 未設定 → 資料照給、settled:false、settleError 點名缺的 env ✓");
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
}

// ── 6) ledger 有設定但寫入失敗（連線被拒）→ settled:false + settleError，
//      資料仍然照給（買方已付款，不能因為我們自己的記帳失敗就不給資料）────────
{
  upstashDown = true;
  const res = paidResponse({ ok: true, data: { fake: true } }, { "X-PAYMENT-RESPONSE": "fake" });
  const out = await applyLedgerRecording(entry, res);
  const j = (await out.json()) as { ok: boolean; settled: boolean; settleError?: string };
  assert.equal(j.ok, true);
  assert.equal(j.settled, false);
  assert.ok(j.settleError, "寫入失敗要留下明確原因，不能靜默吞掉");
  console.log("ledger 寫入失敗 → 資料照給、settled:false、settleError 有留下原因 ✓");
  upstashDown = false;
}

await new Promise<void>((r) => upstash.close(() => r()));
console.log("ledgerFlow.test.ts ✓ all assertions passed");
