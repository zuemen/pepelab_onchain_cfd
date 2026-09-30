// x402 簽章守門的並行安全與付款記帳（PR #201 審查附帶回報的 shared-race PoC 轉正式測試）。
// 完全離線：隨機測試金鑰，只在記憶體簽 typed data；不連網、不送交易、不付款。
//   npx tsx examples/x402-guard-concurrency.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.AGENT_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
process.env.SESSION_MANAGER_ADDRESS = ethers.getAddress("0x" + "5e".repeat(20));
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.X402_MAX_PAYMENT_USDC = "0.01";
for (const k of ["X402_PAYTO_ALLOWLIST", "PAY_TO", "X402_MAX_TOTAL_SPEND_USDC", "LOOP_MAX_SPEND_USDC", "X402_MAX_VALIDITY_SEC"]) {
  delete process.env[k];
}

const {
  GuardedWallet, guardViemAccount, SigningGuardError, OFFICIAL_USDC_DOMAINS, TRANSFER_WITH_AUTHORIZATION_FIELDS,
  x402SignedTotal, x402PayToAllowlist, resetX402GuardStateForTesting, meteredFetch,
} = await import("@pepelab/shared");

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const quiet = <T>(fn: () => Promise<T>) => {
  const w = console.warn;
  console.warn = () => {};
  return fn().finally(() => (console.warn = w));
};
const isGuard = (code: string) => (e: unknown) => e instanceof SigningGuardError && e.reasonCode === code;

const d = OFFICIAL_USDC_DOMAINS[84532]!;
const DOMAIN = { name: d.name, version: d.version, chainId: 84532, verifyingContract: d.verifyingContract };
const TYPES = { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_FIELDS] };
const A = ethers.getAddress("0x" + "11".repeat(20));
const B = ethers.getAddress("0x" + "22".repeat(20));
let nonce = 0;
const message = (from: string, to: string, value = 10_000n) => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    from, to, value, validAfter: now - 600n, validBefore: now + 60n,
    nonce: ethers.zeroPadValue(ethers.toBeHex(++nonce), 32),
  };
};
const viemTd = (from: string, to: string, value?: bigint) => ({
  domain: DOMAIN, types: TYPES, primaryType: "TransferWithAuthorization", message: message(from, to, value),
});

/** 簽章可控的假 viem 帳戶：簽章前等一個 tick（讓並行交錯），可指定失敗。 */
function fakeAccount(opts: { fail?: (td: any) => boolean } = {}) {
  const real = privateKeyToAccount(generatePrivateKey());
  let calls = 0;
  const acc = {
    ...real,
    async signTypedData(td: any) {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      if (opts.fail?.(td)) throw new Error("HSM offline");
      return real.signTypedData(td);
    },
  };
  return { acc: guardViemAccount(acc as typeof real), address: real.address, calls: () => calls };
}

