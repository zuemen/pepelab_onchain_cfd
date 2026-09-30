// check-tenant-deploy.mjs 的自我測試：repo 內的設定必須通過、每一種錯誤都必須被抓到。
//   node --test scripts/check-tenant-deploy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCrossTenant, checkTenantDeploy, envPlan, loadContext } from "./check-tenant-deploy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-tenant-deploy.mjs");
const ctx = loadContext(root);
const demo = JSON.parse(readFileSync(join(root, "deploy/tenants/demo-bank.json"), "utf8"));

// 一組看起來合法、且不在 addresses.ts 裡的測試位址。
const A = (n) => `0x${n.toString(16).padStart(40, "a")}`;
const filled = () => {
  const c = structuredClone(demo);
  c.status = "ready";
  c.roles = { admin: A(1), risk: A(2), guardian: A(3), keeper: A(4), marketOperator: A(5), treasury: A(6) };
  c.shared = { settlementToken: A(7), priceSource: A(8) };
  return c;
};
const check = (cfg, file = "demo-bank.json") => checkTenantDeploy({ file, cfg, ctx }).problems.join("\n");

test("repo 內的租戶部署設定全部通過", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /檢查通過 ✓/);
});

test("填好位址的 ready 設定通過", () => {
  assert.equal(check(filled()), "");
});

test("ready 以上不允許佔位值", () => {
  const c = filled();
  c.roles.keeper = "<DEMO_BANK_KEEPER_ADDRESS>";
  assert.match(check(c), /roles\.keeper 仍是佔位值/);
});

test("私鑰形狀的字串出現在任何地方都擋", () => {
  const c = filled();
  c.secretsEnv.deployerPrivateKey = "ab".repeat(32);
  assert.match(check(c), /看起來是私鑰/);
  const d = filled();
  d.keeper.note = `0x${"12".repeat(32)}`;
  assert.match(check(d), /keeper\.note 看起來是私鑰/);
});

test("網址（可能帶 RPC 金鑰）不得寫進設定檔", () => {
  const c = filled();
  c.secretsEnv.rpcUrl = "https://base-sepolia.example/v3/abc";
  const out = check(c);
  assert.match(out, /secretsEnv\.rpcUrl 是網址/);
  assert.match(out, /secretsEnv\.rpcUrl 必須是環境變數名稱/);
});

test("秘密欄位不得出現在 secretsEnv 以外", () => {
  const c = filled();
  c.keeper.mnemonic = "KEEPER_MNEMONIC";
  assert.match(check(c), /keeper\.mnemonic：看起來是秘密的欄位只能放在 secretsEnv 底下/);
});

test("部署者與 keeper 不得共用同一把金鑰", () => {
  const c = filled();
  c.secretsEnv.keeperPrivateKey = c.secretsEnv.deployerPrivateKey;
  assert.match(check(c), /部署者與 keeper 必須是不同的金鑰/);
});

test("角色分離：admin/keeper/guardian/risk 兩兩不同、keeper 不能收款", () => {
  const c = filled();
  c.roles.keeper = c.roles.admin;
  assert.match(check(c), /roles\.admin 與 roles\.keeper 是同一個地址/);
  const d = filled();
  d.roles.treasury = d.roles.keeper;
  assert.match(check(d), /roles\.keeper 與 roles\.treasury 是同一個地址/);
});

test("租戶專屬角色不得使用正式站（addresses.ts）的位址", () => {
  const prod = [...ctx.productionAddrs][0];
  const c = filled();
  c.roles.guardian = prod;
  assert.match(check(c), /roles\.guardian=.* 是現行正式站/);
});

test("共用元件（結算幣、價格來源）可以是正式站的位址", () => {
  const prod = [...ctx.productionAddrs][0];
  const c = filled();
  c.shared.priceSource = prod;
  assert.equal(check(c), "");
});

test("兩個租戶不得共用任何專屬位址", () => {
  const a = checkTenantDeploy({ file: "a.json", cfg: filled(), ctx });
  const b = checkTenantDeploy({ file: "b.json", cfg: filled(), ctx });
  const out = checkCrossTenant([
    { file: "a.json", ...a },
    { file: "b.json", ...b },
  ]).join("\n");
  assert.match(out, /b\.json: roles\.admin=.* 與 a\.json 的 roles\.admin 相同/);
});

test("前端白名單開了金庫沒註冊的資產要擋", () => {
  const c = filled();
  c.assets.registered = ["sAAPL"];
  assert.match(check(c), /白名單開了金庫沒註冊的資產：sMSFT/);
});

test("未知資產、未知欄位、錯的 tenantId 都擋", () => {
  const c = filled();
  c.assets.registered.push("sDOGE");
  c.roles.owner = A(9);
  c.tenantId = "other-bank";
  const out = check(c);
  assert.match(out, /sDOGE 不是 addresses\.ts 已知資產/);
  assert.match(out, /roles 未知欄位 owner/);
  assert.match(out, /tenantId「other-bank」與檔名「demo-bank」不一致/);
});

test("費率未決時數字必須是 null，且不能標成 deployed", () => {
  const c = filled();
  c.fees.baseFeeBps = 10;
  assert.match(check(c), /pending-decision 時 baseFeeBps \/ tenantMarkupBps 必須是 null/);
  const d = filled();
  d.status = "deployed";
  assert.match(check(d), /fees 仍是 pending-decision，不能標成 deployed/);
});

test("deployed 狀態要求所有合約位址都已填", () => {
  const c = filled();
  c.status = "deployed";
  c.fees = { status: "decided", baseFeeBps: 10, tenantMarkupBps: 5 };
  assert.match(check(c), /deployed\.GuardedOracle 未填/);
});

test("default 不能拿來當新租戶部署", () => {
  const c = filled();
  c.tenantId = "default";
  c.frontendTenant = "default";
  assert.match(check(c, "default.json"), /default 是現行正式站/);
});

test("錯誤的設定檔讓 CLI 以非零結束", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-deploy-"));
  const file = join(dir, "demo-bank.json");
  const c = filled();
  c.roles.keeper = c.roles.admin;
  writeFileSync(file, JSON.stringify(c));
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::error::/);
});

test("--print-env 只印位址類變數，不含任何秘密值", () => {
  const plan = envPlan(filled());
  assert.match(plan, /ADMIN_ADDRESS=0x/);
  assert.match(plan, /HANDOVER_DRY_RUN=true/);
  assert.doesNotMatch(plan, /PRIVATE_KEY=/);
});
