// verify-dedicated-tenants.mjs 的測試（不連網、不跑 forge：兩者都以注入的函式代替）。
//   node --test scripts/verify-dedicated-tenants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_RPC, plan, verifyAll } from "./verify-dedicated-tenants.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const fakeRoot = ({ kind = "dedicated", status = "deployed", record = true, chainId = 84532 } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-tenants-"));
  mkdirSync(join(dir, "frontend/src/contracts/deployments"), { recursive: true });
  mkdirSync(join(dir, "deploy/tenants"), { recursive: true });
  writeFileSync(join(dir, "frontend/src/contracts/deployments/bank-a.json"), JSON.stringify({ schemaVersion: 1, tenant: "bank-a", kind }));
  writeFileSync(join(dir, "frontend/src/contracts/deployments/default.json"), JSON.stringify({ schemaVersion: 1, tenant: "default", kind: "platform" }));
  writeFileSync(join(dir, "deploy/tenants/bank-a.json"), JSON.stringify({ tenantId: "bank-a", status, network: { chainId } }));
  if (record) writeFileSync(join(dir, "deploy/tenants/bank-a.deployed.json"), "{}");
  return dir;
};
const quiet = () => {};

test("repo 現況：沒有專屬租戶 → 通過並印出數量 0", async () => {
  const lines = [];
  const problems = await verifyAll({
    root,
    log: (m) => lines.push(m),
    runVerify: () => assert.fail("沒有租戶時不應該跑 forge"),
    chainIdOf: () => assert.fail("沒有租戶時不應該連 RPC"),
  });
  assert.deepEqual(problems, []);
  assert.match(lines.join("\n"), /專屬租戶 0 個——沒有要驗證的鏈上部署/);
  assert.match(lines.join("\n"), /專屬租戶鏈上驗證通過 ✓（0 個）/);
});

test("每個 dedicated 租戶都以公開 RPC 跑一次 VerifyTenant；平台租戶不跑", async () => {
  const dir = fakeRoot();
  assert.deepEqual(plan(dir), [{ id: "bank-a", chainId: 84532, rpc: PUBLIC_RPC[84532] }]);
  const ran = [];
  const problems = await verifyAll({ root: dir, log: quiet, runVerify: (t) => (ran.push(t.id), 0), chainIdOf: async () => 84532 });
  assert.deepEqual(problems, []);
  assert.deepEqual(ran, ["bank-a"]);
  assert.deepEqual(plan(fakeRoot({ kind: "platform" })), []);
  rmSync(dir, { recursive: true, force: true });
});

test("VerifyTenant 失敗、RPC 連不上、RPC 是別條鏈 → 失敗（不是略過）", async () => {
  const dir = fakeRoot();
  const fail = await verifyAll({ root: dir, log: quiet, runVerify: () => 1, chainIdOf: async () => 84532 });
  assert.match(fail.join("\n"), /bank-a：VerifyTenant 失敗（exit 1）/);
  const down = await verifyAll({
    root: dir,
    log: quiet,
    runVerify: () => assert.fail("RPC 不通時不應該跑 forge"),
    chainIdOf: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.match(down.join("\n"), /bank-a：公開 RPC .* 連不上（ECONNREFUSED）——沒有驗證到的租戶不算通過/);
  const wrong = await verifyAll({ root: dir, log: quiet, runVerify: () => 0, chainIdOf: async () => 8453 });
  assert.match(wrong.join("\n"), /回報 chainId 8453，設定是 84532/);
});

test("前端是 dedicated 但部署設定或紀錄不完整 → 丟錯", () => {
  assert.throws(() => plan(fakeRoot({ record: false })), /缺少 bank-a\.json 或 bank-a\.deployed\.json/);
  assert.throws(() => plan(fakeRoot({ status: "ready" })), /status 是 ready，不是 deployed/);
  assert.throws(() => plan(fakeRoot({ chainId: 1 })), /chain 1 沒有設定公開 RPC/);
});
