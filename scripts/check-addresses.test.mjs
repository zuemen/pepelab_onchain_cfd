// check-addresses.mjs 的自我測試：repo 本身必須通過、錯誤 fixture 必須失敗。
//   node --test scripts/check-addresses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflow, parseFrontendConfig, scanWorkflow } from "./check-addresses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-addresses.mjs");
const fixtures = join(here, "fixtures/check-addresses/bad");
const chains = parseFrontendConfig(
  readFileSync(join(root, "frontend/src/contracts/addresses.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/sessionManager.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/x402.ts"), "utf8"),
);

test("現行 repo 的 workflow 全部通過", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /一致 ✓/);
});

test("含錯誤位址的 fixture 必須以非零結束並列出每一個錯", () => {
  const r = spawnSync(process.execPath, [script, "--workflows", fixtures], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout;
  assert.match(out, /EXCHANGE=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 —— chain 84532 的 PerpetualExchange 應為 0x827eA0c6/);
  assert.match(out, /inputs\.target\.default=0xEf75/);
  assert.match(out, /KEEPER_ORACLE_ADDRESS=0x17CA20A3.*MockOracle 應為 0xeD90c4F3/);
  assert.match(out, /0x4E7cC1B79B72ab72531a6C790e14304370f70764（jobs\.keep\.steps\.run） —— 寫死在非 env 位置/);
  assert.match(out, /KEEPER_VAULT_ADDRESS=0x0{40} —— 零位址/);
  // 審查 Medium 4 的三種盲點：
  assert.match(out, /0x0c6459d38617E60017bDc4ed69ec26137DA5c32b（jobs\.keep\.steps\.run） —— .*chain 84532/,
    "run: 裡對 Sepolia exchange 的 cast send 要依鏈抓出來");
  assert.match(out, /0x32A19D04ef2ca5A7DA02Df39419729fA745749A1（jobs\.keep\.steps\.with\.address） —— .*chain 84532/,
    "with: 帶 Sepolia 位址要依鏈抓出來");
  assert.match(out, /X402_FEE_ROUTER=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 —— chain 84532 的 X402FeeRouter 應為 0x29e5732A/,
    "X402_FEE_ROUTER 填成 MockOracle 要抓出來");
  assert.match(out, /8 個位址與 frontend\/src\/contracts 不一致/);
  // 正確的兩個 GuardedOracle（含 Sepolia 專用那顆）不得誤報。
  assert.doesNotMatch(out, /KEEPER_GUARDED_ORACLE/);
});

test("註解裡的位址不檢查；run: 腳本裡的位址要檢查", () => {
  const { entries, raw } = scanWorkflow(
    [
      "# 0x1111111111111111111111111111111111111111",
      "jobs:",
      "  a:",
      "    env:",
      '      X: "0x2222222222222222222222222222222222222222" # trailing',
      "    steps:",
      "      - run: |",
      "          # 0x3333333333333333333333333333333333333333",
      "          cast call 0x4444444444444444444444444444444444444444",
    ].join("\n"),
  );
  assert.deepEqual(entries.map((e) => [e.path.join("."), e.value]), [
    ["jobs.a.env.X", "0x2222222222222222222222222222222222222222"],
  ]);
  assert.deepEqual(raw.map((r) => r.value), ["0x4444444444444444444444444444444444444444"]);
});

test("allowlist 可以放行前端設定裡沒有的位址", () => {
  const text = [
    "jobs:",
    "  a:",
    "    env:",
    "      KEEPER_CHAIN: base-sepolia",
    '      SOMETHING: "0x5555555555555555555555555555555555555555"',
  ].join("\n");
  assert.equal(checkWorkflow({ file: "x.yml", text, chains, allowlist: [] }).problems.length, 1);
  const allow = [{ address: "0x5555555555555555555555555555555555555555", reason: "test" }];
  assert.equal(checkWorkflow({ file: "x.yml", text, chains, allowlist: allow }).problems.length, 0);
});

test("前端設定解析：兩條鏈的核心角色與 session manager", () => {
  assert.equal(chains["84532"].roles.PerpetualExchange, "0x827eA0c62a32e995927101259042F8A27D99124D");
  assert.equal(chains["84532"].roles.MockOracle, "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3");
  assert.equal(chains["84532"].roles.GuardedOracle, "0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842");
  assert.equal(chains["84532"].roles.AssetVaultV2, "0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a");
  assert.equal(chains["84532"].roles.AgentSessionManager, "0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B");
  assert.equal(chains["11155111"].roles.GuardedOracle, "0x32A19D04ef2ca5A7DA02Df39419729fA745749A1");
  assert.equal(chains["84532"].roles.X402FeeRouter, "0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d");
  assert.notEqual(chains["84532"].roles.X402FeeRouter, chains["84532"].roles.FeeRouter, "x402 router ≠ V1 FeeRouter");
});

test("run: 與 with: 的位址依 job 的鏈檢查（單元）", () => {
  const text = [
    "jobs:",
    "  base:",
    "    env:",
    "      KEEPER_CHAIN: base-sepolia",
    "    steps:",
    "      - run: |",
    "          cast send 0x0c6459d38617E60017bDc4ed69ec26137DA5c32b 'x()'",
    "          cast call 0x827eA0c62a32e995927101259042F8A27D99124D 'y()'",
    "      - uses: some/action@0123456789012345678901234567890123456789",
    "        with:",
    '          address: "0x17CA20A37Cf04F2f589B2573EC95f1411D29d958"',
    "  sep:",
    "    env:",
    "      KEEPER_CHAIN: sepolia",
    "    steps:",
    "      - run: cast call 0x0c6459d38617E60017bDc4ed69ec26137DA5c32b 'z()'",
  ].join("\n");
  const { problems } = checkWorkflow({ file: "x.yml", text, chains, allowlist: [] });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("0x0c6459d3") && p.includes("chain 84532")));
  assert.ok(problems.some((p) => p.includes("0x17CA20A3") && p.includes("with.address")));
});

