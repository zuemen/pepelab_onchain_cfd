// X402_SETTLEMENT_MODE（signal-api/src/settlementMode.ts，ADR-021 §3）測試。
//   cd agent && npx tsx signal-api/src/settlementMode.test.ts
//
// 完全離線：假 facilitator（真的驗 EIP-3009 簽章、結算是假的）、假 Upstash、假 RPC、隨機測試金鑰。
//
// 要證明的：沒有分潤結算目標的部署（例如 rwa-poc 租戶：有 Upstash 給 KYA 用，但沒有 x402 FeeRouter／
// 結算 worker）設 X402_SETTLEMENT_MODE=off 之後，付費回應不再宣稱 settled:true、結算佇列與 v2 對帳佇列
// 都不寫、`GET /` 的 revenueModel 不再描述不存在的分潤；預設（queue）與以前逐位元相同。
import assert from "node:assert";
import { createWalletClient, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createPaymentHeader as createV1PaymentHeader } from "x402/client";
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
for (const k of ["X402_PROTOCOL", "PAY_TO", "X402_KYA_MODE", "X402_SETTLEMENT_MODE"]) delete process.env[k];

const { createApp, applyLedgerRecording } = await import("./app.ts");
const { QUEUE_KEY, UNKNOWN_SETTLEMENT_KEY } = await import("./ledger.ts");
const {
  resolveX402SettlementMode, isRevenueSharingOff, recordUnknownSettlementUnlessOff, revenueModelWithoutSharing,
  REVENUE_SHARING_OFF_ERROR,
} = await import("./settlementMode.ts");

const PAYTO = "0x4444444444444444444444444444444444444444";
const TRADER = "0x5555555555555555555555555555555555555555";
const URL_SIGNALS = `http://localhost/signals/${TRADER}`;
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const env = (v?: string) => ({ X402_SETTLEMENT_MODE: v }) as NodeJS.ProcessEnv;

// ── 1) 解析 ──────────────────────────────────────────────────────────────────
{
  assert.equal(resolveX402SettlementMode(env(undefined)), "queue", "未設 → queue（平台行為不變）");
  assert.equal(resolveX402SettlementMode(env("queue")), "queue");
  assert.equal(resolveX402SettlementMode(env(" OFF ")), "off");
  assert.equal(resolveX402SettlementMode(env("disabled")), "queue", "無法辨識 → queue（保留資料，印 ::error::）");
  assert.equal(isRevenueSharingOff(env("off")), true);
  ok("X402_SETTLEMENT_MODE：未設／queue → queue；off → off；無法辨識 → queue");
}

