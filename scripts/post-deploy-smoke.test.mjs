// 自我測試：部署後 smoke test 對「接對了」與「接錯了」都要給出正確結論。不連網。
//   node --test scripts/post-deploy-smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRIMARY_CHAIN, loadSources, makeRpc } from "./check-deployment-status.mjs";
import { SMOKE_RPC_METHODS, renderResults, runSmoke, staleRule, tenantSources, wiringCalls } from "./post-deploy-smoke.mjs";
import { selector } from "../ops/monitoring/keccak.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAKED = "0xe80a81360608c1342e66743f70a00f75d792eb93";
const RPC = "https://rpc.test";
const API = "https://api.test";
const NOW = 1_800_000_000;
const SAFE = "0x" + "ab".repeat(20);
const KEEPER = "0x" + "cd".repeat(20);
const abiString = (t) => {
  const hex = Buffer.from(t, "utf8").toString("hex");
  return "0x" + (32).toString(16).padStart(64, "0") + t.length.toString(16).padStart(64, "0") + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
};
const word = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** 一條「部署正確」的假鏈＋假 signal-api；overrides 用來注入錯誤。 */
function world({ calls = {}, http = {}, priceAge = {}, noCode = [], vaultVersion = "2.5.0", vaultPriceAge = {} } = {}) {
  const { frontend } = loadSources(REPO);
  const roles = frontend[PRIMARY_CHAIN].roles;
  const state = new Map();
  const set = (to, data, result) => state.set(`${to.toLowerCase()}|${data}`, result);
  for (const w of wiringCalls(REPO, roles)) set(w.to, selector(w.fn), word(w.expected ?? SAFE));
  set(roles.PerpetualExchange, selector("authorizedAgents(address)") + word(roles.AgentSessionManager).slice(2), word(1));
  set(roles.PerpetualExchange, selector("maxPriceAge()"), word((21600).toString(16)));
  set(roles.MockOracle, selector("owner()"), word(KEEPER));
  set(roles.AssetVaultV2, selector("version()"), abiString(vaultVersion));
  const stale = staleRule(REPO);
  for (const sym of stale.assets) {
    const age = priceAge[sym] ?? 60;
    set(roles.MockOracle, selector("getPrice(bytes32)") + stale.assetIds[sym].slice(2), "0x" + word(100).slice(2) + word((NOW - age).toString(16)).slice(2));
    const vAge = vaultPriceAge[sym] ?? 60;
    set(roles.GuardedOracle, selector("getPrice(bytes32)") + stale.assetIds[sym].slice(2), "0x" + word(100).slice(2) + word((NOW - vAge).toString(16)).slice(2));
  }
  for (const [k, v] of Object.entries(calls)) {
    const [ref, data] = k.split("|");
    set(roles[ref] ?? ref, data, v);
  }
  const httpDefaults = {
    "/healthz": { status: 200, body: "ok" },
    "/": { status: 200, body: JSON.stringify({ payTo: SAFE, payToSafety: { safe: true, reason: "eoa" } }) },
    "/oracle/sBTC": { status: 402, body: JSON.stringify({ accepts: [{ scheme: "exact" }] }) },
    ...http,
  };
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url === RPC) {
      const { method, params, id } = JSON.parse(init.body);
      sent.push(method);
      const ok = (result) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
      if (method === "eth_chainId") return ok("0x14a34");
      if (method === "eth_blockNumber") return ok("0x100");
      if (method === "eth_getBlockByNumber") return ok({ timestamp: "0x" + NOW.toString(16) });
      if (method === "eth_getBalance") return ok("0xde0b6b3a7640000");
      if (method === "eth_getStorageAt") return ok(word("11".repeat(20)));
      if (method === "eth_getCode") return ok(noCode.map((a) => a.toLowerCase()).includes(params[0].toLowerCase()) ? "0x" : "0x6080");
      if (method === "eth_call") {
        const { to, data } = params[0];
        const v = state.get(`${to.toLowerCase()}|${data}`);
        if (v !== undefined) return ok(v);
        return ok(data.length === 10 ? word(SAFE) : word(0)); // 其他 getter：安全地址；角色／名單查詢：false
      }
      throw new Error(`unexpected ${method}`);
    }
    const path = url.slice(API.length);
    const r = httpDefaults[path];
    if (!r) throw new Error(`unexpected ${url}`);
    return { status: r.status, headers: new Headers(r.headers ?? {}), text: async () => r.body };
  };
  return { roles, fetchImpl, sent };
}

