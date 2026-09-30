// 送出與追蹤（審查 Low-9、複審 Low-6）：只有節點明確拒收才返還 policy 額度；其餘延遲重查、查不到也不返還。
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
const ND = { recheckDelaysMs: [0, 0, 0] };
{
  const p = fake({ broadcast: boom, getTx: { hash: TX.hash } });
  const r = await submitSigned(p, TX, ND);
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
  const r = await submitSigned(p, TX, ND);
  assert.equal(r.kind, "unknown", "逾時且重查不到 → 不返還");
  assert.equal(p.calls.filter((c) => c === "getTransaction").length, 3, "延遲重查 3 次");
  assert.ok(!("error" in r && r.error.includes("SECRETKEY")), "錯誤原文已遮蔽");
  assert.ok(!p.calls.includes("wait"));
  ok("廣播逾時、重查 3 次都查不到 → unknown（不返還額度）");
}
{
  // 第 2 次重查才看到（傳播延遲）
  let seen = 0;
  const p = fake({ broadcast: boom });
  p.getTransaction = async () => (++seen >= 2 ? { hash: TX.hash } : null);
  const r = await submitSigned(p, TX, ND);
  assert.equal(r.kind, "mined");
  ok("重查第 2 次才看到交易 → 視為已送出並等收據");
}
{
  const reject = (msg: string, code = "SERVER_ERROR") => () =>
    Promise.reject(Object.assign(new Error(`could not coalesce error`), { code, info: { error: { code: -32000, message: msg } } }));
  for (const m of ["intrinsic gas too low", "max fee per gas less than block base fee", "transaction underpriced", "invalid sender"]) {
    const p = fake({ broadcast: reject(m) });
    const r = await submitSigned(p, TX, ND);
    assert.equal(r.kind, "not_sent", m);
    assert.ok(!p.calls.includes("getTransaction"), "明確拒收不必重查");
  }
  ok("節點明確拒收（intrinsic gas too low / base fee / underpriced / invalid sender）→ not_sent（才返還額度）");
  for (const [m, code] of [
    ["nonce too low", "NONCE_EXPIRED"],
    ["replacement transaction underpriced", "REPLACEMENT_UNDERPRICED"],
    ["insufficient funds for gas * price + value", "INSUFFICIENT_FUNDS"],
    ["already known", "SERVER_ERROR"],
  ] as const) {
    const r = await submitSigned(fake({ broadcast: reject(m, code) }), TX, ND);
    assert.notEqual(r.kind, "not_sent", `${m} 不可返還額度`);
  }
  ok("nonce too low / replacement underpriced / insufficient funds / already known → 不視為明確拒收（不返還）");
}
{
  const p = fake({ broadcast: boom, pendingNonce: new Error("rpc down") });
  const r = await submitSigned(p, TX, ND);
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