test("agent/.env.example 也要與設定來源一致（複審 Low）", () => {
  const bad = join(here, "fixtures/check-addresses/bad.env.example");
  const r = spawnSync(process.execPath, [script, "--env", bad], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /X402_FEE_ROUTER=0xeD90.*X402FeeRouter 應為 0x29e5732A/);
  assert.match(r.stdout, /PERP_ADDRESS=0xEf75.*PerpetualExchange 應為 0x827eA0c6/);
  assert.doesNotMatch(r.stdout, /SESSION_MANAGER_ADDRESS|X402_SETTLEMENT_TOKEN|:2 /, "正確的鍵、前端不管的鍵、註解都不報");
  assert.match(r.stdout, /2 個位址與 frontend\/src\/contracts 不一致/);
});

test("--print 給 workflow 做執行期斷言", () => {
  const ok = spawnSync(process.execPath, [script, "--print", "84532", "X402FeeRouter"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d");
  const bad = spawnSync(process.execPath, [script, "--print", "84532", "NoSuchRole"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});

// ── 租戶部署登記（ADR-008）─────────────────────────────────────────────────
// 另開一組 import：上面的測試只需要 workflow 檢查。
const { checkDeployment, checkDeployments, tenantChainView, DEDICATED_REQUIRED_KEYS } = await import(
  "./check-addresses.mjs"
);
const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

const chainsFull = parseFrontendConfig(
  readFileSync(join(root, "frontend/src/contracts/addresses.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/sessionManager.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/x402.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/legacyExchanges.ts"), "utf8"),
);
const live = chainsFull["84532"].roles;
// 一組看起來合法、且不在 addresses.ts 裡的測試位址。
const T = (n) => `0x${n.toString(16).padStart(40, "d")}`;
const dedicated = (tenant = "bank-a", base = 0) => ({
  schemaVersion: 1,
  tenant,
  kind: "dedicated",
  chainId: 84532,
  oracleKind: "guarded",
  contracts: {
    ...Object.fromEntries(DEDICATED_REQUIRED_KEYS.map((k, i) => [k, T(base + i + 1)])),
    SettlementToken: live.MockUSDC,
    AssetVaultV2: T(base + 30),
  },
  tokens: { sAAPL: T(base + 40), sGOLD: T(base + 41) },
});
const depProblems = (dep, file = `${dep.tenant}.json`) =>
  checkDeployment({ file, dep, chains: chainsFull }).problems.join("\n");

test("部署登記：repo 內的兩份（default、demo-bank）都是 platform 且通過", () => {
  const dir = join(root, "frontend/src/contracts/deployments");
  const r = checkDeployments({ dir, tenantsDir: join(root, "frontend/src/tenant/tenants"), chains: chainsFull });
  assert.deepEqual(r.problems, []);
  assert.equal(r.deployments.default.kind, "platform");
  assert.equal(r.deployments["demo-bank"].kind, "platform");
});

test("部署登記：專屬部署只共用結算幣時通過", () => {
  assert.equal(depProblems(dedicated()), "");
});

test("部署登記：非 default 租戶不得與平台共用 exchange／vault／收款路由／任何合約", () => {
  const cases = [
    ["PerpetualExchange", live.PerpetualExchange],
    ["InsuranceVault", live.InsuranceVault],
    ["FeeRouter", live.FeeRouter],
    ["AssetVaultV2", live.AssetVaultV2],
    ["AssetVaultV2", live.AssetVault],
    ["Oracle", live.MockOracle],
    ["Oracle", live.GuardedOracle],
    ["AgentSessionManager", live.AgentSessionManager],
    ["X402FeeRouter", live.X402FeeRouter],
    ["KYCRegistry", live.KYCRegistry],
    ["TraderStake", live.TraderStake],
  ];
  for (const [key, addr] of cases) {
    const d = dedicated();
    d.contracts[key] = addr;
    assert.match(depProblems(d), new RegExp(`contracts\\.${key}=${addr} 是平台部署（default）的位址`), key);
    const lower = dedicated();
    lower.contracts[key] = addr.toLowerCase();
    assert.match(depProblems(lower), /是平台部署（default）的位址/, `${key}（小寫）`);
  }
  const t = dedicated();
  t.tokens.sAAPL = "0x4f36CBc3321b47327407C0eD116188A21ec4da28"; // 平台 V2 的 sAAPL 代幣
  assert.match(depProblems(t), /tokens\.sAAPL=.* 是平台部署（default）的位址/);
  const legacy = dedicated();
  legacy.contracts.PerpetualExchange = "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072";
  assert.match(depProblems(legacy), /是平台已退役的舊 exchange/);
});

test("部署登記：同一租戶各合約不重複、不得是零位址或非位址", () => {
  const d = dedicated();
  d.contracts.FeeRouter = d.contracts.InsuranceVault;
  assert.match(depProblems(d), /contracts\.FeeRouter 與 contracts\.InsuranceVault 是同一個位址/);
  const t = dedicated();
  t.tokens.sGOLD = t.contracts.PerpetualExchange.toUpperCase().replace("0X", "0x");
  assert.match(depProblems(t), /tokens\.sGOLD 與 contracts\.PerpetualExchange 是同一個位址/);
  const z = dedicated();
  z.contracts.CopyTracker = "0x0000000000000000000000000000000000000000";
  assert.match(depProblems(z), /contracts\.CopyTracker 是零位址/);
  const n = dedicated();
  n.contracts.CopyTracker = "0x1234";
  assert.match(depProblems(n), /contracts\.CopyTracker="0x1234" 不是位址/);
  const m = dedicated();
  delete m.contracts.PerpetualExchange;
  assert.match(depProblems(m), /contracts\.PerpetualExchange 未填/);
});

test("部署登記：格式——未知欄位、鏈、oracle 種類、金庫與代幣、檔名", () => {
  const d = dedicated();
  d.contracts.Backdoor = T(90);
  d.rpcUrl = "x";
  d.chainId = 8453;
  d.oracleKind = "chainlink";
  const out = depProblems(d);
  assert.match(out, /contracts 未知欄位 Backdoor/);
  assert.match(out, /未知欄位 rpcUrl/);
  assert.match(out, /chainId 必須是 84532/);
  assert.match(out, /oracleKind 必須是 guarded 或 mock/);

  const noVault = dedicated();
  delete noVault.contracts.AssetVaultV2;
  assert.match(depProblems(noVault), /有 tokens 但沒有 contracts\.AssetVaultV2/);
  const noTokens = dedicated();
  noTokens.tokens = {};
  assert.match(depProblems(noTokens), /有 contracts\.AssetVaultV2 但 tokens 是空的/);
  const mock = dedicated();
  mock.oracleKind = "mock";
  assert.match(depProblems(mock), /AssetVaultV2 需要 oracleKind=guarded/);

  assert.match(depProblems(dedicated("bank-a"), "bank-b.json"), /tenant「bank-a」與檔名「bank-b」不一致/);
  assert.match(depProblems(dedicated("default")), /default 租戶就是平台部署/);
  assert.match(depProblems({ schemaVersion: 1, tenant: "bank-a", kind: "shared" }), /kind 必須是 platform 或 dedicated/);
});

test("部署登記：沿用平台部署要寫理由，而且不能夾帶位址", () => {
  assert.equal(depProblems({ schemaVersion: 1, tenant: "default", kind: "platform" }), "");
  assert.match(depProblems({ schemaVersion: 1, tenant: "bank-a", kind: "platform" }), /必須寫 note 說明理由/);
  assert.equal(depProblems({ schemaVersion: 1, tenant: "bank-a", kind: "platform", note: "示範" }), "");
  assert.match(
    depProblems({ schemaVersion: 1, tenant: "bank-a", kind: "platform", note: "x", contracts: { PerpetualExchange: T(1) } }),
    /kind=platform 不得有欄位 contracts/,
  );
});

test("部署登記：兩個租戶不得共用合約；每個前端租戶都要有登記檔", () => {
  const dir = mkdtempSync(join(tmpdir(), "deployments-"));
  const reg = join(dir, "deployments");
  const tenants = join(dir, "tenants");
  mkdirSync(reg);
  mkdirSync(tenants);
  for (const id of ["default", "bank-a", "bank-b", "bank-c"]) writeFileSync(join(tenants, `${id}.json`), "{}");
  writeFileSync(join(reg, "default.json"), JSON.stringify({ schemaVersion: 1, tenant: "default", kind: "platform" }));
  writeFileSync(join(reg, "bank-a.json"), JSON.stringify(dedicated("bank-a")));
  const b = dedicated("bank-b", 100);
  b.contracts.InsuranceVault = dedicated("bank-a").contracts.InsuranceVault;
  writeFileSync(join(reg, "bank-b.json"), JSON.stringify(b));
  writeFileSync(join(reg, "ghost.json"), JSON.stringify(dedicated("ghost", 200)));
  const out = checkDeployments({ dir: reg, tenantsDir: tenants, chains: chainsFull }).problems.join("\n");
  assert.match(out, /bank-b\.json: contracts\.InsuranceVault=.* 與 bank-a\.json 的 contracts\.InsuranceVault 相同——租戶之間不得共用合約/);
  assert.match(out, /bank-c\.json: 前端租戶「bank-c」沒有部署登記/);
  assert.match(out, /ghost\.json: 有部署登記，但 frontend\/src\/tenant\/tenants\/ 沒有這個租戶/);
  // 結算幣是唯一可以共用的位址：a 與 b 都用同一顆，不算問題。
  assert.doesNotMatch(out, /SettlementToken/);

  const cli = spawnSync(process.execPath, [script, "--deployments", reg, "--tenants", tenants], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /租戶之間不得共用合約/);
});

// ── 租戶自己的 keeper workflow（KEEPER_TENANT）─────────────────────────────

const bankA = dedicated("bank-a");
const deployments = { default: { schemaVersion: 1, tenant: "default", kind: "platform" }, "bank-a": bankA };
const tenantWorkflow = ({
  exchange = bankA.contracts.PerpetualExchange,
  oracle = bankA.contracts.Oracle,
  env = "keeper-bank-a",
  group = "keeper-key-bank-a",
  tenant = "bank-a",
  extra = [],
} = {}) =>
  [
    "name: Tenant keeper",
    "concurrency:",
    `  group: ${group}`,
    "  cancel-in-progress: false",
    "jobs:",
    "  keep:",
    "    environment:",
    `      name: ${env}`,
    "      deployment: false",
    "    env:",
    "      KEEPER_CHAIN: base-sepolia",
    `      KEEPER_TENANT: ${tenant}`,
    "      KEEPER_PRIVATE_KEY: ${{ secrets.KEEPER_PRIVATE_KEY }}",
    `      KEEPER_ORACLE_ADDRESS: "${oracle}"`,
    `      EXCHANGE: "${exchange}"`,
    `      KEEPER_RELAY_SOURCE: "${live.AggregatorOracle}"`,
    `      KEEPER_VAULT_ADDRESS: "${bankA.contracts.AssetVaultV2}"`,
    ...extra,
  ].join("\n");
const wf = (opts) =>
  checkWorkflow({
    file: "tenant-bank-a-keeper.yml",
    text: tenantWorkflow(opts),
    chains: chainsFull,
    allowlist: [],
    deployments,
  }).problems.join("\n");

test("租戶 keeper：位址以該租戶的部署登記比對；共用上游價格來源可以用平台的", () => {
  assert.equal(wf(), "");
  const view = tenantChainView(bankA, chainsFull);
  assert.equal(view.roles.PerpetualExchange, bankA.contracts.PerpetualExchange);
  assert.equal(view.roles.MockOracle, bankA.contracts.Oracle, "KEEPER_ORACLE_ADDRESS＝exchange 讀的那一顆");
  assert.equal(view.roles.GuardedOracle, bankA.contracts.Oracle);
  assert.equal(view.roles.AggregatorOracle, live.AggregatorOracle);
});

test("租戶 keeper：指向平台的 exchange／oracle 要擋", () => {
  assert.match(
    wf({ exchange: live.PerpetualExchange }),
    /EXCHANGE=0x827eA0c6.* —— 租戶 bank-a 的部署登記 的 PerpetualExchange 應為/,
  );
  assert.match(
    wf({ oracle: live.MockOracle }),
    /KEEPER_ORACLE_ADDRESS=.* —— 租戶 bank-a 的部署登記 的 MockOracle 應為/,
  );
  const raw = wf({ extra: ["    steps:", `      - run: cast call ${live.PerpetualExchange} "x()"`] });
  assert.match(raw, /寫死在非 env 位置，租戶 bank-a 的部署登記沒有這個位址/);
});

test("租戶 keeper：必須用自己的 environment（金鑰）與自己的 concurrency group", () => {
  assert.match(wf({ env: "keeper" }), /environment 必須是 keeper-bank-a（租戶自己的 keeper 金鑰），目前是 keeper/);
  assert.match(wf({ group: "keeper-key-base-sepolia" }), /concurrency group 必須含租戶 id/);
  assert.match(wf({ tenant: "bank-x" }), /KEEPER_TENANT=bank-x —— .*沒有這個租戶的部署登記/);
});

test("租戶的唯讀 job（沒有取用 keeper 私鑰）不需要 environment，但位址照樣以租戶登記比對", () => {
  const health = (exchange) =>
    [
      "name: Tenant oracle health",
      "jobs:",
      "  check:",
      "    env:",
      "      KEEPER_CHAIN: base-sepolia",
      "      KEEPER_TENANT: bank-a",
      `      KEEPER_ORACLE_ADDRESS: "${bankA.contracts.Oracle}"`,
      `      KEEPER_EXCHANGE_ADDRESS: "${exchange}"`,
    ].join("\n");
  const check = (exchange) =>
    checkWorkflow({ file: "tenant-bank-a-health.yml", text: health(exchange), chains: chainsFull, allowlist: [], deployments })
      .problems.join("\n");
  assert.equal(check(bankA.contracts.PerpetualExchange), "");
  assert.match(check(live.PerpetualExchange), /租戶 bank-a 的部署登記 的 PerpetualExchange 應為/);
});

test("平台的 workflow 用了租戶的位址照樣擋（沒有 KEEPER_TENANT 就以平台部署比對）", () => {
  const text = tenantWorkflow().replace("      KEEPER_TENANT: bank-a\n", "");
  const out = checkWorkflow({
    file: "base-sepolia-keeper.yml",
    text,
    chains: chainsFull,
    allowlist: [],
    deployments,
  }).problems.join("\n");
  assert.match(out, /EXCHANGE=.* —— chain 84532 的 PerpetualExchange 應為 0x827eA0c6/);
  assert.match(out, /KEEPER_ORACLE_ADDRESS=.* —— chain 84532 的 MockOracle 應為 0xeD90c4F3/);
});

test("沿用平台部署的租戶（kind: platform）的 keeper 就是平台的位址", () => {
  const deps = {
    ...deployments,
    "demo-bank": { schemaVersion: 1, tenant: "demo-bank", kind: "platform", note: "demo" },
  };
  const text = tenantWorkflow({
    tenant: "demo-bank",
    exchange: live.PerpetualExchange,
    oracle: live.MockOracle,
    env: "keeper",
    group: "keeper-key-base-sepolia",
  }).replace(bankA.contracts.AssetVaultV2, live.AssetVaultV2);
  assert.equal(
    checkWorkflow({ file: "x.yml", text, chains: chainsFull, allowlist: [], deployments: deps }).problems.join("\n"),
    "",
  );
});
