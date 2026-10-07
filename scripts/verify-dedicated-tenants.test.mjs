// verify-dedicated-tenants.mjs 的測試（不連網、不跑 forge：兩者都以注入的函式代替）。
//   node --test scripts/verify-dedicated-tenants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_RPC, plan, verifyAll } from "./verify-dedicated-tenants.mjs";
import { listDedicatedTenantIds } from "./lib/tenant-keeper.mjs";

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

test("repo 現況：每個 dedicated 登記都有部署設定與紀錄、而且有公開 RPC（不連網）", () => {
  const targets = plan(root);
  for (const t of targets) assert.ok(t.rpcs.length > 0 && t.rpcs.every((r) => r.url.startsWith("https://") && r.logChunk > 0), `${t.id} 公開 RPC 設定不對`);
  assert.deepEqual(
    targets.map((t) => t.id),
    listDedicatedTenantIds(root),
  );
});

test("每個 dedicated 租戶都以公開 RPC 跑一次 VerifyTenant；平台租戶不跑", async () => {
  const dir = fakeRoot();
  assert.deepEqual(plan(dir), [{ id: "bank-a", chainId: 84532, rpcs: PUBLIC_RPC[84532] }]);
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
  assert.match(down.join("\n"), /bank-a：沒有可用的公開 RPC（.*連不上（ECONNREFUSED）.*）——沒有驗證到的租戶不算通過/);
  const wrong = await verifyAll({ root: dir, log: quiet, runVerify: () => 0, chainIdOf: async () => 8453 });
  assert.match(wrong.join("\n"), /回報 chainId 8453，設定是 84532/);
});

test("第一個公開 RPC 拒絕（例如 runner 被擋）→ 改用下一個", async () => {
  const dir = fakeRoot();
  const used = [];
  const problems = await verifyAll({
    root: dir,
    log: quiet,
    runVerify: (t) => (used.push(t.rpc), 0),
    chainIdOf: async (rpc) => {
      if (rpc === PUBLIC_RPC[84532][0].url) throw new Error("HTTP 401");
      return 84532;
    },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(used, [PUBLIC_RPC[84532][1].url]);
  rmSync(dir, { recursive: true, force: true });
});

test("forge 途中被節點拒絕（401、getLogs 被拒）→ 換下一個；真的驗證失敗 → 不重試", async () => {
  const dir = fakeRoot();
  const used = [];
  const ok = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    runVerify: (t) => {
      used.push(t.rpc);
      return used.length === 1 ? { status: 1, output: "HTTP error 401 with body: rejected" } : { status: 0, output: "" };
    },
  });
  assert.deepEqual(ok, []);
  assert.deepEqual(used, PUBLIC_RPC[84532].slice(0, 2).map((r) => r.url));
  const tries = [];
  const bad = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    runVerify: (t) => (tries.push(t.rpc), { status: 1, output: "verify tenant failed: owner mismatch" }),
  });
  assert.match(bad.join("\n"), /bank-a：VerifyTenant 失敗（exit 1）/);
  assert.equal(tries.length, 1);
  const allDown = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    runVerify: () => ({ status: 1, output: "eth_getLogs refused" }),
  });
  assert.match(allDown.join("\n"), /沒有可用的公開 RPC/);
  rmSync(dir, { recursive: true, force: true });
});

test("前端是 dedicated 但部署設定或紀錄不完整 → 丟錯", () => {
  assert.throws(() => plan(fakeRoot({ record: false })), /缺少 bank-a\.json 或 bank-a\.deployed\.json/);
  assert.throws(() => plan(fakeRoot({ status: "ready" })), /status 是 ready，不是 deployed/);
  assert.throws(() => plan(fakeRoot({ chainId: 1 })), /chain 1 沒有設定公開 RPC/);
});