const run = (w, extra = {}) => runSmoke({ root: REPO, rpcUrl: RPC, apiUrl: API, fetchImpl: w.fetchImpl, sleep: async () => {}, nowSec: NOW, ...extra });
const fails = (results) => results.filter((r) => r.level === "FAIL");

test("部署正確 → 沒有 FAIL；四類檢查都有跑；只用唯讀 RPC", async () => {
  const w = world();
  const results = await run(w);
  assert.deepEqual(fails(results), []);
  for (const g of ["接線", "外洩地址", "keeper", "signal-api"]) assert.ok(results.some((r) => r.group === g), g);
  assert.ok(results.some((r) => r.name === "AgentSessionManager.exchange()" && r.level === "PASS"));
  assert.ok(w.sent.every((m) => SMOKE_RPC_METHODS.has(m)));
});

test("owner 仍是外洩地址 → FAIL，輸出只有縮寫", async () => {
  const w = world({ calls: { [`PerpetualExchange|${selector("owner()")}`]: word(LEAKED) } });
  const results = await run(w);
  const f = fails(results);
  assert.ok(f.some((r) => r.group === "外洩地址" && /PerpetualExchange\.owner\(\)/.test(r.name) && /0xe80a…eb93/.test(r.detail)));
  assert.equal(renderResults(results).toLowerCase().includes(LEAKED), false);
});

