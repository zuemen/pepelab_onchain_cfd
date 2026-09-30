// LocalNonceSigner 的行為測試（不連網）。用法：tsx keeper/nonceSigner.test.ts
import assert from "node:assert/strict";
import type { TransactionRequest, TransactionResponse } from "ethers";

import { LocalNonceSigner, StaleNonceError, isStaleNonceError, type InnerSigner } from "./nonceSigner.ts";

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

test("呼叫端自行指定 nonce：原樣送出，成功後本機計數推進到 nonce+1（L2）", async () => {
  const f = fakeInner({ pending: () => 50 });
  const s = new LocalNonceSigner(f.inner);
  await s.sendTransaction({ ...TX, nonce: 77 });
  assert.deepEqual(f.sent, [77]);
  assert.equal(s.nextNonce, 78);
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [77, 78], "下一筆不重用 77");
});

test("自帶的 nonce 比本機計數小：成功後不倒退（L2）", async () => {
  const f = fakeInner({ pending: () => 20 });
  const s = new LocalNonceSigner(f.inner);
  await s.sendTransaction(TX); // 20 → next 21
  await s.sendTransaction(TX); // 21 → next 22
  await s.sendTransaction({ ...TX, nonce: 5 }); // 例如替換一筆舊交易
  assert.equal(s.nextNonce, 22);
});

test("自帶 nonce 送出失敗（非 nonce 問題）：不推進本機計數", async () => {
  const f = fakeInner({
    pending: () => 30,
    send: () => {
      throw new Error("insufficient funds for gas * price + value");
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction({ ...TX, nonce: 30 }), /insufficient funds/);
  assert.equal(s.nextNonce, null);
});

test("populateTransaction() 後再 sendTransaction()：下一筆拿到 N+1，不是 N（L2）", async () => {
  const f = fakeInner({ pending: () => 40 });
  const s = new LocalNonceSigner(f.inner);
  // ethers 的 AbstractSigner.populateTransaction 取 nonce 的方式就是 this.getNonce("pending")；
  // 這裡沒有 provider，照它的做法手動填（真的 populateTransaction 在 anvil 上驗證）。
  const populated = { ...TX, nonce: await s.getNonce("pending") };
  assert.equal(Number(populated.nonce), 40);
  await s.sendTransaction(populated);
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [40, 41]);
  assert.equal(s.nextNonce, 42);
});

test("estimateGas 階段丟出像 nonce 問題的錯誤：不跳號（交易還沒廣播）", async () => {
  let fail = true;
  const f = fakeInner({
    pending: () => 60,
    estimate: () => {
      if (fail) {
        fail = false;
        throw new Error("nonce too low");
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX), /nonce too low/);
  assert.equal(s.nextNonce, 60, "只向 RPC 對齊，不 +1");
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [60]);
});

test("合約 revert 內含 already exists：不當成 nonce 問題、不跳號（L1 的邊界）", async () => {
  let fail = true;
  const f = fakeInner({
    pending: () => 70,
    send: () => {
      if (fail) {
        fail = false;
        throw new Error("execution reverted: asset already exists");
      }
    },
  });
  const s = new LocalNonceSigner(f.inner);
  await assert.rejects(s.sendTransaction(TX), /asset already exists/);
  await s.sendTransaction(TX);
  assert.deepEqual(f.sent, [70]);
});

test("stale 錯誤標註「交易可能已送達」，保留 code 與原始錯誤（L4）", async () => {
  const orig = Object.assign(new Error("could not replace existing tx"), {
    code: "REPLACEMENT_UNDERPRICED",
    shortMessage: "replacement fee too low",
  });
  const f = fakeInner({
    pending: () => 12148,
    send: () => {
      throw orig;
    },
  });
  const s = new LocalNonceSigner(f.inner);
  const err = await s.sendTransaction(TX).then(
    () => assert.fail("應該丟錯"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof StaleNonceError);
  const se = err as StaleNonceError;
  assert.match(se.message, /^nonce 12148 已被占用，交易可能已送達/);
  assert.ok(se.message.slice(0, 80).includes("交易可能已送達"), "round 的 log 只截 80 字也看得到");
  assert.match(se.message, /replacement fee too low/);
  assert.equal(se.code, "REPLACEMENT_UNDERPRICED");
  assert.equal(se.cause, orig);
  assert.equal(se.nonce, 12148);
  assert.ok(isStaleNonceError(se));
});

test("isStaleNonceError 的判斷", async () => {
  for (const m of [
    "nonce too low",
    "replacement transaction underpriced",
    'replacement fee too low (transaction="0x")',
    "already known",
    "nonce has already been used",
    "transaction already imported", // reth
    "already imported",
    "tx already exists in cache", // L1
    "transaction already exists",
    "already exists in mempool",
  ]) {
    assert.ok(isStaleNonceError(new Error(m)), m);
  }
  assert.ok(isStaleNonceError({ code: "REPLACEMENT_UNDERPRICED" }));
  assert.ok(!isStaleNonceError(new Error("execution reverted")));
  assert.ok(!isStaleNonceError(new Error("insufficient funds")));
  assert.ok(!isStaleNonceError(new Error("execution reverted: asset already exists")));
  assert.ok(!isStaleNonceError(new Error("execution reverted: AlreadyExists()")));
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
