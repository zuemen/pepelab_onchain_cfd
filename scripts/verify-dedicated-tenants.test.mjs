// verify-dedicated-tenants.mjs 的測試（不連網、不跑 forge：兩者都以注入的函式代替）。
//   node --test scripts/verify-dedicated-tenants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_RPC, deploySource, plan, prepareArtifacts, verifyAll } from "./verify-dedicated-tenants.mjs";
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
      return used.length === 1 ? { status: 1, stderr: "Error: HTTP error 401 with body: rejected" } : { status: 0, stderr: "" };
    },
  });
  assert.deepEqual(ok, []);
  assert.deepEqual(used, PUBLIC_RPC[84532].slice(0, 2).map((r) => r.url));
  const tries = [];
  const bad = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
      // 回歸：stdout 的 Logs 會含「oracle rate limit is on」之類的檢查名稱；只看 stderr，真的失敗不能被當成節點問題。
    runVerify: (t) => (
      tries.push(t.rpc),
      {
        status: 1,
        stdout: "  ok   oracle rate limit is on (window != 0)\n  NOTE no step cap, no rate limit",
        stderr: "Error: script failed: verify tenant failed: owner mismatch",
      }
    ),
  });
  assert.match(bad.join("\n"), /bank-a：VerifyTenant 失敗（exit 1）/);
  assert.equal(tries.length, 1);
  const allDown = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    runVerify: () => ({ status: 1, stderr: "Error: script failed: verify tenant failed: eth_getLogs refused (RPC block-range or rate limit?)" }),
  });
  assert.match(allDown.join("\n"), /沒有可用的公開 RPC/);
  rmSync(dir, { recursive: true, force: true });
});

test("前端是 dedicated 但部署設定或紀錄不完整 → 丟錯", () => {
  assert.throws(() => plan(fakeRoot({ record: false })), /缺少 bank-a\.json 或 bank-a\.deployed\.json/);
  assert.throws(() => plan(fakeRoot({ status: "ready" })), /status 是 ready，不是 deployed/);
  assert.throws(() => plan(fakeRoot({ chainId: 1 })), /chain 1 沒有設定公開 RPC/);
});

// ── 比對哪一份 build：部署當時的 commit ─────────────────────────────────────────

const EX = "0x00000000000000000000000000000000000000e1";
const TOK = "0x00000000000000000000000000000000000000a1";
const writeRun = (dir, name, { commit, created }) => {
  const runDir = join(dir, "contracts/broadcast/tenants/bank-a/DeployTenant.s.sol/84532");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, name),
    JSON.stringify({
      commit,
      transactions: [
        { transactionType: "CREATE", contractAddress: created[0], additionalContracts: created.slice(1).map((address) => ({ address })) },
        { transactionType: "CALL", contractAddress: "0x00000000000000000000000000000000000000ff" },
      ],
    }),
  );
};
const writeRecord = (dir) =>
  writeFileSync(join(dir, "deploy/tenants/bank-a.deployed.json"), JSON.stringify({ contracts: { PerpetualExchange: EX }, tokens: { sAAPL: TOK } }));

test("部署的 commit：取自建立了部署紀錄全部位址（含合約內部 CREATE）的 DeployTenant run", () => {
  const dir = fakeRoot();
  writeRecord(dir);
  assert.deepEqual(deploySource(dir, "bank-a", 84532).commit, null, "沒有 broadcast → 照舊比對目前的 build");
  writeRun(dir, "run-1.json", { commit: "1111111", created: [EX] }); // 只建了一部分：不是這次
  assert.equal(deploySource(dir, "bank-a", 84532).commit, null);
  writeRun(dir, "run-2.json", { commit: "abcdef0", created: [EX.toUpperCase().replace("0X", "0x"), TOK] });
  writeRun(dir, "run-latest.json", { commit: "9999999", created: [EX, TOK] }); // run-latest 是副本，不另外算
  assert.equal(deploySource(dir, "bank-a", 84532).commit, "abcdef0");
  writeRun(dir, "run-3.json", { commit: "2222222", created: [EX, TOK] });
  assert.throws(() => deploySource(dir, "bank-a", 84532), /記了不同的 commit（abcdef0、2222222）/);
  rmSync(dir, { recursive: true, force: true });
});

test("原始碼在部署後改過 → 編出部署當時的 commit；沒改 → 目前的 build；commit 不在歷史裡 → 失敗", () => {
  const dir = fakeRoot();
  const g = (...a) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(dir, "contracts/src"), { recursive: true });
  writeFileSync(join(dir, "contracts/src/A.sol"), "// v1\n");
  g("add", "-A");
  g("commit", "-qm", "deployed source");
  const deployed = g("rev-parse", "HEAD");
  writeRecord(dir);
  writeRun(dir, "run-1.json", { commit: deployed.slice(0, 7), created: [EX, TOK] });
  g("add", "-A");
  g("commit", "-qm", "record + broadcast");

  const t = { id: "bank-a", chainId: 84532 };
  const built = [];
  const build = (_root, id, sha) => (built.push(sha), `out-deployed/${id}/`);
  assert.equal(prepareArtifacts(dir, t, quiet, build), null, "只加了紀錄：原始碼沒變");
  assert.deepEqual(built, []);

  writeFileSync(join(dir, "contracts/src/A.sol"), "// v2\n");
  g("commit", "-qam", "later fix");
  assert.equal(prepareArtifacts(dir, t, quiet, build), "out-deployed/bank-a/");
  assert.deepEqual(built, [deployed], "編的是部署當時的完整 sha");

  writeRun(dir, "run-1.json", { commit: "deadbee", created: [EX, TOK] });
  assert.throws(() => prepareArtifacts(dir, t, quiet, build), /部署的 commit deadbee 解析不到/);
  rmSync(dir, { recursive: true, force: true });
});

test("比對用的 build 傳給 VerifyTenant；準備失敗 → 該租戶失敗、不跑 forge", async () => {
  const dir = fakeRoot();
  const seen = [];
  const ok = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    artifactsFor: () => "out-deployed/bank-a/",
    runVerify: (t) => (seen.push(t.artifactsDir), 0),
  });
  assert.deepEqual(ok, []);
  assert.deepEqual(seen, ["out-deployed/bank-a/"]);
  const bad = await verifyAll({
    root: dir,
    log: quiet,
    chainIdOf: async () => 84532,
    artifactsFor: () => {
      throw new Error("部署的 commit abc 不在 HEAD 的歷史裡");
    },
    runVerify: () => assert.fail("沒有比對用的 build 時不應該跑 forge"),
  });
  assert.deepEqual(bad, ["bank-a：部署的 commit abc 不在 HEAD 的歷史裡"]);
  rmSync(dir, { recursive: true, force: true });
});