test("外洩地址仍持有角色、仍是 authorizedAgent → FAIL", async () => {
  const w = world({
    calls: {
      [`PerpetualExchange|${selector("authorizedAgents(address)")}${word(LEAKED).slice(2)}`]: word(1),
      [`GuardedOracle|${selector("hasRole(bytes32,address)")}${"0".repeat(64)}${word(LEAKED).slice(2)}`]: word(1),
    },
  });
  const f = fails(await run(w));
  assert.ok(f.some((r) => /authorizedAgents/.test(r.name)));
  assert.ok(f.some((r) => /GuardedOracle\.hasRole\(DEFAULT_ADMIN_ROLE/.test(r.name)));
});

test("接線錯誤（InsuranceVault.exchange() 指向別的合約）→ FAIL", async () => {
  const w = world({ calls: { [`InsuranceVault|${selector("exchange()")}`]: word("99".repeat(20)) } });
  assert.ok(fails(await run(w)).some((r) => r.name === "InsuranceVault.exchange()"));
});

test("agent session 沒被授權 → FAIL", async () => {
  const { roles } = world();
  const w = world({ calls: { [`PerpetualExchange|${selector("authorizedAgents(address)")}${word(roles.AgentSessionManager).slice(2)}`]: word(0) } });
  assert.ok(fails(await run(w)).some((r) => /authorizedAgents\(AgentSessionManager\)/.test(r.name)));
});

test("keeper：加密資產超過 maxPriceAge → FAIL；股票 100 小時 → WARN", async () => {
  const results = await run(world({ priceAge: { sBTC: 7 * 3600, sAAPL: 100 * 3600 } }));
  assert.ok(fails(results).some((r) => r.name === "sBTC 價格"));
  assert.equal(results.find((r) => r.name === "sAAPL 價格").level, "WARN");
});

test("signal-api：payto_unsafe（fail-closed）、payTo 是外洩地址、未付款回 200 → FAIL", async () => {
  const unsafe = await run(world({ http: { "/oracle/sBTC": { status: 503, body: JSON.stringify({ ok: false, error: "payto_unsafe" }) } } }));
  assert.ok(fails(unsafe).some((r) => /payto_unsafe/.test(r.detail)));
  const leaked = await run(world({ http: { "/": { status: 200, body: JSON.stringify({ payTo: LEAKED, payToSafety: { safe: false } }) } } }));
  assert.ok(fails(leaked).some((r) => r.name === "GET / payTo" && /0xe80a…eb93/.test(r.detail)));
  const free = await run(world({ http: { "/oracle/sBTC": { status: 200, body: "{}" } } }));
  assert.ok(fails(free).some((r) => /付費牆沒有作用/.test(r.detail)));
  const v2 = await run(world({ http: { "/oracle/sBTC": { status: 402, body: "{}", headers: { "PAYMENT-REQUIRED": "e30=" } } } }));
  assert.equal(v2.find((r) => r.name === "未付款 GET /oracle/sBTC").level, "PASS");
});

test("smoke 的 RPC 拒絕任何會送交易的方法", async () => {
  const rpc = makeRpc(RPC, { fetchImpl: async () => assert.fail("不該送出"), allowed: SMOKE_RPC_METHODS });
  await assert.rejects(() => rpc("eth_sendRawTransaction", ["0x"]), /不允許/);
  await assert.rejects(() => rpc("eth_sign", ["0x", "0x"]), /不允許/);
});

test("位址沒有程式碼 → FAIL，而不是把 0x 讀成零位址而通過", async () => {
  const { roles } = world();
  // X402FeeRouter 的 exchange()／copyTracker() 預期是 0：沒有程式碼時以前會「剛好」通過
  const results = await run(world({ noCode: [roles.X402FeeRouter] }));
  assert.ok(fails(results).some((r) => r.group === "程式碼" && r.name === roles.X402FeeRouter));
  assert.equal(results.some((r) => r.name === "X402FeeRouter.exchange()" && r.level === "PASS"), false);
});

test("AssetVaultV2.version() 不是原始碼現行版（漏做 V2_5 升級）→ FAIL", async () => {
  const f = fails(await run(world({ vaultVersion: "2.4.0" })));
  assert.ok(f.some((r) => r.name === "AssetVaultV2 version()" && r.detail.includes("2.4.0") && r.detail.includes("2.5.0")));
});

test("--fresh-since：dispatch 之後完全沒有寫價 → FAIL；有寫過就 PASS（不要求每一檔都重寫）", async () => {
  const w = world({ priceAge: Object.fromEntries(["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"].map((k) => [k, 3 * 3600])) });
  const ok = await run(w);
  assert.equal(ok.find((r) => r.name === "最近一次寫價").level, "PASS", "3 小時內的舊價本來會過");
  const strict = await run(w, { freshSince: NOW - 600 });
  assert.equal(strict.find((r) => r.name === "最近一次寫價").level, "FAIL");
  // 有一檔在 dispatch 後寫過 → keeper 確實跑了
  const wrote = await run(world({ priceAge: { sBTC: 60, sETH: 3 * 3600 } }), { freshSince: NOW - 600 });
  assert.equal(wrote.find((r) => r.name === "最近一次寫價").level, "PASS");
});

test("--max-age：任何一檔超過上限 → FAIL（股票休市的舊價也算）", async () => {
  const results = await run(world({ priceAge: { sAAPL: 8 * 3600 } }), { maxAgeSec: 21600 });
  assert.equal(results.find((r) => r.name === "sAAPL 價格").level, "FAIL");
  assert.equal(results.find((r) => r.name === "sBTC 價格").level, "PASS");
});

test("外洩檢查有讀不到的項目 → 摘要是 WARN，不宣稱全部沒問題", async () => {
  const { roles } = world();
  const results = await run(world({ calls: { [`PerpetualExchange|${selector("guardian()")}`]: "0x" } }));
  const summary = results.filter((r) => r.group === "外洩地址" && /項查詢$/.test(r.name));
  assert.equal(summary.length, 1);
  assert.equal(summary[0].level, "WARN");
  assert.ok(roles.PerpetualExchange);
});

const ALL = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

test("V2 金庫的 oracle 也要新鮮：exchange 的價格新、金庫的舊（keeper 沒改指向新 GuardedOracle）→ --fresh-since FAIL", async () => {
  const w = world({ vaultPriceAge: Object.fromEntries(ALL.map((k) => [k, 2 * 3600])) });
  const loose = await run(w);
  assert.equal(loose.find((r) => r.name === "V2 金庫 oracle 最近一次寫價").level, "PASS");
  const strict = await run(w, { freshSince: NOW - 600 });
  assert.equal(strict.find((r) => r.name === "最近一次寫價").level, "PASS", "exchange 的 oracle 是新的");
  const v = strict.find((r) => r.name === "V2 金庫 oracle 最近一次寫價");
  assert.equal(v.level, "FAIL");
  assert.ok(v.detail.includes("KEEPER_GUARDED_ORACLE"));
});

test("V2 金庫 oracle：超過 --max-age → FAIL；超過 6 小時 → WARN", async () => {
  const strict = await run(world({ vaultPriceAge: { sAAPL: 8 * 3600 } }), { maxAgeSec: 21600 });
  assert.ok(fails(strict).some((r) => r.name === "V2 金庫 oracle 價格年齡" && r.detail.includes("sAAPL")));
  const loose = await run(world({ vaultPriceAge: { sAAPL: 8 * 3600 } }));
  assert.equal(loose.find((r) => r.name === "V2 金庫 oracle 價格年齡").level, "WARN");
});

// ── --tenant：專屬租戶（dedicated 登記＋部署設定）────────────────────────────

const T = (n) => "0x" + n.toString(16).padStart(40, "7");
const TENANT_REGISTRY = {
  schemaVersion: 1,
  tenant: "rwa-poc",
  kind: "dedicated",
  chainId: 84532,
  oracleKind: "guarded",
  contracts: {
    SettlementToken: T(1), Oracle: T(2), ESGRegistryV2: T(3), KYCRegistry: T(4), InsuranceVault: T(5), FeeRouter: T(6),
    TraderStake: T(7), PerpetualExchange: T(8), StrategyRegistry: T(9), CopyTracker: T(10), AgentSessionManager: T(11),
    AssetVaultV2: T(12),
  },
  shared: ["contracts.SettlementToken"],
  tokens: { sGOLD: T(13) },
};
const TENANT_ROLES = { admin: T(20), risk: T(21), guardian: T(22), keeper: T(23), marketOperator: T(23), treasury: T(20) };
const tenantConfig = (kyc = "vc", roles = TENANT_ROLES) => ({ schemaVersion: 4, roles, params: { kycRegistry: kyc } });
const TENANT_RECORD = { deployer: T(30) };

/** 一個接線正確的專屬租戶；overrides 注入錯誤。 */
function tenantWorld({ calls = {}, kyc = "vc", roles = TENANT_ROLES, record = TENANT_RECORD, config, registry = TENANT_REGISTRY } = {}) {
  const tenantFiles = { registry, config: config ?? tenantConfig(kyc, roles), record };
  const t = tenantSources(REPO, "rwa-poc", loadSources(REPO), tenantFiles);
  const c = TENANT_REGISTRY.contracts;
  const state = new Map();
  const set = (to, data, result) => state.set(`${to.toLowerCase()}|${data}`, result);
  for (const w of wiringCalls(REPO, t.wiringRoles)) set(w.to, selector(w.fn), word(w.expected ?? SAFE));
  set(c.PerpetualExchange, selector("authorizedAgents(address)") + word(c.AgentSessionManager).slice(2), word(1));
  set(c.PerpetualExchange, selector("maxPriceAge()"), word((21600).toString(16)));
  set(c.AssetVaultV2, selector("version()"), abiString("2.5.0"));
  const stale = staleRule(REPO);
  for (const sym of stale.assets) {
    set(c.Oracle, selector("getPrice(bytes32)") + stale.assetIds[sym].slice(2), "0x" + word(100).slice(2) + word((NOW - 60).toString(16)).slice(2));
  }
  for (const [k, v] of Object.entries(calls)) {
    const [ref, data] = k.split("|");
    set(c[ref] ?? ref, data, v);
  }
  const sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, RPC, "租戶模式沒有 --signal-api 時不該打任何 HTTP");
    const { method, params, id } = JSON.parse(init.body);
    sent.push({ method, params });
    const ok = (result) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
    if (method === "eth_chainId") return ok("0x14a34");
    if (method === "eth_blockNumber") return ok("0x100");
    if (method === "eth_getBlockByNumber") return ok({ timestamp: "0x" + NOW.toString(16) });
    if (method === "eth_getBalance") return ok("0xde0b6b3a7640000");
    if (method === "eth_getStorageAt") return ok(word("11".repeat(20)));
    if (method === "eth_getCode") return ok("0x6080");
    if (method === "eth_call") {
      const { to, data } = params[0];
      const v = state.get(`${to.toLowerCase()}|${data}`);
      if (v !== undefined) return ok(v);
      return ok(data.length === 10 ? word(SAFE) : word(0));
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, sent, tenantFiles };
}
const runTenant = (w, extra = {}) =>
  runSmoke({ root: REPO, rpcUrl: RPC, fetchImpl: w.fetchImpl, sleep: async () => {}, nowSec: NOW, skipHttp: true, tenant: "rwa-poc", tenantFiles: w.tenantFiles, ...extra });

