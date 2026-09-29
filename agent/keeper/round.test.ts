// keeper 一輪（runRound）的整合測試：合約全部 mock 掉，驗證兩顆 oracle 一起寫或一起不寫。
//   cd agent && npx tsx keeper/round.test.ts
import assert from "node:assert";
import { runRound, type Feed, type RoundCtx } from "./round.ts";
import { effectiveBreaker, isRevertWith, ASSET_NOT_FOUND_SELECTOR } from "./core.ts";

const P = (usd: number) => BigInt(Math.round(usd * 1e8));
const NOW = 1_790_000_000;

// 所有寫入依序記在同一條時間線上，用來驗證「先 Guarded、後 Mock」。
let timeline: string[] = [];

function fakeOracle(price: number, opts: { updateThrows?: Error } = {}) {
  const writes: bigint[] = [];
  const state = { price: P(price), at: BigInt(NOW - 3600) };
  return {
    writes,
    state,
    getPrice: async () => [state.price, state.at] as [bigint, bigint],
    updatePrice: async (_id: string, p: bigint) => {
      if (opts.updateThrows) throw opts.updateThrows;
      writes.push(p);
      timeline.push(`mock:${p}`);
      state.price = p;
      state.at = BigInt(NOW);
      return { hash: "0xmock", wait: async () => undefined };
    },
  };
}
function fakeGuarded(
  price: number,
  opts: { frozen?: boolean; exists?: boolean; peekThrows?: boolean; checkThrows?: Error; updateThrows?: Error } = {},
) {
  const writes: bigint[] = [];
  const state = { price: P(price) };
  return {
    writes,
    state,
    peek: async () => {
      if (opts.peekThrows) throw new Error("rpc 429");
      return [state.price, BigInt(NOW - 3600), opts.exists ?? true, opts.frozen ?? false] as [bigint, bigint, boolean, boolean];
    },
    checkUpdate: async () => {
      if (opts.checkThrows) throw opts.checkThrows;
    },
    updatePrice: async (_id: string, p: bigint) => {
      if (opts.updateThrows) throw opts.updateThrows;
      writes.push(p);
      timeline.push(`guarded:${p}`);
      state.price = p;
      return { hash: "0xguarded", wait: async () => undefined };
    },
  };
}
const yahoo = (v: number): Feed => ({ value: v, reason: "ok", source: "yahoo", quoteAgeSec: 60 });
const none: Feed = { value: null, reason: "none", source: "none" };

function ctx(over: Partial<RoundCtx> & Pick<RoundCtx, "oracle">): RoundCtx {
  return {
    symbols: ["sAAPL"],
    nowSec: NOW,
    dryRun: false,
    deviationThreshold: 0.001,
    heartbeatSec: 900,
    breakerDeviation: 0.2,
    confirmTolerance: 0.02,
    guarded: null,
    guardedCap: 1000n,
    assetIdOf: (s) => `id:${s}`,
    fetchRelay: async () => null,
    fetchPrice: async () => yahoo(100),
    fetchSecondary: async () => none,
    log: () => {},
    error: () => {},
    ...over,
  };
}

// ── 必要案例：12% 變動 → 兩顆都不寫 ────────────────────────────────────────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100);
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(112) }));
  assert.equal(oracle.writes.length, 0, "MockOracle 不得寫");
  assert.equal(guarded.writes.length, 0, "GuardedOracle 不得寫");
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.refused.map((x) => x.symbol), ["sAAPL"]);
}

// ── 必要案例：8% 變動 → 兩顆都寫，且是同一個完整價格 ────────────────────────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100);
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(108) }));
  assert.deepEqual(oracle.writes, [P(108)]);
  assert.deepEqual(guarded.writes, [P(108)]);
  assert.equal(r.wrote, 1);
  assert.equal(r.rejected, 0);
}

// ── 向下不對稱：−9.5% 超過 Guarded 的 −9.09% → 兩顆都不寫；−8% → 都寫 ────────
{
  const o1 = fakeOracle(100), g1 = fakeGuarded(100);
  await runRound(ctx({ oracle: o1, guarded: g1, fetchPrice: async () => yahoo(90.5) }));
  assert.equal(o1.writes.length + g1.writes.length, 0);
  const o2 = fakeOracle(100), g2 = fakeGuarded(100);
  await runRound(ctx({ oracle: o2, guarded: g2, fetchPrice: async () => yahoo(92) }));
  assert.deepEqual([o2.writes, g2.writes], [[P(92)], [P(92)]]);
}

