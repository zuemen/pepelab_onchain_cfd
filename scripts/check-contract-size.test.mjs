// 自我測試：先證明門檻會擋，再讓 CI 用它檢查 repo。
//   node --test scripts/check-contract-size.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUDGETS, EIP170_LIMIT, checkAppendOnly, checkBudgetTable, checkSizes, loadBaseBudgets, loadBudgets, runtimeSize } from "./check-contract-size.mjs";

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

test("釘選表（scripts/contract-size-budget.json）：主合約有預算、目前值 23,911 B、不超過 EIP-170、有理由", () => {
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
    assert.ok(problems[0].includes("contract-size-budget.json 的 X"));
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

const clone = (x) => JSON.parse(JSON.stringify(x));

test("只能追加：沒動 → 通過；base 沒有釘選表 → 不檢查", () => {
  assert.deepEqual(checkAppendOnly(clone(BUDGETS), clone(BUDGETS)), []);
  assert.deepEqual(checkAppendOnly(null, clone(BUDGETS)), []);
});

test("只能追加：改數字並把最後一筆的 bytes 一起改、沿用舊理由 → 擋下", () => {
  const base = budget(100);
  const cur = clone(base);
  cur.X.maxRuntimeBytes = 120;
  cur.X.history[0].bytes = 120; // 繞過 checkBudgetTable 的「最後一筆 == 預算」
  assert.deepEqual(checkBudgetTable(cur), [], "單看釘選表抓不到——所以需要 base 比對");
  const p = checkAppendOnly(base, cur);
  assert.ok(p.some((x) => x.includes("history[0] 被修改或刪除")));
  assert.ok(p.some((x) => /卻沒有在 history 追加新紀錄/.test(x)));
});

test("只能追加：追加新紀錄但理由照抄 → 擋下；寫新理由 → 通過", () => {
  const base = budget(100);
  const copy = clone(base);
  copy.X.maxRuntimeBytes = 120;
  copy.X.history.push({ ...base.X.history[0], bytes: 120, date: "2026-10-05" });
  assert.ok(checkAppendOnly(base, copy).some((x) => /沿用了既有的理由/.test(x)));
  const ok = clone(base);
  ok.X.maxRuntimeBytes = 120;
  ok.X.history.push({ bytes: 120, date: "2026-10-05", reason: "安全修正 X 需要多 20 B，已無其他可省空間" });
  assert.deepEqual(checkAppendOnly(base, ok), []);
  assert.deepEqual(checkBudgetTable(ok), []);
});

test("只能追加：整筆刪除預算 → 擋下", () => {
  assert.ok(checkAppendOnly(budget(100), {}).some((x) => /整筆刪除/.test(x)));
});

test("釘選表在 JSON；--base 讀 git 的 base 版本（讀不到時回 null）", () => {
  assert.equal(loadBudgets(JSON.stringify({ budgets: { A: 1 } })).A, 1);
  assert.throws(() => loadBudgets("{}"), /沒有 budgets/);
  assert.equal(loadBaseBudgets("no-such-ref-xyz", () => { throw new Error("bad ref"); }), null);
  const fake = () => JSON.stringify({ budgets: budget(100) });
  assert.equal(loadBaseBudgets("HEAD", fake).X.maxRuntimeBytes, 100);
});