test("--tenant：接線正確的租戶沒有 FAIL；讀的是租戶的合約，不是平台的", async () => {
  const w = tenantWorld();
  const results = await runTenant(w);
  assert.deepEqual(fails(results), []);
  assert.ok(results.some((r) => r.name === "PerpetualExchange.kyc()" && r.level === "PASS"));
  assert.ok(results.some((r) => r.name === "AssetVaultV2.oracle()" && r.detail.includes(TENANT_REGISTRY.contracts.Oracle)));
  const platform = loadSources(REPO).frontend[PRIMARY_CHAIN].roles;
  const touched = new Set(w.sent.filter((s) => s.method === "eth_call").map((s) => s.params[0].to.toLowerCase()));
  assert.equal(touched.has(platform.PerpetualExchange.toLowerCase()), false);
  // keeper 錢包＝設定的 roles.keeper（GuardedOracle 沒有 owner）
  assert.ok(results.some((r) => r.name === "keeper 錢包 gas" && r.detail.includes(TENANT_ROLES.keeper)));
});

test("--tenant：VC 登錄查 issuerTypeCount 與 pendingOwner；外洩地址是發證者或 pending owner → FAIL", async () => {
  const issuer = await runTenant(tenantWorld({ calls: { [`KYCRegistry|${selector("issuerTypeCount(address)")}${word(LEAKED).slice(2)}`]: word(1) } }));
  assert.ok(fails(issuer).some((r) => /KYCRegistry\.issuerTypeCount/.test(r.name)));
  const pending = await runTenant(tenantWorld({ calls: { [`KYCRegistry|${selector("pendingOwner()")}`]: word(LEAKED) } }));
  assert.ok(fails(pending).some((r) => r.name === "KYCRegistry.pendingOwner()"));
  // allowlist 登錄維持平台的 verifiers 檢查
  const allow = await runTenant(tenantWorld({ kyc: "allowlist", calls: { [`KYCRegistry|${selector("verifiers(address)")}${word(LEAKED).slice(2)}`]: word(1) } }));
  assert.ok(fails(allow).some((r) => /KYCRegistry\.verifiers/.test(r.name)));
});

