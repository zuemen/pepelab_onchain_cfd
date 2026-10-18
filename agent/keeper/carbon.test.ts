// 碳權退役 crank 的純函式測試（#333、ADR-022）。
//   cd agent && npx tsx keeper/carbon.test.ts
import assert from "node:assert";
import { crankCarbon, discoverCarbon, planRetirement } from "./carbon.ts";

const E18 = 10n ** 18n;

// ── planRetirement：預算夠買到至少 1 單位、賣方交得出來，才退役整筆預算 ─────
assert.deepEqual(planRetirement({ budget: 0n, tonnes: 0n, available: 100n * E18 }), { skip: "no-budget" });
assert.deepEqual(planRetirement({ budget: 5n, tonnes: 0n, available: 100n * E18 }), { skip: "below-one-unit" });
assert.deepEqual(planRetirement({ budget: 15n * E18 / 10n, tonnes: 15n * E18 / 100n, available: E18 / 10n }), {
  skip: "seller-short",
});
assert.deepEqual(planRetirement({ budget: 15n * E18 / 10n, tonnes: 15n * E18 / 100n, available: 100n * E18 }), {
  amount: 15n * E18 / 10n,
  tonnes: 15n * E18 / 100n,
});

// ── crankCarbon：有待分配就 distribute，有預算就 retire ────────────────────────
function fakes(o: { pending: bigint; budgetAfter: bigint; pricePerTonne: bigint; available?: bigint }) {
  const calls: string[] = [];
  let budget = 0n;
  const splitter = {
    pending: async () => o.pending,
    distribute: async () => {
      calls.push("distribute");
      budget = o.budgetAfter;
    },
  };
  const retirement = {
    budget: async () => budget,
    quoteTonnes: async (amount: bigint) => (amount * E18) / o.pricePerTonne,
    availableTonnes: async () => o.available ?? 100_000n * E18,
    retire: async (amount: bigint) => {
      calls.push(`retire ${amount}`);
      budget -= amount;
    },
  };
  return { splitter, retirement, calls };
}

{
  // 一次跟單 10,000：平台 6、退役預算 1.5、每公噸 10 → 0.15 公噸
  const f = fakes({ pending: 6n * E18, budgetAfter: 15n * E18 / 10n, pricePerTonne: 10n * E18 });
  const r = await crankCarbon(f.splitter, f.retirement);
  assert.deepEqual(f.calls, ["distribute", `retire ${15n * E18 / 10n}`]);
  assert.deepEqual(r, { distributed: 6n * E18, spent: 15n * E18 / 10n, retiredTonnes: 15n * E18 / 100n, skipped: null });
}
{
  // 沒有待分配、也沒有預算：什麼都不送（distribute 在空的時候會 revert NothingToDistribute）
  const f = fakes({ pending: 0n, budgetAfter: 0n, pricePerTonne: 10n * E18 });
  const r = await crankCarbon(f.splitter, f.retirement);
  assert.deepEqual(f.calls, []);
  assert.equal(r.skipped, "no-budget");
}
{
  // 賣方庫存不足：分配照做，退役略過並回報原因，不 revert
  const f = fakes({ pending: 6n * E18, budgetAfter: 15n * E18 / 10n, pricePerTonne: 10n * E18, available: 0n });
  const r = await crankCarbon(f.splitter, f.retirement);
  assert.deepEqual(f.calls, ["distribute"]);
  assert.equal(r.skipped, "seller-short");
  assert.equal(r.retiredTonnes, 0n);
}

// ── discoverCarbon：exchange → feeRouter → platformTreasury；不是分流合約就回 null ──
const EX = "0x00000000000000000000000000000000000000e1";
const ROUTER = "0x00000000000000000000000000000000000000f1";
const SPLITTER = "0x0000000000000000000000000000000000000051";
const RETIRE = "0x00000000000000000000000000000000000000c1";
const LEAKED = "0xE80A81360608C1342e66743F70a00f75d792Eb93";
{
  const found = await discoverCarbon(EX, {
    feeRouterOf: async (a) => (a === EX ? ROUTER : "0x"),
    platformTreasuryOf: async (a) => (a === ROUTER ? SPLITTER : "0x"),
    carbonRetirementOf: async (a) => (a === SPLITTER ? RETIRE : null),
  });
  assert.deepEqual(found, { feeRouter: ROUTER, splitter: SPLITTER, retirement: RETIRE });
}
{
  // 現行 Base Sepolia：平台收款人是 EOA（外洩地址），沒有 carbonRetirement() → 不 crank
  const found = await discoverCarbon(EX, {
    feeRouterOf: async () => ROUTER,
    platformTreasuryOf: async () => LEAKED,
    carbonRetirementOf: async () => null,
  });
  assert.equal(found, null);
}
{
  // 交易所沒有接 FeeRouter
  const found = await discoverCarbon(EX, {
    feeRouterOf: async () => "0x0000000000000000000000000000000000000000",
    platformTreasuryOf: async () => {
      throw new Error("must not be called");
    },
    carbonRetirementOf: async () => null,
  });
  assert.equal(found, null);
}

console.log("keeper/carbon.test.ts: ok");