// 1) 並行 3 筆、上限只夠 1 筆 → 只簽出 1 筆（viem 與 ethers 兩條路徑）
{
  process.env.X402_MAX_TOTAL_SPEND_USDC = "0.01";
  process.env.X402_PAYTO_ALLOWLIST = A;
  resetX402GuardStateForTesting();
  const f = fakeAccount();
  const r = await Promise.allSettled([1, 2, 3].map(() => f.acc.signTypedData(viemTd(f.address, A) as any)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, "viem：只簽出 1 筆");
  for (const x of r) if (x.status === "rejected") assert.ok(isGuard("SPEND_CAP_EXCEEDED")(x.reason));
  assert.equal(f.calls(), 1, "被擋的兩筆根本沒走到底層簽章");
  assert.equal(x402SignedTotal(), 10_000n);

  resetX402GuardStateForTesting();
  const w = new GuardedWallet(process.env.AGENT_PRIVATE_KEY!);
  const r2 = await Promise.allSettled([1, 2, 3].map(() => w.signTypedData(DOMAIN, TYPES, message(w.address, A))));
  assert.equal(r2.filter((x) => x.status === "fulfilled").length, 1, "ethers：只簽出 1 筆");
  assert.equal(x402SignedTotal(), 10_000n);
  ok("累計上限：並行 3 筆 0.01、上限 0.01 → viem／ethers 都只簽出 1 筆（檢查與預留在同一個同步區段）");
}

// 2) 簽章失敗 → 預留回滾，額度可再用
{
  process.env.X402_MAX_TOTAL_SPEND_USDC = "0.01";
  process.env.X402_PAYTO_ALLOWLIST = A;
  resetX402GuardStateForTesting();
  let failNext = true;
  const f = fakeAccount({ fail: () => (failNext ? ((failNext = false), true) : false) });
  await assert.rejects(f.acc.signTypedData(viemTd(f.address, A) as any), /HSM offline/);
  assert.equal(x402SignedTotal(), 0n, "簽章失敗 → 回滾");
  await f.acc.signTypedData(viemTd(f.address, A) as any);
  assert.equal(x402SignedTotal(), 10_000n);
  await assert.rejects(f.acc.signTypedData(viemTd(f.address, A) as any), isGuard("SPEND_CAP_EXCEEDED"));
  ok("簽章失敗時回滾預留；成功後照常計入上限");
}

// 3) TOFU：並行兩筆不同收款人 → 只簽出一筆；之後只允許被釘選的收款人
{
  delete process.env.X402_PAYTO_ALLOWLIST;
  process.env.X402_MAX_TOTAL_SPEND_USDC = "1";
  resetX402GuardStateForTesting();
  const f = fakeAccount();
  const r = await quiet(() => Promise.allSettled([f.acc.signTypedData(viemTd(f.address, A) as any), f.acc.signTypedData(viemTd(f.address, B) as any)]));
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected"]);
  assert.ok(isGuard("PAYTO_NOT_ALLOWLISTED")((r[1] as PromiseRejectedResult).reason));
  assert.deepEqual(x402PayToAllowlist(), [A], "釘選在檢查當下（await 之前）就寫入");
  await assert.rejects(f.acc.signTypedData(viemTd(f.address, B) as any), isGuard("PAYTO_NOT_ALLOWLISTED"));
  ok("TOFU：並行兩筆不同收款人只簽出一筆，釘選在 await 之前寫入");
}

// 4) TOFU 撤銷：釘選的那筆簽章失敗、且沒有其他授權 → 撤銷；有其他授權 → 保留
{
  delete process.env.X402_PAYTO_ALLOWLIST;
  process.env.X402_MAX_TOTAL_SPEND_USDC = "1";
  resetX402GuardStateForTesting();
  const failing = fakeAccount({ fail: () => true });
  await quiet(() => assert.rejects(failing.acc.signTypedData(viemTd(failing.address, A) as any), /HSM offline/));
  assert.equal(x402PayToAllowlist(), null, "唯一一筆失敗 → 撤銷釘選，下一筆可重新釘選");
  const okAcc = fakeAccount();
  await quiet(() => okAcc.acc.signTypedData(viemTd(okAcc.address, B) as any));
  assert.deepEqual(x402PayToAllowlist(), [B]);

  resetX402GuardStateForTesting();
  // 第一筆（釘 A）失敗，但同時有第二筆（也付 A）正在簽 → 保留釘選
  const mixed = fakeAccount({ fail: (td) => td.message.value === 10_000n });
  const p1 = quiet(() => mixed.acc.signTypedData(viemTd(mixed.address, A, 10_000n) as any));
  const p2 = mixed.acc.signTypedData(viemTd(mixed.address, A, 5_000n) as any);
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "fulfilled");
  assert.deepEqual(x402PayToAllowlist(), [A], "還有其他授權 → 不撤銷");
  await assert.rejects(mixed.acc.signTypedData(viemTd(mixed.address, B, 5_000n) as any), isGuard("PAYTO_NOT_ALLOWLISTED"));
  assert.equal(x402SignedTotal(), 5_000n, "失敗那筆已回滾金額");
  ok("TOFU 撤銷：只有釘選那筆失敗且沒有其他授權時才撤銷；否則保留");
}

// 5) meteredFetch：付款後 502／斷線／無法解析都計入「已送出」與 unsettled
{
  const xp = (v: string) => Buffer.from(JSON.stringify({ payload: { authorization: { value: v } } })).toString("base64");
  const m502 = meteredFetch((async () => new Response("{}", { status: 502 })) as unknown as typeof fetch);
  await m502.fetch("http://x", { headers: { "X-PAYMENT": xp("10000") } });
  assert.equal(m502.totalSentAtomic(), 10_000n);
  assert.equal(m502.unsettledAtomic(), 10_000n);
  assert.equal(m502.totalPaidAtomic(), 0n, "未成立的付款不算 paid");

  const net = meteredFetch((async () => { throw new TypeError("socket hang up"); }) as unknown as typeof fetch);
  await assert.rejects(net.fetch("http://x", { headers: { "X-PAYMENT": xp("10000") } }), /socket hang up/);
  assert.equal(net.totalSentAtomic(), 10_000n, "base() 丟錯仍算已送出");
  assert.equal(net.unsettledAtomic(), 10_000n);

  const settled = meteredFetch((async () => new Response("{}", { status: 200, headers: { "X-PAYMENT-RESPONSE": "e30=" } })) as unknown as typeof fetch);
  await settled.fetch("http://x", { headers: { "X-PAYMENT": xp("5000") } });
  await settled.fetch("http://x"); // 沒帶付款 → 不計
  assert.deepEqual([settled.totalSentAtomic(), settled.unsettledAtomic(), settled.totalPaidAtomic()], [5_000n, 0n, 5_000n]);

  const garbage = meteredFetch((async () => new Response("{}", { status: 502 })) as unknown as typeof fetch);
  await garbage.fetch("http://x", { headers: { "X-PAYMENT": "not-base64-json" } });
  assert.equal(garbage.totalSentAtomic(), 10_000n, "解不出金額 → 以單筆上限（0.01）保守計入");
  ok("meteredFetch：付款後 502／base() 丟錯／無法解析的 X-PAYMENT 都計入 totalSentAtomic 與 unsettledAtomic");
}

resetX402GuardStateForTesting();
console.log(`\n✅ x402-guard-concurrency.test.ts 全過（${n} 組）`);
