// 送出與追蹤（審查 Low-9）：廣播出錯時先確認交易是否真的沒送出，才返還 policy 額度。
// 假 provider，不連鏈、不送交易。
//   npx tsx examples/submit.test.ts
import assert from "node:assert";

process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
const { submitSigned, broadcastStatus } = await import("@pepelab/shared");
type P = Parameters<typeof submitSigned>[0];

const TX = { raw: "0x02aa", hash: "0x" + "ab".repeat(32), nonce: 7, from: "0x" + "11".repeat(20) };
const receipt = (status: number) => ({ status, logs: [] }) as any;

function fake(o: {
  broadcast?: () => Promise<unknown>;
  getTx?: unknown;
  getReceipt?: unknown;
  pendingNonce?: number | Error;
  wait?: () => Promise<unknown>;
}): P & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    broadcastTransaction: async () => { calls.push("broadcast"); return o.broadcast ? o.broadcast() : {}; },
    getTransaction: async () => { calls.push("getTransaction"); return o.getTx ?? null; },
    getTransactionReceipt: async () => { calls.push("getReceipt"); return o.getReceipt ?? null; },
    getTransactionCount: async () => {
      calls.push("nonce");
      if (o.pendingNonce instanceof Error) throw o.pendingNonce;
      return o.pendingNonce ?? TX.nonce;
    },
    waitForTransaction: async () => { calls.push("wait"); return (o.wait ? o.wait() : receipt(1)) as any; },
  };
}
const boom = () => Promise.reject(Object.assign(new Error("timeout https://rpc.example/v2/SECRETKEY1234567890abcd"), { code: "TIMEOUT" }));
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

{
  const p = fake({});
  const r = await submitSigned(p, TX);
  assert.equal(r.kind, "mined");
  assert.deepEqual(p.calls, ["broadcast", "wait"]);
  ok("正常：廣播 → 等收據 → mined");
}
{
  const r = await submitSigned(fake({ wait: async () => receipt(0) }), TX);
  assert.equal(r.kind, "reverted");
  ok("收據 status=0 → reverted（不返還額度）");
}
{
  const p = fake({ broadcast: boom, getTx: { hash: TX.hash } });
  const r = await submitSigned(p, TX);
  assert.equal(r.kind, "mined", "廣播逾時但節點看得到這筆 → 照常等收據");
  assert.ok(p.calls.includes("wait"));
  ok("廣播逾時、但 getTransaction 找得到 → 視為已送出，繼續等收據");
}
{
  const p = fake({ broadcast: boom, pendingNonce: TX.nonce + 1 });
  assert.equal(await broadcastStatus(p, TX), "sent");
  ok("廣播逾時、找不到 tx 但 pending nonce 已被用掉 → 視為已送出（不返還）");
}
{
  const p = fake({ broadcast: boom, pendingNonce: TX.nonce });
  const r = await submitSigned(p, TX);
  assert.equal(r.kind, "not_sent");
  assert.ok(!("error" in r && r.error.includes("SECRETKEY")), "錯誤原文已遮蔽");
  assert.ok(!p.calls.includes("wait"));
  ok("廣播失敗、mempool 無此筆且 nonce 未被使用 → not_sent（才可返還額度）");
}
{
  const p = fake({ broadcast: boom, pendingNonce: new Error("rpc down") });
  const r = await submitSigned(p, TX);
  assert.equal(r.kind, "unknown");
  ok("廣播失敗且查不出狀態 → unknown（不返還額度）");
}
{
  const r = await submitSigned(fake({ wait: () => Promise.reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })) }), TX);
  assert.equal(r.kind, "pending");
  const r2 = await submitSigned(fake({ wait: async () => null }), TX);
  assert.equal(r2.kind, "pending");
  ok("等收據逾時 → pending（交易可能仍會上鏈，不返還額度）");
}

console.log(`\n✅ submit.test.ts 全過（${n} 組）`);
