// LocalNonceSigner 的行為測試（不連網）。用法：tsx keeper/nonceSigner.test.ts
import assert from "node:assert/strict";
import type { TransactionRequest, TransactionResponse } from "ethers";

import { LocalNonceSigner, isStaleNonceError, type InnerSigner } from "./nonceSigner.ts";

/** 假 signer：pendingNonce 由測試控制（模擬落後的負載平衡 RPC），並記錄送出的 nonce。 */
function fakeInner(opts: {
  pending: () => number;
  estimate?: (tx: TransactionRequest) => void;
  send?: (tx: TransactionRequest) => void;
}) {
  const sent: number[] = [];
  let getNonceCalls = 0;
  const inner: InnerSigner = {
    provider: null,
    getAddress: async () => "0x000000000000000000000000000000000000dEaD",
    getNonce: async () => {
      getNonceCalls += 1;
      return opts.pending();
    },
    populateTransaction: async (tx) => {
      opts.estimate?.(tx);
      return { ...tx, gasLimit: 21000n };
    },
    sendTransaction: async (tx) => {
      opts.send?.(tx);
      sent.push(Number(tx.nonce));
      return { hash: `0x${sent.length}`, nonce: Number(tx.nonce) } as unknown as TransactionResponse;
    },
    signMessage: async () => "0x",
    signTypedData: async () => "0x",
    signTransaction: async () => "0x",
  };
  return { inner, sent, getNonceCalls: () => getNonceCalls };
}

const TX: TransactionRequest = { to: "0x0000000000000000000000000000000000000001", data: "0x" };
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("事故重現：RPC 一直回同一個舊的 pending nonce，連續三筆仍拿到 N、N+1、N+2", async () => {
  const f = fakeInner({ pending: () => 12148 });
  const s = new LocalNonceSigner(f.inner);
  for (let i = 0; i < 3; i++) await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [12148, 12149, 12150]);
  assert.equal(f.getNonceCalls(), 1, "只在開始時問一次 RPC");
});

test("estimateGas revert 不消耗 nonce：下一筆沿用同一個值", async () => {
  let fail = true;
  const f = fakeInner({
    pending: () => 7,
    estimate: () => {
      if (fail) {
        fail = false;
        throw new Error("execution reverted: StalePrice");
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX), /StalePrice/);
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [7]);
  assert.equal(s.nextNonce, 8);
});

test("節點拒收但不是 nonce 問題：不遞增", async () => {
  let fail = true;
  const f = fakeInner({
    pending: () => 3,
    send: () => {
      if (fail) {
        fail = false;
        throw new Error("insufficient funds for gas * price + value");
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX), /insufficient funds/);
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [3]);
});

test("replacement fee too low：跳到 nonce+1（即使 RPC 仍回舊值），錯誤照樣丟回", async () => {
  let fail = true;
  const f = fakeInner({
    pending: () => 10, // 落後的節點一直說 10
    send: (tx) => {
      if (fail && Number(tx.nonce) === 10) {
        fail = false;
        throw new Error('replacement fee too low (transaction="0x02f8...")');
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX), /replacement fee too low/);
  assert.equal(s.nextNonce, 11, "至少 nonce+1，不退回 RPC 的舊值");
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [11]);
});

test("nonce too low 且 RPC 已經前進：採用較大的 RPC 值", async () => {
  let remote = 5;
  let fail = true;
  const f = fakeInner({
    pending: () => remote,
    send: () => {
      if (fail) {
        fail = false;
        remote = 9; // 同一把 key 另有交易上鏈
        const e = new Error("nonce too low") as Error & { code: string };
        e.code = "NONCE_EXPIRED";
        throw e;
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX));
  assert.equal(s.nextNonce, 9);
});

test("並行送出被序列化，不會拿到相同 nonce", async () => {
  const f = fakeInner({ pending: () => 100 });
  const s = new LocalNonceSigner(f.inner);
  await Promise.all([s.sendTransaction(TX), s.sendTransaction(TX), s.sendTransaction(TX)]);
  assert.deepEqual(f.sent, [100, 101, 102]);
});

test("一筆失敗不會卡住佇列中的下一筆", async () => {
  let n = 0;
  const f = fakeInner({
    pending: () => 1,
    estimate: () => {
      n += 1;
      if (n === 1) throw new Error("execution reverted");
    },
  });
  const s = new LocalNonceSigner(f.inner);
  const [a, b] = await Promise.allSettled([s.sendTransaction(TX), s.sendTransaction(TX)]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  assert.deepEqual(f.sent, [1]);
});

test("呼叫端自行指定 nonce 時原樣送出，不動本機計數", async () => {
  const f = fakeInner({ pending: () => 50 });
  const s = new LocalNonceSigner(f.inner);
  await s.sendTransaction({ ...TX, nonce: 77 });
  assert.deepEqual(f.sent, [77]);
  assert.equal(s.nextNonce, null);
});

test("isStaleNonceError 的判斷", async () => {
  for (const m of [
    "nonce too low",
    "replacement transaction underpriced",
    'replacement fee too low (transaction="0x")',
    "already known",
    "nonce has already been used",
  ]) {
    assert.ok(isStaleNonceError(new Error(m)), m);
  }
  assert.ok(isStaleNonceError({ code: "REPLACEMENT_UNDERPRICED" }));
  assert.ok(!isStaleNonceError(new Error("execution reverted")));
  assert.ok(!isStaleNonceError(new Error("insufficient funds")));
  assert.ok(!isStaleNonceError(null));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
if (failed) {
  console.error(`nonceSigner.test.ts ✗ ${failed} failed`);
  process.exit(1);
}
console.log("nonceSigner.test.ts ✓ all assertions passed");
