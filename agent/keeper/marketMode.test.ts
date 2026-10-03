// marketOperator 休市切換的鏈上編排（marketMode.ts）：交易所、時鐘全部注入（審查 L6）。
//   cd agent && npx tsx keeper/marketMode.test.ts
import assert from "node:assert";
import { classifyProtected, closedForTrading, createMarketMode, type ExchangeModeLike } from "./marketMode.ts";
import { runRound, type Feed, type RoundCtx } from "./round.ts";
import type { MarketSession } from "./market.ts";

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const KEEPER = "0x00000000000000000000000000000000000000Aa";
const TUE_10 = utc(2026, 9, 29, 14, 0); // 週二 10:00 EDT
const SAT = utc(2026, 10, 3, 15, 0);
const SESS: MarketSession = { regularStart: utc(2026, 9, 29, 13, 30), regularEnd: utc(2026, 9, 29, 20, 0), regularMarketTime: TUE_10 - 60 };
const MISSING = Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null });
const DENIED = Object.assign(new Error("AssetModeChangeNotAllowed"), { code: "CALL_EXCEPTION", data: "0xdeadbeef00" });

let timeline: string[] = [];

function fakeExchange(o: {
  operator?: string;
  modes?: Record<string, number>;
  locked?: Record<string, boolean>;
  missing?: boolean;
} = {}) {
  const modes: Record<string, number> = { ...(o.modes ?? {}) };
  const locked: Record<string, boolean> = { ...(o.locked ?? {}) };
  const calls = { checks: [] as string[], sets: [] as string[], reads: 0 };
  const ex: ExchangeModeLike = {
    marketOperator: async () => {
      if (o.missing) throw MISSING;
      return o.operator ?? KEEPER;
    },
    assetMode: async (id) => {
      calls.reads += 1;
      if (o.missing) throw MISSING;
      return modes[id] ?? 0;
    },
    guardianLocked: async (id) => locked[id] ?? false,
    checkSetAssetMode: async (id, mode) => {
      calls.checks.push(`${id}:${mode}`);
      // 合約規則：operator 不能放寬上鎖的資產。
      if (locked[id] && mode < (modes[id] ?? 0)) throw DENIED;
    },
    setAssetMode: async (id, mode) => {
      calls.sets.push(`${id}:${mode}`);
      timeline.push(`mode:${id}:${mode}`);
      modes[id] = mode;
      return { hash: "0xmode", wait: async () => undefined };
    },
  };
  return { ex, modes, calls };
}

function mm(ex: ExchangeModeLike, over: Partial<Parameters<typeof createMarketMode>[0]> = {}) {
  const logs: string[] = [];
  const m = createMarketMode({
    exchange: ex,
    signerAddress: KEEPER.toLowerCase(),
    now: () => TUE_10,
    fetchSession: async () => SESS,
    leadSec: 3 * 3600,
    allowed: null,
    revertInfo: (e) => e as { code?: unknown; data?: unknown },
    isTimeout: (e) => (e as { code?: unknown })?.code === "TIMEOUT",
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    ...over,
  });
  return { m, logs };
}

// ── M1：guardian 上鎖的資產，放寬階段不預檢、不送、不記 failed ─────────────────
{
  const { ex, calls } = fakeExchange({ modes: { sAAPL: 1 }, locked: { sAAPL: true } });
  const { m, logs } = mm(ex);
  assert.equal(await m.prepare(), "ready");
  const failed = await m.loosenPass([{ symbol: "sAAPL", assetId: "sAAPL", quoteAgeSec: 60 }]);
  assert.equal(failed, 0, "上鎖不算失敗（修正前每輪 failed=1、job 紅）");
  assert.deepEqual(calls.checks, [], "不做必定被拒的預檢");
  assert.ok(logs.some((l) => l.includes("guardian 已上鎖")), logs.join("\n"));
}
// 沒上鎖、開盤、報價新鮮 → 放寬。
{
  const { ex, calls } = fakeExchange({ modes: { sAAPL: 1 } });
  const { m } = mm(ex);
  await m.prepare();
  assert.equal(await m.loosenPass([{ symbol: "sAAPL", assetId: "sAAPL", quoteAgeSec: 60 }]), 0);
  assert.deepEqual(calls.sets, ["sAAPL:0"]);
}