// ── 多源確認通過、但 Guarded 會拒絕的大變動 → 一樣兩顆都不寫 ─────────────────
{
  const oracle = fakeOracle(40_000);
  const guarded = fakeGuarded(40_000);
  const r = await runRound(
    ctx({
      symbols: ["sBTC"],
      oracle,
      guarded,
      fetchRelay: async () => ({ price: 83_100, updatedAt: NOW - 30 }),
      fetchPrice: async () => ({ value: 83_000, reason: "ok", source: "coingecko", quoteAgeSec: 60 }),
    }),
  );
  assert.equal(oracle.writes.length, 0);
  assert.equal(guarded.writes.length, 0);
  assert.equal(r.rejected, 1);
  assert.ok(r.refused[0].reason.includes("MockOracle 也不寫") || r.refused[0].reason.includes("都不寫"), r.refused[0].reason);
}

// ── Guarded 讀不到 → 無法確認一致，兩顆都不寫、記 failed ─────────────────────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100, { peekThrows: true });
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(101) }));
  assert.equal(oracle.writes.length, 0);
  assert.equal(r.failed, 1);
}

// ── Guarded 已凍結 → fail-closed，兩顆都不寫（窄複審 2；即使變動很小） ────────────
for (const target of [101, 112]) {
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100, { frozen: true });
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(target) }));
  assert.equal(oracle.writes.length, 0, `凍結時 Mock 不得寫（${target}）`);
  assert.equal(guarded.writes.length, 0);
  assert.equal(r.rejected, 1);
  assert.ok(r.refused[0].reason.includes("已凍結"), r.refused[0].reason);
}
// ── Guarded 沒有此資產 → 門檻仍是 Guarded 上限（10%），不放寬回 20% ─────────────
{
  const o1 = fakeOracle(100);
  await runRound(ctx({ oracle: o1, guarded: fakeGuarded(0, { exists: false }), fetchPrice: async () => yahoo(112) }));
  assert.equal(o1.writes.length, 0, "12% 超過有效門檻 10%，拒寫");
  const o2 = fakeOracle(100);
  await runRound(ctx({ oracle: o2, guarded: fakeGuarded(0, { exists: false }), fetchPrice: async () => yahoo(108) }));
  assert.deepEqual(o2.writes, [P(108)], "8% 在門檻內，只寫 Mock（Guarded 沒有此資產）");
}

// ── 沒有 GuardedOracle → 門檻就是 KEEPER_BREAKER_DEVIATION ───────────────────
{
  const oracle = fakeOracle(100);
  await runRound(ctx({ oracle, fetchPrice: async () => yahoo(112) }));
  assert.deepEqual(oracle.writes, [P(112)]);
}

// ── DRY_RUN 不寫任何一顆 ──────────────────────────────────────────────────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100);
  await runRound(ctx({ oracle, guarded, dryRun: true, fetchPrice: async () => yahoo(108) }));
  assert.equal(oracle.writes.length + guarded.writes.length, 0);
}

// ── seed 只限明確的 AssetNotFound；429／逾時不寫（複審 Medium） ────────────────
{
  const notFound = Object.assign(new Error("execution reverted"), { data: ASSET_NOT_FOUND_SELECTOR + "00".repeat(32) });
  const rateLimited = Object.assign(new Error("429 Too Many Requests"), { code: "SERVER_ERROR" });
  const mk = (err: Error) => {
    const writes: bigint[] = [];
    return {
      writes,
      getPrice: async (): Promise<[bigint, bigint]> => { throw err; },
      updatePrice: async (_id: string, p: bigint) => {
        writes.push(p);
        return { hash: "0x", wait: async () => undefined };
      },
    };
  };
  const isNF = (e: unknown) => isRevertWith((e as { data?: unknown }).data, ASSET_NOT_FOUND_SELECTOR);

  const o1 = mk(notFound);
  const r1 = await runRound(ctx({ oracle: o1, isAssetNotFound: isNF, fetchPrice: async () => yahoo(311) }));
  assert.deepEqual(o1.writes, [P(311)], "AssetNotFound → seed");
  assert.equal(r1.failed, 0);

  const o2 = mk(rateLimited);
  const r2 = await runRound(ctx({ oracle: o2, isAssetNotFound: isNF, fetchPrice: async () => yahoo(311) }));
  assert.equal(o2.writes.length, 0, "429 不得當 seed 寫入");
  assert.equal(r2.failed, 1);
  assert.deepEqual(r2.skippedSymbols, ["sAAPL"]);

  // 沒有提供判斷函式 → 一律不當 seed（fail-closed）。
  const o3 = mk(notFound);
  await runRound(ctx({ oracle: o3, fetchPrice: async () => yahoo(311) }));
  assert.equal(o3.writes.length, 0);
}

// ── 窄複審 3：寫入順序 —— 先 Guarded、成功才 Mock ─────────────────────────────
{
  timeline = [];
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100);
  await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(105) }));
  assert.deepEqual(timeline, [`guarded:${P(105)}`, `mock:${P(105)}`]);
}

