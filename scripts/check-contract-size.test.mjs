// 自我測試：先證明門檻會擋，再讓 CI 用它檢查 repo。
//   node --test scripts/check-contract-size.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUDGETS, EIP170_LIMIT, checkBudgetTable, checkSizes, runtimeSize } from "./check-contract-size.mjs";

function fakeOut(sizes) {
  const dir = mkdtempSync(join(tmpdir(), "size-gate-"));
  for (const [artifact, bytes] of Object.entries(sizes)) {
    const file = join(dir, artifact);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ deployedBytecode: { object: "0x" + "60".repeat(bytes) } }));
  }
  return dir;
}

const budget = (bytes, extra = {}) => ({
  X: {
    artifact: "X.sol/X.json",
    maxRuntimeBytes: bytes,
    history: [{ bytes, date: "2026-10-04", reason: "測試用的釘選值，理由夠長" }],
    ...extra,
  },
});

test("釘選表：主合約有預算、目前值 23,911 B、不超過 EIP-170、有理由", () => {
  assert.deepEqual(checkBudgetTable(), []);
  assert.equal(BUDGETS.PerpetualExchange.maxRuntimeBytes, 23911);
  assert.ok(BUDGETS.PerpetualExchange.maxRuntimeBytes <= EIP170_LIMIT);
  assert.equal(BUDGETS.PerpetualExchange.artifact, "PerpetualExchange.sol/PerpetualExchange.json");
});

test("runtimeSize：含 library 佔位也照 2 hex／byte 計", () => {
  assert.equal(runtimeSize("0x6080"), 2);
  assert.equal(runtimeSize("0x60" + "__$0123456789abcdef0123456789abcdef01$__" + "00"), 22);
  assert.throws(() => runtimeSize("0x"), /空的/);
  assert.throws(() => runtimeSize("0x608"), /奇數/);
});

test("等於預算 → 通過；多 1 B → 擋下並指出要改哪裡", () => {
  const dir = fakeOut({ "X.sol/X.json": 100 });
  try {
    assert.deepEqual(checkSizes({ outDir: dir, budgets: budget(100) }).problems, []);
    const { problems } = checkSizes({ outDir: dir, budgets: budget(99) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /超過釘選預算 99 B（多 1 B）/);
    assert.match(problems[0], /BUDGETS\.X/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只改 maxRuntimeBytes、沒在 history 寫理由 → 擋下", () => {
  const b = budget(100);
  b.X.maxRuntimeBytes = 120; // 偷偷放寬
  assert.ok(checkBudgetTable(b).some((p) => /history 最後一筆 100 不同/.test(p)));
});

test("history 理由太短或缺 → 擋下", () => {
  const b = budget(100);
  b.X.history.push({ bytes: 120, date: "2026-10-05", reason: "需要" });
  b.X.maxRuntimeBytes = 120;
  assert.ok(checkBudgetTable(b).some((p) => /沒有寫理由/.test(p)));
  const c = budget(100);
  delete c.X.history[0].reason;
  assert.ok(checkBudgetTable(c).some((p) => /沒有寫理由/.test(p)));
  assert.ok(checkBudgetTable(budget(100, { history: [] })).some((p) => /history 不可為空/.test(p)));
});

test("預算超過 EIP-170 → 擋下", () => {
  assert.ok(checkBudgetTable(budget(EIP170_LIMIT + 1)).some((p) => /EIP-170/.test(p)));
});

test("找不到產物 → 擋下（不可無聲通過）", () => {
  const dir = fakeOut({});
  try {
    const { problems } = checkSizes({ outDir: dir, budgets: budget(100) });
    assert.ok(problems.some((p) => /找不到編譯產物/.test(p)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
