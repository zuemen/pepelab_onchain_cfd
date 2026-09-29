// settlement.ts 的 settleWith（簽出 → 記錄 → 廣播 → 等 receipt）離線測試。
//   cd agent && npx tsx signal-api/src/settlement.test.ts
//
// 假 provider / 假合約；signer 是測試內臨時產生的隨機錢包（只用來離線簽章，
// 從不連網、不持有任何資產），不讀任何環境金鑰。
import assert from "node:assert";
import { ethers } from "ethers";

delete process.env.FEE_SETTLEMENT_PRIVATE_KEY;
process.env.BASE_SEPOLIA_RPC_URL ??= "http://127.0.0.1:1";
const { settleWith } = await import("./settlement.ts");
type Deps = Parameters<typeof settleWith>[0];

const ROUTER = "0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TRADER = "0x5555555555555555555555555555555555555555";

function makeDeps(opts: {
  broadcast?: () => Promise<unknown>;
  wait?: () => Promise<{ status: number | null } | null>;
}) {
  const signer = ethers.Wallet.createRandom();
  const calls = { broadcast: 0, wait: 0 };
  const iface = new ethers.Interface(["function routeExternalRevenue(address trader, uint256 fee)"]);
  const deps: Deps = {
    signer: {
      address: signer.address,
      // 離線填齊欄位（不連網）
      populateTransaction: async (tx) => ({
        ...tx,
        from: signer.address,
        nonce: 7,
        gasLimit: 100_000n,
        chainId: 84532n,
        maxFeePerGas: 1_000_000n,
        maxPriorityFeePerGas: 1_000n,
        type: 2,
      }) as ethers.TransactionLike<string>,
      signTransaction: (tx) => signer.signTransaction({ ...tx, from: undefined }),
    },
    usdc: {
      decimals: async () => 6n,
      balanceOf: async () => 10n ** 12n,
      allowance: async () => ethers.MaxUint256,
      approve: async () => ({ wait: async () => undefined }),
      mint: async () => ({ wait: async () => undefined }),
    },
    feeRouter: {
      routeExternalRevenue: {
        populateTransaction: async (trader: string, fee: bigint) =>
          ({ to: ROUTER, data: iface.encodeFunctionData("routeExternalRevenue", [trader, fee]) }) as ethers.ContractTransaction,
      },
    },
    provider: {
      broadcastTransaction: async () => {
        calls.broadcast += 1;
        return opts.broadcast ? opts.broadcast() : undefined;
      },
      waitForTransaction: async () => {
        calls.wait += 1;
        return opts.wait ? opts.wait() : { status: 1 };
      },
    },
    settlementToken: TOKEN,
    routerAddress: ROUTER,
    mintableToken: "0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035",
    waitTimeoutMs: 1_000,
  };
  return { deps, calls };
}

// ── 1) 正常：onSigned 先拿到 hash / nonce / raw，再廣播，receipt 成功 → settled ──
{
  const { deps, calls } = makeDeps({});
  let seen: { txHash: string; nonce: number; rawTx: string } | undefined;
  const r = await settleWith(deps, TRADER, 0.01, {
    onSigned: async (info) => {
      assert.equal(calls.broadcast, 0, "onSigned 必須在廣播之前");
      seen = info;
    },
  });
  assert.equal(r.status, "settled");
  assert.equal(seen?.nonce, 7);
  assert.equal(seen?.txHash, ethers.Transaction.from(seen!.rawTx).hash, "hash 與 raw tx 一致");
  assert.equal(r.tx, seen?.txHash);
  console.log("✓ 正常流程：先記錄（hash/nonce/raw）再廣播 → settled");
}

// ── 2) onSigned throw → 絕不廣播，回 failed ────────────────────────────────
{
  const { deps, calls } = makeDeps({});
  const r = await settleWith(deps, TRADER, 0.01, {
    onSigned: async () => {
      throw new Error("redis down (fake)");
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(calls.broadcast, 0, "記錄失敗時不可 broadcastTransaction");
  console.log("✓ onSigned 丟錯 → 不廣播、failed");
}

// ── 3) 廣播回 NONCE_EXPIRED（nonce too low）→ unknown：可能其實已上鏈，交給對帳 ──
{
  for (const code of ["NONCE_EXPIRED", "INSUFFICIENT_FUNDS", "REPLACEMENT_UNDERPRICED"]) {
    const { deps, calls } = makeDeps({
      broadcast: async () => {
        throw Object.assign(new Error("rejected (fake)"), { code });
      },
    });
    const r = await settleWith(deps, TRADER, 0.01);
    assert.equal(r.status, "unknown", `${code} 必須是 unknown（不可判 failed 後重試）`);
    assert.ok(r.tx);
    assert.equal(calls.wait, 0);
  }
  console.log("✓ broadcast NONCE_EXPIRED / 其他拒絕 → unknown（不重試）");
}

// ── 4) 廣播遇到網路錯誤 → unknown（可能已送出，絕不重送）──────────────────
{
  const { deps } = makeDeps({
    broadcast: async () => {
      throw Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" });
    },
  });
  const r = await settleWith(deps, TRADER, 0.01);
  assert.equal(r.status, "unknown");
  assert.ok(r.tx, "unknown 必須帶 tx hash 供對帳");
  console.log("✓ broadcast 網路錯誤 → unknown（帶 hash）");
}

// ── 5) 等 receipt 逾時 → unknown；receipt status=0 → reverted ──────────────
{
  const t = makeDeps({
    wait: async () => {
      throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
    },
  });
  assert.equal((await settleWith(t.deps, TRADER, 0.01)).status, "unknown");
  const rv = makeDeps({ wait: async () => ({ status: 0 }) });
  assert.equal((await settleWith(rv.deps, TRADER, 0.01)).status, "reverted");
  console.log("✓ wait 逾時 → unknown；receipt status=0 → reverted");
}

// ── 6) 餘額不足且不是可鑄幣的 MockUSDC → failed，不簽不送 ────────────────────
{
  const { deps, calls } = makeDeps({});
  deps.usdc.balanceOf = async () => 0n;
  let signed = false;
  const r = await settleWith(deps, TRADER, 0.01, { onSigned: async () => void (signed = true) });
  assert.equal(r.status, "failed");
  assert.equal(signed, false);
  assert.equal(calls.broadcast, 0);
  console.log("✓ 餘額不足 → failed，不簽不送");
}

console.log("settlement.test.ts ✓ all assertions passed");
