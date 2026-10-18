// 公開鏈的送出（#344）：同一個帳號的 nonce 依送出順序、估 gas 失敗不佔 nonce、廣播前就記下雜湊、
// 不同帳號平行；本機模式的 forEach 依序。用假的節點，不碰鏈。
//   cd agent && npx tsx heroes/sender.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { forEach, isRejected, PublicSender, type Account, type Call } from "./sender.ts";

const CHAIN = 84532n;

/** 假節點：估 gas 時 data = 0xdead 就 revert；廣播的原始交易解開來記下（nonce、送的人）。 */
function fakeNode() {
  const broadcast: { from: string; nonce: number; hash: string }[] = [];
  const receipts = new Map<string, unknown>();
  let pendingNonce = 5;
  const node = {
    getNetwork: async () => ({ chainId: CHAIN }),
    getTransactionCount: async () => pendingNonce,
    estimateGas: async (tx: ethers.TransactionRequest) => {
      if (tx.data === "0xdead") throw new Error("execution reverted");
      return 100_000n;
    },
    broadcastTransaction: async (signed: string) => {
      const tx = ethers.Transaction.from(signed);
      assert.equal(tx.chainId, CHAIN);
      assert.equal(tx.gasLimit, 125_000n, "gas limit padded by 25%");
      broadcast.push({ from: tx.from!, nonce: tx.nonce, hash: tx.hash! });
      // 收據晚一點才出現，像真的區塊
      setTimeout(() => receipts.set(tx.hash!, { status: 1, hash: tx.hash, logs: [] }), 20);
    },
    getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
  };
  return { node: node as unknown as ethers.Provider, broadcast, setPending: (n: number) => { pendingNonce = n; } };
}

const fees = { fees: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }) };
const polling = { intervalMs: 5, timeoutMs: 2_000 };
const call = (from: Account, data = "0x01"): Call => ({
  from,
  send: () => { throw new Error("local path not used"); },
  populate: async () => ({ to: "0x0000000000000000000000000000000000000001", data }),
});

const alice: Account = (() => { const w = ethers.Wallet.createRandom(); return { address: w.address, signer: w }; })();
const bob: Account = (() => { const w = ethers.Wallet.createRandom(); return { address: w.address, signer: w }; })();

// ── 同帳號連發：nonce 依送出順序；廣播前就拿到雜湊 ─────────────────────
{
  const { node, broadcast } = fakeNode();
  const sender = new PublicSender(node, fees, polling);
  const hashes: string[] = [];
  const seenBeforeBroadcast: boolean[] = [];
  const hooks = () => ({ onHash: (hash: string) => {
    hashes.push(hash);
    seenBeforeBroadcast.push(!broadcast.some((b) => b.hash === hash));
  } });
  const receipts = await Promise.all([0, 1, 2].map(() => sender.submit(call(alice), hooks())));
  assert.deepEqual(broadcast.map((b) => b.nonce), [5, 6, 7]);
  assert.deepEqual(broadcast.map((b) => b.hash), hashes, "the journalled hash is the broadcast one");
  assert.ok(seenBeforeBroadcast.every(Boolean), "hash must be known before the broadcast (crash-safe resume)");
  assert.equal(receipts.length, 3);
}

// ── 估 gas 失敗：不廣播、不佔 nonce，下一筆接著用 ───────────────────────
{
  const { node, broadcast } = fakeNode();
  const sender = new PublicSender(node, fees, polling);
  const results = await Promise.allSettled([
    sender.submit(call(alice), { onHash: () => {} }),
    sender.submit(call(alice, "0xdead"), { onHash: () => assert.fail("a rejected call has no hash") }),
    sender.submit(call(alice), { onHash: () => {} }),
  ]);
  assert.equal(results[1].status, "rejected");
  assert.ok(isRejected((results[1] as PromiseRejectedResult).reason));
  assert.deepEqual(broadcast.map((b) => b.nonce), [5, 6], "no gap left by the reverted estimate");
}

// ── 不同帳號各自的 nonce ─────────────────────────────────────────────────
{
  const { node, broadcast } = fakeNode();
  const sender = new PublicSender(node, fees, polling);
  await Promise.all([call(alice), call(bob), call(alice), call(bob)].map((c) => sender.submit(c, { onHash: () => {} })));
  const nonces = (a: Account) => broadcast.filter((b) => b.from === a.address).map((b) => b.nonce);
  assert.deepEqual(nonces(alice), [5, 6]);
  assert.deepEqual(nonces(bob), [5, 6]);
}

// ── forEach：本機依序（順序就是交易順序），公開鏈平行但有上限 ───────────
{
  const order: number[] = [];
  await forEach(false, [1, 2, 3], async (x) => {
    await new Promise((r) => setTimeout(r, 10 - x * 3));
    order.push(x);
  });
  assert.deepEqual(order, [1, 2, 3]);

  let running = 0;
  let peak = 0;
  await forEach(true, Array.from({ length: 20 }, (_, i) => i), async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  }, 4);
  assert.equal(peak, 4);
}

console.log("sender: ok");