test("--tenant：exchange 的 owner／guardian／marketOperator、授權 agent、設定裡的角色與部署者是外洩地址 → FAIL", async () => {
  const g = await runTenant(tenantWorld({ calls: { [`PerpetualExchange|${selector("guardian()")}`]: word(LEAKED) } }));
  assert.ok(fails(g).some((r) => r.name === "PerpetualExchange.guardian()"));
  const a = await runTenant(tenantWorld({ calls: { [`PerpetualExchange|${selector("authorizedAgents(address)")}${word(LEAKED).slice(2)}`]: word(1) } }));
  assert.ok(fails(a).some((r) => /authorizedAgents/.test(r.name)));
  const role = await runTenant(tenantWorld({ roles: { ...TENANT_ROLES, guardian: LEAKED } }));
  assert.ok(fails(role).some((r) => r.name === "roles.guardian"));
  const dep = await runTenant(tenantWorld({ record: { deployer: LEAKED } }));
  assert.ok(fails(dep).some((r) => r.name === "deployer（部署紀錄）"));
});

test("--tenant：接線錯誤（exchange.kyc() 不是登記的登錄）→ FAIL", async () => {
  const r = await runTenant(tenantWorld({ calls: { [`PerpetualExchange|${selector("kyc()")}`]: word("99".repeat(20)) } }));
  assert.ok(fails(r).some((x) => x.name === "PerpetualExchange.kyc()"));
});