// ── L2：keeper 不是 marketOperator → 一條警告、整輪不切、不逐檔記 failed ─────────
{
  const { ex, calls } = fakeExchange({ operator: "0x00000000000000000000000000000000000000Bb" });
  const { m, logs } = mm(ex, { now: () => SAT });
  assert.equal(await m.prepare(), "not-operator");
  for (const s of ["sAAPL", "sTSLA", "sGOLD"]) assert.equal(await m.tighten(s, s, { value: 100, quoteAgeSec: 60 }), "ok");
  assert.equal(await m.loosenPass([{ symbol: "sAAPL", assetId: "sAAPL", quoteAgeSec: 60 }]), 0);
  assert.equal(calls.reads + calls.checks.length + calls.sets.length, 0, "不讀模式、不預檢、不送");
  assert.equal(logs.filter((l) => l.startsWith("::warning::")).length, 1);
}
// DRY_RUN（沒有 signer）無從比對 operator → ready，只做決策不送。
{
  const { ex, calls } = fakeExchange({ operator: "0x00000000000000000000000000000000000000Bb" });
  const { m } = mm(ex, { signerAddress: null, now: () => SAT });
  assert.equal(await m.prepare(), "ready");
  assert.equal(await m.tighten("sAAPL", "sAAPL", { value: 100, quoteAgeSec: 60 }), "ok");
  assert.deepEqual(calls.sets, []);
}
// 租戶只切自己註冊的資產。
{
  const { ex, calls } = fakeExchange();
  const { m } = mm(ex, { now: () => SAT, allowed: new Set(["sAAPL"]) });
  await m.prepare();
  await m.tighten("sAAPL", "sAAPL", { value: 100, quoteAgeSec: 60 });
  await m.tighten("sTSLA", "sTSLA", { value: 100, quoteAgeSec: 60 });
  assert.deepEqual(calls.sets, ["sAAPL:1"], "sTSLA 不是這個租戶的資產");
}
// 舊合約 → missing，什麼都不送。
{
  const { ex, calls } = fakeExchange({ missing: true });
  const { m } = mm(ex, { now: () => SAT });
  assert.equal(await m.prepare(), "missing");
  assert.equal(await m.tighten("sAAPL", "sAAPL", { value: 100, quoteAgeSec: 60 }), "ok");
  assert.equal(calls.sets.length + calls.checks.length, 0);
}
// 加密資產連 RPC 都不打。
{
  const { ex, calls } = fakeExchange();
  const { m } = mm(ex, { now: () => SAT });
  await m.prepare();
  assert.equal(await m.tighten("sBTC", "sBTC", { value: 1, quoteAgeSec: 99_999 }), "ok");
  assert.equal(calls.reads, 0);
}

// ── H1：放寬每個資產重新取時間；本輪開頭 15:58、放寬時已 16:01 → 不放寬 ─────────
{
  const { ex, calls } = fakeExchange({ modes: { sBOND: 1 } });
  let clock = utc(2026, 9, 29, 19, 58);
  const { m } = mm(ex, { now: () => clock, leadSec: 0 });
  await m.prepare();
  clock = utc(2026, 9, 29, 20, 1);
  await m.loosenPass([{ symbol: "sBOND", assetId: "sBOND", quoteAgeSec: 120 }]);
  assert.deepEqual(calls.sets, [], "用放寬當下的時間判斷（收盤後）");
}

