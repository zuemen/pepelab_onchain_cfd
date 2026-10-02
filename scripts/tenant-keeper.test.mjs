// 租戶 keeper workflow（範本＋產生器＋守門檢查的「租戶 keeper」類別＋位址讀取腳本）的測試。
//   npm ci --ignore-scripts --prefix scripts      # 第一次：安裝固定版本的 yaml
//   node --test scripts/tenant-keeper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TENANT_KEEPER_PINS,
  TENANT_KEEPER_SECRETS,
  checkTenantKeeperTemplate,
  checkWorkflows,
  expressionsIn,
  fileDigest,
  loadYaml,
  readWorkflowDir,
  secretRefsIn,
} from "./check-workflow-guards.mjs";
import { checkWorkflow, parseFrontendConfig, DEDICATED_REQUIRED_KEYS } from "./check-addresses.mjs";
import {
  LOADER_FILE,
  TEMPLATE_FILE,
  TENANT_KEEPER_ID,
  listDedicatedTenantIds,
  loadTenantKeeperContext,
  renderTenantKeeper,
  tenantIdOfKeeperFile,
} from "./lib/tenant-keeper.mjs";
import { generate } from "./gen-tenant-keeper.mjs";
import { tenantKeeperEnv } from "../ops/tenant-keeper/load-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const YAML = await loadYaml();
const REAL = readWorkflowDir(join(root, ".github/workflows"));
const repoTk = loadTenantKeeperContext(root);
/** bank-a 是已登記的專屬租戶的情境。 */
const tk = (tenants = ["bank-a"]) => ({ ...repoTk, tenants });
const gen = (id = "bank-a") => ({ name: `keeper-${id}.yml`, text: renderTenantKeeper(repoTk.templateText, id) });
const guards = (extra, tenants) => checkWorkflows([...REAL, ...extra], YAML, { tenantKeeper: tk(tenants) }).problems;
const some = (problems, re) =>
  assert.ok(problems.some((p) => re.test(p)), `預期有 ${re}，實際：\n${problems.join("\n") || "（沒有任何問題）"}`);
const MISMATCH = (id) => new RegExp(`^keeper-${id}\\.yml：租戶 keeper workflow 的內容必須等於範本`);
/** 對產生出來的檔案做一個替換；替換目標必須存在。 */
const edit = (file, from, to) => {
  assert.ok(file.text.includes(from), `找不到替換目標：${from}`);
  return { ...file, text: file.text.replace(from, to) };
};