test("--tenant：沒有 --signal-api 又沒 --skip-http → FAIL（不退回平台的 signal-api）；登記不是 dedicated → 拒絕", async () => {
  const r = await runTenant(tenantWorld(), { skipHttp: false });
  assert.ok(fails(r).some((x) => x.name === "租戶的 signal-api"));
  const platformReg = { schemaVersion: 1, tenant: "rwa-poc", kind: "platform", note: "x" };
  await assert.rejects(
    () => runSmoke({ root: REPO, rpcUrl: RPC, fetchImpl: async () => assert.fail(), skipHttp: true, tenant: "rwa-poc", tenantFiles: { registry: platformReg, config: tenantConfig() } }),
    /不是 dedicated/,
  );
  await assert.rejects(() => runSmoke({ root: REPO, rpcUrl: RPC, fetchImpl: async () => assert.fail(), tenant: "../x" }), /--tenant 必須是租戶 id/);
});

test("--tenant：部署紀錄缺少或壞掉、設定不是 v4、kycRegistry 不認得、登記缺必填合約 → FAIL", async () => {
  const fileFail = (results, name, re) => assert.ok(fails(results).some((r) => r.group === "租戶檔案" && r.name === name && re.test(r.detail)), `${name} ${re}`);
  fileFail(await runTenant(tenantWorld({ record: null })), "部署紀錄", /沒有部署紀錄/);
  fileFail(await runTenant(tenantWorld({ record: { contracts: {} } })), "部署紀錄", /沒有 deployer/);
  fileFail(await runTenant(tenantWorld({ record: [] })), "部署紀錄", /沒有 deployer/);
  fileFail(await runTenant(tenantWorld({ config: { ...tenantConfig(), schemaVersion: 3 } })), "部署設定", /只讀 v4/);
  fileFail(await runTenant(tenantWorld({ kyc: "kyc" })), "部署設定", /kycRegistry/);
  fileFail(await runTenant(tenantWorld({ config: { schemaVersion: 4, roles: TENANT_ROLES } })), "部署設定", /kycRegistry/);
  const { KYCRegistry: _k, ...noKyc } = TENANT_REGISTRY.contracts;
  fileFail(await runTenant(tenantWorld({ registry: { ...TENANT_REGISTRY, contracts: noKyc } })), "前端登記", /contracts\.KYCRegistry/);
  const { Oracle: _o, ...noOracle } = TENANT_REGISTRY.contracts;
  fileFail(await runTenant(tenantWorld({ registry: { ...TENANT_REGISTRY, contracts: noOracle } })), "前端登記", /contracts\.Oracle/);
  // 沒有金庫的租戶不需要 AssetVaultV2
  const { AssetVaultV2: _v, ...noVault } = TENANT_REGISTRY.contracts;
  const nv = await runTenant(tenantWorld({ registry: { ...TENANT_REGISTRY, contracts: noVault, tokens: undefined } }));
  assert.equal(nv.some((r) => r.group === "租戶檔案"), false);
});

test("--tenant：讀不到 repo 裡的部署紀錄 → FAIL（不是當成沒事）", async () => {
  const w = tenantWorld();
  const { record: _r, ...noRecord } = w.tenantFiles;
  const results = await runSmoke({ root: REPO, rpcUrl: RPC, fetchImpl: w.fetchImpl, sleep: async () => {}, nowSec: NOW, skipHttp: true, tenant: "no-such-tenant", tenantFiles: noRecord });
  assert.ok(fails(results).some((r) => r.group === "租戶檔案" && r.name === "部署紀錄" && /讀不到/.test(r.detail)));
});
