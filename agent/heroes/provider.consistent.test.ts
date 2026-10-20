// 公開鏈的讀取一定看得到我們自己已確認的交易（#344，2026-10-20 正式回放：節點落後讓 35 筆被誤判失敗）。
//   cd agent && npx tsx heroes/provider.consistent.test.ts
import assert from "node:assert";
import { ConsistentProvider, BASE_SEPOLIA, isRateLimited } from "./provider.ts";

type Call = { method: string; params: unknown[] };

/** 假節點：記下每個 JSON-RPC 請求；lagging 次數內對指定區塊回「header not found」。 */
function fakeNode(provider: ConsistentProvider, lagging = 0) {
  const calls: Call[] = [];
  (provider as unknown as { _send: (p: unknown) => Promise<unknown[]> })._send = async (payload) => {
    const list = (Array.isArray(payload) ? payload : [payload]) as { id: number; method: string; params: unknown[] }[];
    return list.map((p) => {
      calls.push({ method: p.method, params: p.params });
      if ((p.method === "eth_call" || p.method === "eth_estimateGas") && p.params.length > 1 && lagging > 0) {
        lagging -= 1;
        return { id: p.id, error: { code: -32000, message: "header not found" } };
      }
      return { id: p.id, result: p.method === "eth_estimateGas" ? "0x5208" : "0x" + "00".repeat(31) + "01" };
    });
  };
  return calls;
}

const TO = "0x0000000000000000000000000000000000000001";

// ── 還沒看過任何收據：照常用 latest ─────────────────────────────────────────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  const calls = fakeNode(p);
  await p.call({ to: TO, data: "0x" });
  assert.equal(calls.at(-1)!.params[1], "latest");
  await p.estimateGas({ to: TO, data: "0x" });
  assert.equal(calls.at(-1)!.params.length, 1);
}

// ── 看過區塊 100 之後：讀取與估 gas 都釘在 100；之後只會往前 ───────────────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  const calls = fakeNode(p);
  p.noteBlock(100);
  p.noteBlock(90); // 舊的收據不會把它往回拉
  await p.call({ to: TO, data: "0x" });
  assert.equal(calls.at(-1)!.params[1], "0x64", "eth_call pinned to the newest block we have seen");
  await p.estimateGas({ to: TO, data: "0x" });
  assert.deepEqual(calls.at(-1)!.params.slice(1), ["0x64"], "eth_estimateGas pinned too");
  // 明確指定的區塊不動
  await p.call({ to: TO, data: "0x", blockTag: 7 });
  assert.equal(calls.at(-1)!.params[1], "0x7");
}

// ── 落到還沒有那個區塊的節點：等一下再問，不是當成 revert ─────────────────────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  const calls = fakeNode(p, 2);
  p.noteBlock(100);
  const gas = await p.estimateGas({ to: TO, data: "0x" });
  assert.equal(gas, 21000n);
  assert.equal(calls.filter((c) => c.method === "eth_estimateGas").length, 3, "two lagging answers, then the real one");
}

// ── 2026-10-20 正式回放跑到第 126 天：Alchemy 限流（429）。任何請求都等一下再送，不能讓整趟停下 ─────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  let limited = 2;
  let calls = 0;
  (p as unknown as { _send: (x: unknown) => Promise<unknown[]> })._send = async (payload) => {
    const list = (Array.isArray(payload) ? payload : [payload]) as { id: number; method: string }[];
    return list.map((q) => {
      calls += 1;
      if (limited-- > 0) {
        return { id: q.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } };
      }
      return { id: q.id, result: "0x" + "00".repeat(31) + "2a" };
    });
  };
  p.noteBlock(100);
  const out = await p.call({ to: TO, data: "0x0468b467" });
  assert.equal(BigInt(out), 42n, "rate-limited calls are retried until they answer");
  assert.equal(calls, 3);
}

// ── 真的 revert（calldata 裡剛好有 429）不能被當成限流重試 ─────────────────────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  let calls = 0;
  (p as unknown as { _send: (x: unknown) => Promise<unknown[]> })._send = async (payload) => {
    const list = (Array.isArray(payload) ? payload : [payload]) as { id: number }[];
    return list.map((q) => { calls += 1; return { id: q.id, error: { code: 3, message: "execution reverted", data: "0xfb8f41b2" } }; });
  };
  await assert.rejects(p.call({ to: TO, data: "0x4290429042904290" }));
  assert.equal(calls, 1, "a revert is not retried");
  assert.ok(!isRateLimited(Object.assign(new Error("missing revert data 0x429"), { info: { error: { code: 3, message: "execution reverted" } } })));
  assert.ok(isRateLimited(Object.assign(new Error("x"), { info: { responseStatus: "429 Too Many Requests" } })));
  // 2026-10-20 正式回放跑到 2025-07-16 停在這一種：UNKNOWN_ERROR「could not coalesce error」，原文在 error
  assert.ok(isRateLimited(Object.assign(new Error("could not coalesce error"), {
    code: "UNKNOWN_ERROR", shortMessage: "could not coalesce error",
    error: { code: 429, message: "Your app has exceeded its compute units per second capacity." },
  })));
}

// ── 同一種限流打在一般方法（eth_getBlockByNumber）上：照樣重試 ───────────────
{
  const p = new ConsistentProvider("http://127.0.0.1:1", BASE_SEPOLIA, { staticNetwork: BASE_SEPOLIA, cacheTimeout: -1, batchMaxCount: 1 });
  let limited = 1;
  (p as unknown as { _send: (x: unknown) => Promise<unknown[]> })._send = async (payload) => {
    const list = (Array.isArray(payload) ? payload : [payload]) as { id: number; method: string }[];
    return list.map((q) => (limited-- > 0
      ? { id: q.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity." } }
      : { id: q.id, result: "0x10" }));
  };
  assert.equal(await p.getBlockNumber(), 16, "rate-limited eth_blockNumber is retried");
}

console.log("provider.consistent: ok");