test("範本與讀位址的腳本：雜湊等於釘選值；代入探測 id 後通過所有結構規則", () => {
  assert.equal(fileDigest(repoTk.templateText), TENANT_KEEPER_PINS[TEMPLATE_FILE]);
  assert.equal(fileDigest(repoTk.loaderText), TENANT_KEEPER_PINS[LOADER_FILE]);
  assert.deepEqual(checkTenantKeeperTemplate(YAML, repoTk), []);
  const r = spawnSync(process.execPath, [join(here, "check-workflow-guards.mjs"), "--print-tenant-keeper-pins"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const h of Object.values(TENANT_KEEPER_PINS)) assert.ok(r.stdout.includes(JSON.stringify(h)), r.stdout);
});

test("範本只用租戶自己的 secret（不會退回平台的 KEEPER_PRIVATE_KEY）", () => {
  const refs = secretRefsIn(expressionsIn(YAML.parse(gen().text)));
  assert.equal(refs.dynamic, false);
  assert.deepEqual([...refs.names].sort(), [...TENANT_KEEPER_SECRETS].sort());
  assert.doesNotMatch(repoTk.templateText, /secrets\.KEEPER_PRIVATE_KEY|secrets\.BASE_SEPOLIA_RPC_URL/);
  // 範本裡沒有任何位址：位址只來自部署登記。
  assert.doesNotMatch(repoTk.templateText, /0x[0-9a-fA-F]{40}/);
});

test("產生的 workflow：已登記的專屬租戶 → 通過；範本改了而釘選沒更新 → 擋", () => {
  assert.deepEqual(guards([gen()]), []);
  const changed = { ...repoTk, templateText: `${repoTk.templateText}# x\n` };
  const p = checkWorkflows([...REAL], YAML, { tenantKeeper: { ...changed, tenants: [] } }).problems;
  some(p, /^ops\/tenant-keeper\/keeper\.template\.yml：租戶 keeper 的範本與釘選值不符/);
  const loader = { ...repoTk, loaderText: `${repoTk.loaderText}// x\n` };
  some(checkTenantKeeperTemplate(YAML, loader), /^ops\/tenant-keeper\/load-env\.mjs：租戶 keeper 的位址讀取腳本與釘選值不符/);
});

test("反例：多一個觸發事件", () => {
  const f = edit(gen(), "  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n");
  const p = guards([f]);
  some(p, MISMATCH("bank-a"));
  some(p, /keeper-bank-a\.yml：綁了 environment「keeper-bank-a」的 workflow 只能用 schedule、workflow_dispatch 觸發（多了 `push`）/);
});

test("反例：改一行 step（例如跳過金鑰核對）", () => {
  const f = edit(gen(), '          ADDR=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY")\n', "          exit 0\n");
  const p = guards([f]);
  assert.deepEqual(p.filter((x) => !MISMATCH("bank-a").test(x)), [], "結構上合法的改動只剩內容不符一項");
  some(p, MISMATCH("bank-a"));
  // CRLF 與 BOM 不算改動。
  assert.deepEqual(guards([{ ...gen(), text: `﻿${gen().text.replace(/\n/g, "\r\n")}` }]), []);
});

test("反例：environment 名稱與檔名不符", () => {
  const f = edit(gen("bank-a"), "      name: keeper-bank-a\n", "      name: keeper-bank-b\n");
  const p = guards([f], ["bank-a", "bank-b"]);
  some(p, MISMATCH("bank-a"));
  some(p, /keeper-bank-a\.yml#keep：environment「keeper-bank-b」只允許 keeper-bank-b\.yml#keep 綁定/);
  some(p, /keeper-bank-a\.yml#keep：引用 secrets\.TENANT_KEEPER_PRIVATE_KEY 但綁的是 environment「keeper-bank-b」（應綁「keeper-bank-a」）/);
  // 別的檔案綁租戶的 environment。
  const other = { name: "sneaky.yml", text: gen("bank-a").text };
  const q = guards([other]);
  some(q, /sneaky\.yml#keep：environment「keeper-bank-a」只允許 keeper-bank-a\.yml#keep 綁定/);
  some(q, /sneaky\.yml#keep：引用 secrets\.TENANT_KEEPER_PRIVATE_KEY（租戶 keeper 的 secret），但這支不是租戶 keeper workflow/);
  some(q, /sneaky\.yml：這是持有私鑰的 workflow.*但不在 PINNED_WORKFLOWS 裡/);
});

test("反例：id 未登記（沒有部署登記，或登記是 kind=platform）", () => {
  const p = guards([gen("bank-x")], ["bank-a"]);
  some(p, /keeper-bank-x\.yml#keep：綁了 environment「keeper-bank-x」，但「bank-x」不是已登記的專屬租戶/);
  some(p, /keeper-bank-x\.yml：租戶 keeper workflow，但「bank-x」不是已登記的專屬租戶/);
  // repo 現況：demo-bank 是 kind=platform，沒有任何專屬租戶。
  assert.deepEqual(listDedicatedTenantIds(root), []);
  some(checkWorkflows([...REAL, gen("demo-bank")], YAML).problems, /「demo-bank」不是已登記的專屬租戶/);
});

test("反例：借用平台的 keeper environment 與金鑰", () => {
  let f = edit(gen(), "      name: keeper-bank-a\n", "      name: keeper\n");
  f = edit(f, "${{ secrets.TENANT_KEEPER_PRIVATE_KEY }}", "${{ secrets.KEEPER_PRIVATE_KEY }}");
  const p = guards([f]);
  some(p, MISMATCH("bank-a"));
  some(p, /keeper-bank-a\.yml#keep：不在 environment「keeper」的允許清單內/);
  // 只換 environment、保留租戶 secret：secret 綁錯 environment。
  const g = edit(gen(), "      name: keeper-bank-a\n", "      name: keeper\n");
  some(guards([g]), /keeper-bank-a\.yml#keep：引用 secrets\.TENANT_RPC_URL 但綁的是 environment「keeper」（應綁「keeper-bank-a」）/);
});

test("租戶 secret 出現在平台 workflow → 擋", () => {
  const f = REAL.find((x) => x.name === "base-sepolia-keeper.yml");
  const t = { name: f.name, text: f.text.replace("${{ secrets.KEEPER_PRIVATE_KEY }}", "${{ secrets.TENANT_KEEPER_PRIVATE_KEY }}") };
  assert.notEqual(t.text, f.text);
  some(checkWorkflows(REAL.map((x) => (x.name === f.name ? t : x)), YAML, { tenantKeeper: tk() }).problems,
    /base-sepolia-keeper\.yml#keep：引用 secrets\.TENANT_KEEPER_PRIVATE_KEY（租戶 keeper 的 secret），但這支不是租戶 keeper workflow/);
});

test("id 格式嚴格：代入 YAML 不可能改變結構", () => {
  for (const ok of ["bank-a", "ab", "b2b-asia-1"]) assert.ok(TENANT_KEEPER_ID.test(ok), ok);
  for (const bad of ["a", "Bank-a", "1bank", "-bank", "bank a", "bank:a", "bank\na", "${{x}}", "bank'a", "x".repeat(32), "bank_a"]) {
    assert.throws(() => renderTenantKeeper(repoTk.templateText, bad), /格式不合/, JSON.stringify(bad));
    assert.equal(tenantIdOfKeeperFile(`keeper-${bad}.yml`), null, JSON.stringify(bad));
  }
  assert.equal(tenantIdOfKeeperFile("keeper-bank-a.yml"), "bank-a");
  assert.equal(tenantIdOfKeeperFile("keeper-bank-a.yaml"), null, "只認 .yml");
});

test("產生器：只為已登記的專屬租戶產生，輸出與檢查器重新產生的相同（LF）", () => {
  assert.throws(() => generate(root, "demo-bank"), /不是已登記的專屬租戶/);
  assert.throws(() => generate(root, "Bad Id"), /格式不合/);
  const { file, text } = generate(root, "bank-a", { requireRegistered: false });
  assert.ok(file.replace(/\\/g, "/").endsWith(".github/workflows/keeper-bank-a.yml"));
  assert.doesNotMatch(text, /\r/);
  assert.equal(fileDigest(text), fileDigest(gen().text));
  assert.doesNotMatch(text, /__TENANT_ID__/);
  const cli = spawnSync(process.execPath, [join(here, "gen-tenant-keeper.mjs"), "demo-bank", "--stdout"], { encoding: "utf8" });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /不是已登記的專屬租戶/);
});

// ── 與 check-addresses.mjs 一起：同一份租戶 workflow 兩支檢查都要過 ───────────

const chains = parseFrontendConfig(
  readFileSync(join(root, "frontend/src/contracts/addresses.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/sessionManager.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/x402.ts"), "utf8"),
);
const T = (n) => `0x${n.toString(16).padStart(40, "d")}`;
const bankA = {
  schemaVersion: 1,
  tenant: "bank-a",
  kind: "dedicated",
  chainId: 84532,
  oracleKind: "guarded",
  contracts: {
    ...Object.fromEntries(DEDICATED_REQUIRED_KEYS.map((k, i) => [k, T(i + 1)])),
    SettlementToken: chains["84532"].roles.MockUSDC,
    AssetVaultV2: T(30),
  },
  shared: ["contracts.SettlementToken"],
  tokens: { sAAPL: T(40) },
};

test("check-addresses 與 check-workflow-guards 對同一份產生出來的租戶 workflow 同時通過", () => {
  const f = gen("bank-a");
  const deployments = { default: { schemaVersion: 1, tenant: "default", kind: "platform" }, "bank-a": bankA };
  assert.deepEqual(checkWorkflow({ file: f.name, text: f.text, chains, allowlist: [], deployments }).problems, []);
  assert.deepEqual(guards([f]), []);
  // 反過來證明兩支都真的在看這份檔案：環境改成平台的 keeper，兩支都紅。
  const bad = edit(f, "      name: keeper-bank-a\n", "      name: keeper\n");
  assert.match(
    checkWorkflow({ file: bad.name, text: bad.text, chains, allowlist: [], deployments }).problems.join("\n"),
    /environment 必須是 keeper-bank-a/,
  );
  assert.ok(guards([bad]).length > 0);
});

// ── ops/tenant-keeper/load-env.mjs ─────────────────────────────────────────

const tenantRoot = ({ reg = bankA, cfg } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-keeper-"));
  mkdirSync(join(dir, "frontend/src/contracts/deployments"), { recursive: true });
  mkdirSync(join(dir, "deploy/tenants"), { recursive: true });
  writeFileSync(join(dir, "frontend/src/contracts/deployments/bank-a.json"), JSON.stringify(reg));
  const c = cfg ?? {
    tenantId: "bank-a",
    status: "deployed",
    network: { chainId: 84532 },
    roles: { keeper: T(77) },
    shared: { referenceSource: chains["84532"].roles.AggregatorOracle },
    params: { oracleKind: "guarded", oracleMaxDeviationBps: 1000 },
    assets: { registered: ["sAAPL", "sGOLD"] },
  };
  writeFileSync(join(dir, "deploy/tenants/bank-a.json"), JSON.stringify(c));
  return { dir, cfg: c };
};

test("load-env：只從登記檔讀出這個租戶的位址與參數", () => {
  const { dir } = tenantRoot();
  const env = Object.fromEntries(tenantKeeperEnv(dir, "bank-a"));
  assert.deepEqual(env, {
    KEEPER_ORACLE_ADDRESS: bankA.contracts.Oracle,
    EXCHANGE: bankA.contracts.PerpetualExchange,
    KEEPER_EXPECTED_ADDRESS: T(77),
    KEEPER_VAULT_ADDRESS: bankA.contracts.AssetVaultV2,
    KEEPER_RELAY_SOURCE: chains["84532"].roles.AggregatorOracle,
    KEEPER_BREAKER_DEVIATION: "0.1",
    FUNDING_SYMBOLS: "sAAPL sGOLD",
  });
  assert.equal(env.KEEPER_GUARDED_ORACLE, undefined, "guarded 租戶只有一顆 oracle");
  const cli = spawnSync(process.execPath, [join(root, "ops/tenant-keeper/load-env.mjs"), "bank-a", "--root", dir], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^KEEPER_ORACLE_ADDRESS=0x/m);
});

test("load-env：kind=platform、未部署、id 不合、值格式不對都失敗（不印任何東西）", () => {
  const platform = tenantRoot({ reg: { schemaVersion: 1, tenant: "bank-a", kind: "platform", note: "x" } });
  assert.throws(() => tenantKeeperEnv(platform.dir, "bank-a"), /不是這個租戶的 dedicated 登記/);
  const notDeployed = tenantRoot();
  writeFileSync(join(notDeployed.dir, "deploy/tenants/bank-a.json"), JSON.stringify({ ...notDeployed.cfg, status: "ready" }));
  assert.throws(() => tenantKeeperEnv(notDeployed.dir, "bank-a"), /不是已部署/);
  assert.throws(() => tenantKeeperEnv(tenantRoot().dir, "../bank-a"), /格式不合/);
  const injected = tenantRoot();
  writeFileSync(
    join(injected.dir, "deploy/tenants/bank-a.json"),
    JSON.stringify({ ...injected.cfg, assets: { registered: ["sAAPL\nNODE_OPTIONS=--require=x"] } }),
  );
  assert.throws(() => tenantKeeperEnv(injected.dir, "bank-a"), /assets\.registered 不是資產代號清單/);
  const cli = spawnSync(process.execPath, [join(root, "ops/tenant-keeper/load-env.mjs"), "bank-a", "--root", platform.dir], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
});