// ── 編排順序：收緊在寫價前；熔斷拒寫的資產同一輪不放寬；放寬逾時就停 ─────────────
{
  timeline = [];
  const { ex, calls } = fakeExchange({ modes: { sAAPL: 0, sTSLA: 1, sNVDA: 1 } });
  const { m } = mm(ex, { now: () => SAT });
  await m.prepare();
  const oracle = {
    getPrice: async () => [10_000_000_000n, BigInt(SAT - 3600)] as [bigint, bigint],
    updatePrice: async (id: string) => {
      timeline.push(`price:${id}`);
      return { hash: "0xp", wait: async () => undefined };
    },
  };
  const feed = (v: number): Feed => ({ value: v, reason: "ok", source: "yahoo", quoteAgeSec: 40 * 3600 });
  const ctx: RoundCtx = {
    symbols: ["sAAPL"], nowSec: SAT, dryRun: false, deviationThreshold: 0.001, heartbeatSec: 900,
    breakerDeviation: 0.2, confirmTolerance: 0.02, oracle, guarded: null, guardedCap: 1000n,
    assetIdOf: (s) => s, fetchRelay: async () => null, fetchPrice: async () => feed(100),
    fetchSecondary: async () => ({ value: null, reason: "none", source: "none" }),
    beforeAsset: (s, id, f) => m.tighten(s, id, f), log: () => {}, error: () => {},
  };
  await runRound(ctx);
  assert.deepEqual(timeline, ["mode:sAAPL:1", "price:sAAPL"], "週六：先切 ReduceOnly，再 heartbeat 寫價");
  calls.sets.length = 0;
}
{
  // 週二盤中：sTSLA 熔斷拒寫（+50%）、sNVDA 正常 → 只放寬 sNVDA。
  const { ex, calls } = fakeExchange({ modes: { sTSLA: 1, sNVDA: 1 } });
  const { m } = mm(ex);
  await m.prepare();
  const oracle = {
    getPrice: async () => [10_000_000_000n, BigInt(TUE_10 - 3600)] as [bigint, bigint],
    updatePrice: async () => ({ hash: "0xp", wait: async () => undefined }),
  };
  const r = await runRound({
    symbols: ["sTSLA", "sNVDA"], nowSec: TUE_10, dryRun: false, deviationThreshold: 0.001, heartbeatSec: 900,
    breakerDeviation: 0.2, confirmTolerance: 0.02, oracle, guarded: null, guardedCap: 1000n,
    assetIdOf: (s) => s, fetchRelay: async () => null,
    fetchPrice: async (s) => ({ value: s === "sTSLA" ? 150 : 100, reason: "ok", source: "yahoo", quoteAgeSec: 60 }),
    fetchSecondary: async () => ({ value: null, reason: "none", source: "none" }),
    beforeAsset: (s, id, f) => m.tighten(s, id, f), log: () => {}, error: () => {},
  });
  assert.deepEqual(r.refused.map((x) => x.symbol), ["sTSLA"]);
  assert.equal(await m.loosenPass(r.priced), 0);
  assert.deepEqual(calls.sets, ["sNVDA:0"], "熔斷拒寫的 sTSLA 同一輪不放寬");
}
{
  // 放寬時等確認逾時 → 記一次、停止後續放寬。
  const { ex, calls } = fakeExchange({ modes: { sAAPL: 1, sTSLA: 1 } });
  ex.setAssetMode = async (id) => {
    calls.sets.push(id);
    return { hash: "0xslow", wait: async () => { throw Object.assign(new Error("t"), { code: "TIMEOUT" }); } };
  };
  const { m } = mm(ex);
  await m.prepare();
  const n = await m.loosenPass([
    { symbol: "sAAPL", assetId: "sAAPL", quoteAgeSec: 60 },
    { symbol: "sTSLA", assetId: "sTSLA", quoteAgeSec: 60 },
  ]);
  assert.equal(n, 1);
  assert.deepEqual(calls.sets, ["sAAPL"]);
}

// ── M2：休市造成的 ReduceOnly 不算保護中 ─────────────────────────────────────
{
  const SYMS = ["sBTC", "sAAPL", "sTSLA", "sNVDA", "sGOLD"];
  const { ex } = fakeExchange({
    modes: { sAAPL: 1, sTSLA: 1, sNVDA: 2, sBTC: 1, sGOLD: 1 },
    locked: { sTSLA: true },
  });
  const base = { symbols: SYMS, exchange: ex, assetIdOf: (s: string) => s, leadSec: 3 * 3600, revertInfo: (e: unknown) => e as { code?: unknown } };
  const sat = await classifyProtected({ ...base, nowSec: SAT });
  assert.deepEqual(sat.closed, ["sAAPL(休市)", "sGOLD(休市)"]);
  assert.deepEqual(sat.protected, ["sBTC(ReduceOnly)", "sTSLA(ReduceOnly,guardian 上鎖)", "sNVDA(Halted)"]);
  // 盤中同樣的 ReduceOnly 就是保護中（熔斷）。
  const tue = await classifyProtected({ ...base, nowSec: TUE_10 });
  assert.deepEqual(tue.closed, []);
  assert.ok(tue.protected.includes("sAAPL(ReduceOnly)"));
  // 舊合約 → 兩者皆空。
  const old = await classifyProtected({ ...base, exchange: fakeExchange({ missing: true }).ex, nowSec: SAT });
  assert.deepEqual(old, { protected: [], closed: [] });
}

// closedForTrading：警告文字用。週六所有非加密資產；週二 10:00 ET 沒有；14:00 ET（提前量內）股票都在。
assert.deepEqual(closedForTrading(["sBTC", "sAAPL", "sGOLD"], SAT, 3 * 3600), ["sAAPL", "sGOLD"]);
assert.deepEqual(closedForTrading(["sBTC", "sAAPL", "sGOLD"], TUE_10, 3 * 3600), []);
assert.deepEqual(closedForTrading(["sBTC", "sAAPL", "sGOLD"], utc(2026, 9, 29, 18, 0), 3 * 3600), ["sAAPL"]);

console.log("marketMode.test.ts ✓ all assertions passed");