// ── 2) applyLedgerRecording：off 不入列、settled:false、settleError 照實說明（v1 與 v2）──────────
const entry = { trader: TRADER, feeUsd: 0.01, at: 1_700_000_000, source: "signals" as const };
const paid = (headers: Record<string, string>) =>
  new Response(JSON.stringify({ ok: true, settled: false, data: { fake: true } }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
{
  const before = upstash.list(QUEUE_KEY).length;
  process.env.X402_SETTLEMENT_MODE = "off";
  for (const [proto, hdr] of [["v1", "X-PAYMENT-RESPONSE"], ["v2", "PAYMENT-RESPONSE"]] as const) {
    const out = await applyLedgerRecording(entry, paid({ [hdr]: b64({ success: true, transaction: "0x" + "ab".repeat(32) }) }), null, proto);
    const j = (await out.json()) as { ok: boolean; settled: boolean; settleError?: string; data: unknown };
    assert.equal(j.ok, true, "資料照給");
    assert.deepEqual(j.data, { fake: true });
    assert.equal(j.settled, false, `${proto}：沒有結算目標 → settled:false`);
    assert.equal(j.settleError, REVENUE_SHARING_OFF_ERROR);
    assert.match(j.settleError!, /^revenue_sharing_off：/);
  }
  assert.equal(upstash.list(QUEUE_KEY).length, before, "off：結算佇列沒有新增");
  delete process.env.X402_SETTLEMENT_MODE;
  const out = await applyLedgerRecording(entry, paid({ "X-PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "cd".repeat(32) }) }));
  assert.equal(((await out.json()) as { settled: boolean }).settled, true, "預設 queue：與以前相同");
  assert.equal(upstash.list(QUEUE_KEY).length, before + 1);
  ok("applyLedgerRecording：off → 不入列、settled:false＋revenue_sharing_off（v1／v2）；預設 queue 照舊入列");
}

// ── 3) v2 結算結果不明：off 不入對帳佇列 ────────────────────────────────────────
{
  const record = { payer: "0x" + "11".repeat(20), nonce: "0x" + "22".repeat(32), amount: "10000" };
  let called = 0;
  const fake = async () => (called++, "recorded" as const);
  assert.equal(await recordUnknownSettlementUnlessOff(record, { env: env("off"), record: fake }), "skipped");
  assert.equal(called, 0, "off：不呼叫 ledger");
  assert.equal(await recordUnknownSettlementUnlessOff(record, { env: env(undefined), record: fake }), "recorded");
  assert.equal(called, 1, "queue：交給 ledger");
  // 預設實作（真的打假 Upstash）。
  const before = upstash.list(UNKNOWN_SETTLEMENT_KEY).length;
  assert.equal(await recordUnknownSettlementUnlessOff(record, { env: env("off") }), "skipped");
  assert.equal(upstash.list(UNKNOWN_SETTLEMENT_KEY).length, before);
  assert.equal(await recordUnknownSettlementUnlessOff(record, { env: env("queue") }), "recorded");
  assert.equal(upstash.list(UNKNOWN_SETTLEMENT_KEY).length, before + 1);
  ok("v2 結算結果不明：off → 不入對帳佇列（只寫 log）；queue → 照舊入列");
}

// ── 4) 整條付費流程（真的 createApp＋假 facilitator，v1）與 GET / ────────────────────────
const seams = {
  payTo: PAYTO,
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => true,
  signalReader: async (trader: string) => ({ trader, note: "mock signal (settlementMode.test)" }),
};
const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: baseSepolia, transport: http(rpc.url) }).extend(publicActions);
async function payOnce(app: ReturnType<typeof createApp>) {
  const r402 = await app.request(URL_SIGNALS);
  assert.equal(r402.status, 402);
  const pay = await createV1PaymentHeader(wallet as never, 1, ((await r402.json()) as { accepts: unknown[] }).accepts[0] as never);
  const res = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("X-PAYMENT-RESPONSE"), "付款本身照常結算（款項進 payTo）");
  return (await res.json()) as { ok: boolean; settled: boolean; settleError?: string };
}
{
  const app = createApp({ ...seams, x402Protocol: "v1", kya: null });
  const before = upstash.list(QUEUE_KEY).length;
  process.env.X402_SETTLEMENT_MODE = "off";
  const body = await payOnce(app);
  assert.equal(body.settled, false);
  assert.match(body.settleError ?? "", /^revenue_sharing_off：/);
  assert.equal(upstash.list(QUEUE_KEY).length, before, "off：付費後結算佇列沒有新增");
  const root = (await (await app.request("http://localhost/")).json()) as { revenueModel: string };
  assert.equal(root.revenueModel, revenueModelWithoutSharing(PAYTO, facilitator.url));
  assert.doesNotMatch(root.revenueModel, /70\/20\/10/, "off：不描述不存在的分潤");

  delete process.env.X402_SETTLEMENT_MODE;
  const body2 = await payOnce(app);
  assert.equal(body2.settled, true, "queue：已排入結算佇列（平台行為不變）");
  assert.equal(upstash.list(QUEUE_KEY).length, before + 1);
  const root2 = (await (await app.request("http://localhost/")).json()) as { revenueModel: string };
  assert.match(root2.revenueModel, /70\/20\/10/);
  ok("付費流程：off → 200＋X-PAYMENT-RESPONSE、settled:false、佇列不變、GET / 不提分潤；queue 照舊");
}

await upstash.close();
await facilitator.close();
await rpc.close();
console.log(`settlementMode.test.ts ✓ ${n} 組全部通過`);
