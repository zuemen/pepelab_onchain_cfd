// 公開鏈的讀取一定看得到我們自己已確認的交易（#344，2026-10-20 正式回放：節點落後讓 35 筆被誤判失敗）。
//   cd agent && npx tsx heroes/provider.consistent.test.ts
import assert from "node:assert";
import { ConsistentProvider, BASE_SEPOLIA } from "./provider.ts";

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

console.log("provider.consistent: ok");