// ── 窄複審 3／7：Guarded updatePrice 丟錯 → Mock 不寫、記 failed、兩顆仍一致 ──────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100, { updateThrows: new Error("nonce too low") });
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(105) }));
  assert.equal(oracle.writes.length, 0, "Guarded 沒寫成就不寫 Mock");
  assert.equal(r.failed, 1);
  assert.equal(oracle.state.price, guarded.state.price);
}

// ── 窄複審 3：staticCall 預檢失敗（paused／role…）→ 兩顆都不寫、列入熔斷 ─────────
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100, { checkThrows: new Error("IsPaused()") });
  const r = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(101) }));
  assert.equal(oracle.writes.length + guarded.writes.length, 0);
  assert.equal(r.rejected, 1);
  assert.ok(r.refused[0].reason.includes("預檢") && r.refused[0].reason.includes("IsPaused"), r.refused[0].reason);
}

// ── 窄複審 3／7：初始兩顆不一致，即使 planUpdate 說不用寫也會收斂 ──────────────────
{
  const oracle = fakeOracle(100);
  oracle.state.at = BigInt(NOW - 60); // 剛寫過、價格沒動 → planUpdate.write=false
  const guarded = fakeGuarded(105);
  await runRound(ctx({ oracle, guarded, heartbeatSec: 7200, fetchPrice: async () => yahoo(100) }));
  assert.deepEqual(guarded.writes, [P(100)], "Guarded 補寫到目標");
  assert.equal(oracle.writes.length, 0, "Mock 已是目標值，不重寫");
  assert.equal(oracle.state.price, guarded.state.price, "兩顆收斂");
}
// 不一致且超過 Guarded 上限 → 拒寫，訊息要寫「兩顆已不一致」（與真的超限區分）。
{
  const oracle = fakeOracle(100);
  oracle.state.at = BigInt(NOW - 60);
  const guarded = fakeGuarded(120);
  const r = await runRound(ctx({ oracle, guarded, heartbeatSec: 7200, fetchPrice: async () => yahoo(100) }));
  assert.equal(r.rejected, 1);
  assert.ok(r.refused[0].reason.includes("兩顆已不一致"), r.refused[0].reason);
  const r2 = await runRound(ctx({ oracle: fakeOracle(100), guarded: fakeGuarded(100), fetchPrice: async () => yahoo(109.9) }));
  assert.equal(r2.rejected, 0);
  const r3 = await runRound(
    ctx({
      oracle: fakeOracle(100),
      guarded: fakeGuarded(100),
      fetchPrice: async () => yahoo(115),
      fetchSecondary: async () => ({ value: 115.2, reason: "ok", source: "yahoo2", quoteAgeSec: 60 }),
    }),
  );
  assert.ok(r3.refused[0].reason.includes("變動超過 GuardedOracle 上限") || r3.refused[0].reason.includes("熔斷"), r3.refused[0].reason);
}

// ── 窄複審 7：連續情境 —— Mock 寫失敗 → 下一輪補上；拒寫 → 下一輪行情回來就寫 ────
{
  const guarded = fakeGuarded(100);
  const flaky = fakeOracle(100, { updateThrows: new Error("replacement underpriced") });
  const r1 = await runRound(ctx({ oracle: flaky, guarded, fetchPrice: async () => yahoo(105) }));
  assert.equal(r1.failed, 1);
  assert.equal(guarded.state.price, P(105), "Guarded 已寫");
  // 下一輪：同一顆 Mock（狀態仍是 100）、這次寫得進去；Guarded 已是目標 → 只補 Mock。
  const healthy = fakeOracle(100);
  healthy.state.at = BigInt(NOW - 60);
  const g2writes = guarded.writes.length;
  await runRound(ctx({ oracle: healthy, guarded, heartbeatSec: 7200, fetchPrice: async () => yahoo(105) }));
  assert.deepEqual(healthy.writes, [P(105)]);
  assert.equal(guarded.writes.length, g2writes, "Guarded 不重寫");
  assert.equal(healthy.state.price, guarded.state.price);
}
{
  const oracle = fakeOracle(100);
  const guarded = fakeGuarded(100);
  const r1 = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(112) }));
  assert.equal(r1.rejected, 1);
  const r2 = await runRound(ctx({ oracle, guarded, fetchPrice: async () => yahoo(108) }));
  assert.equal(r2.rejected, 0);
  assert.deepEqual([oracle.state.price, guarded.state.price], [P(108), P(108)]);
}

// ── effectiveBreaker ─────────────────────────────────────────────────────
assert.equal(effectiveBreaker(0.2, 1000n, true), 0.1);
assert.ok(Math.abs(effectiveBreaker(0.2, 1000n, false) - 1000 / 11000) < 1e-12);
assert.equal(effectiveBreaker(0.05, 1000n, true), 0.05);
assert.equal(effectiveBreaker(0.2, 0n, true), 0.2);

console.log("round.test.ts ✓ all assertions passed");
