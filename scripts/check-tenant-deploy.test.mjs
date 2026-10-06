// check-tenant-deploy.mjs 的自我測試：repo 內的設定必須通過、每一種錯誤都必須被抓到。
//   node --test scripts/check-tenant-deploy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MUST_DIFFER,
  PARAM_RANGES,
  ORACLE_PARAM_KEYS,
  VAULT_PARAM_KEYS,
  RECORD_CONTRACT_KEYS,
  checkCrossTenant,
  checkTenantDirs,
  checkDeployedRecord,
  checkTenantDeploy,
  envPlan,
  frontendDeployment,
  frontendMismatches,
  loadContext,
  run,
} from "./check-tenant-deploy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-tenant-deploy.mjs");
const ctx = loadContext(root);
const demo = JSON.parse(readFileSync(join(root, "deploy/tenants/demo-bank.json"), "utf8"));

// 一組看起來合法、且不在平台位址全集裡的測試位址。
const A = (n) => `0x${n.toString(16).padStart(40, "a")}`;
const live = ctx.chains["84532"].roles;
const filled = () => {
  const c = structuredClone(demo);
  c.status = "ready";
  c.roles = { admin: A(1), risk: A(2), guardian: A(3), keeper: A(4), marketOperator: A(5), treasury: A(6) };
  // 共用元件只能是平台在這條鏈的白名單角色。
  c.shared = { settlementToken: live.MockUSDC, priceSource: live.MockOracle, referenceSource: live.AggregatorOracle };
  c.params = {
    oracleKind: "guarded",
    oracleMaxDeviationBps: 1000,
    oracleWindowSeconds: 3600,
    oracleWindowDeviationBps: 2500,
    oiCapNonRwaUsdc: 1000,
    oiCapRwaUsdc: 500,
    maxProfitBps: 50000,
    maxLeverage: 5,
    liquidationPenaltyBps: 2000,
    markPremiumCapBps: 0,
    vaultFeeShareBps: 0,
    deployVault: true,
    vaultRedeemFeeBps: 30,
    vaultMinReserveRatioBps: 11000,
  };
  return c;
};
/** mock oracle、沒有金庫的合法設定（不適用的參數都是 null）。 */
const mockNoVault = () => {
  const c = filled();
  c.params.oracleKind = "mock";
  c.params.deployVault = false;
  for (const k of [...ORACLE_PARAM_KEYS, ...VAULT_PARAM_KEYS]) c.params[k] = null;
  c.shared.referenceSource = "none";
  return c;
};
// 一份與 filled() 對得上的部署紀錄（DeployTenant.s.sol 廣播後寫出的形狀）。
const B = (n) => `0x${n.toString(16).padStart(40, "b")}`;
const deployedCfg = () => {
  const c = filled();
  c.status = "deployed";
  c.fees = { status: "decided", baseFeeBps: 10, tenantMarkupBps: 5 };
  return c;
};
const record = (cfg = deployedCfg()) => ({
  schemaVersion: 1,
  tenantId: "demo-bank",
  chainId: cfg.network.chainId,
  mode: "broadcast",
  deployBlock: 12345678,
  oracleKind: cfg.params.oracleKind,
  deployer: B(99),
  owner: cfg.roles.admin,
  settlementToken: cfg.shared.settlementToken,
  treasury: cfg.roles.treasury,
  contracts: Object.fromEntries(RECORD_CONTRACT_KEYS.map((k, i) => [k, B(i + 1)])),
  tokens: Object.fromEntries(cfg.assets.registered.map((s, i) => [s, B(100 + i)])),
});
const checkRec = (rec, cfg = deployedCfg(), file = "demo-bank.deployed.json") =>
  checkDeployedRecord({ file, rec, cfg, ctx }).problems.join("\n");
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

test("租戶專屬角色不得使用平台位址全集裡的任何位址（含退役與只在註解裡的）", () => {
  for (const prod of [live.PerpetualExchange, "0x4E7cC1B79B72ab72531a6C790e14304370f70764", [...ctx.universe.keys()][0]]) {
    const c = filled();
    c.roles.guardian = prod;
    assert.match(check(c), /roles\.guardian=.* 是現行正式站（平台）用過的位址（出處：/, prod);
  }
});

test("共用元件是白名單：結算幣只能是平台那一顆、價格來源與參考來源只能是平台的 oracle／去中心化來源", () => {
  const ok = filled();
  for (const role of ["MockOracle", "GuardedOracle", "AggregatorOracle"]) {
    ok.shared.priceSource = live[role];
    assert.equal(check(ok), "", `priceSource=${role}`);
  }
  for (const role of ["AggregatorOracle", "ChainlinkAdapter", "PythAdapter"]) {
    ok.shared.referenceSource = live[role];
    assert.equal(check(ok), "", `referenceSource=${role}`);
  }
  ok.shared.referenceSource = "none";
  assert.equal(check(ok), "", "referenceSource=none（無參考來源）");

  // 審查 F2：平台的保險金份額（18 位 ERC20）當結算幣。
  const vault = filled();
  vault.shared.settlementToken = live.InsuranceVault;
  assert.match(check(vault), /shared\.settlementToken=.* 不是平台在 chain 84532 的 MockUSDC/);
  const any = filled();
  any.shared.settlementToken = A(7);
  assert.match(check(any), /shared\.settlementToken=.* 不是平台在 chain 84532 的 MockUSDC/);
  const src = filled();
  src.shared.priceSource = live.PerpetualExchange;
  assert.match(check(src), /shared\.priceSource=.* 不是平台在 chain 84532 的 MockOracle／GuardedOracle／AggregatorOracle/);
  const ref = filled();
  ref.shared.referenceSource = live.MockOracle; // keeper 寫得到的 oracle 不是獨立的參考來源
  assert.match(check(ref), /shared\.referenceSource=.* 不是平台在 chain 84532 的 AggregatorOracle／ChainlinkAdapter／PythAdapter/);
  const missing = filled();
  delete missing.shared.referenceSource;
  assert.match(check(missing), /shared\.referenceSource 未填/);
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

test("設定檔沒有放已部署位址的欄位（v2：位址只在 <id>.deployed.json）", () => {
  const c = filled();
  c.deployed = { PerpetualExchange: A(20) };
  assert.match(check(c), /未知欄位 deployed/);
  for (const v of [1, 2]) {
    const old = filled();
    old.schemaVersion = v;
    assert.match(check(old), /schemaVersion 必須是 3/);
  }
});

test("status=deployed 但沒有部署紀錄，CLI 擋下", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-deploy-"));
  const file = join(dir, "demo-bank.json");
  writeFileSync(file, JSON.stringify(deployedCfg()));
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /status=deployed 但找不到部署紀錄 demo-bank\.deployed\.json/);
});

// ── params（DeployTenant.s.sol 的輸入）────────────────────────────────────

test("params：ready 以上必須填上限，而且不能是 0（合約上 0＝不設上限）、也不能大到等於不設", () => {
  for (const k of ["oiCapNonRwaUsdc", "oiCapRwaUsdc"]) {
    const c = filled();
    c.params[k] = null;
    assert.match(check(c), new RegExp(`params\\.${k} 未填`), k);
    for (const bad of [0, -5, 1.5, "1000", 10_000_001]) {
      const d = filled();
      d.params[k] = bad;
      assert.match(check(d), new RegExp(`params\\.${k} 必須是 1–10000000 的整數（整數 USDC`), `${k}=${bad}`);
    }
  }
  const t = structuredClone(demo);
  assert.equal(check(t), "", "template 可以留 null");
});

test("params：每一個數值參數都有範圍，邊界內通過、邊界外與 0 擋下（不適用時必須是 null）", () => {
  for (const [k, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    for (const v of [lo, hi]) {
      const c = filled();
      c.params[k] = v;
      assert.equal(check(c), "", `${k}=${v}`);
    }
    for (const v of [lo - 1, hi + 1, 1.5, String(lo)]) {
      const c = filled();
      c.params[k] = v;
      assert.match(check(c), new RegExp(`params\\.${k} 必須是 ${lo}–${hi} 的整數`), `${k}=${v}`);
    }
    const missing = filled();
    delete missing.params[k];
    assert.match(check(missing), new RegExp(`params\\.${k} 缺少`), `${k} 缺少`);
    const nul = filled();
    nul.params[k] = null;
    assert.match(check(nul), new RegExp(`params\\.${k} 未填`), `${k}=null`);
  }
});

test("params：oracle 限速（審查 F1）——guarded 必須有非零的單次與時間窗上限；mock 必須寫 null", () => {
  for (const k of ORACLE_PARAM_KEYS) {
    const z = filled();
    z.params[k] = 0;
    assert.match(check(z), new RegExp(`params\\.${k} 必須是 .*0＝不限速，不允許`), k);
    const m = mockNoVault();
    m.params[k] = 1000;
    assert.match(check(m), new RegExp(`params\\.${k} 必須是 null：oracleKind=mock 沒有任何限速`), k);
  }
  assert.equal(check(mockNoVault()), "");
  const ref = mockNoVault();
  ref.shared.referenceSource = live.AggregatorOracle;
  assert.match(check(ref), /oracleKind=mock 時 shared\.referenceSource 必須是 "none"/);
});

test("params：沒有金庫時金庫參數必須是 null；有金庫時必填", () => {
  for (const k of VAULT_PARAM_KEYS) {
    const c = filled();
    c.params.deployVault = false;
    for (const j of VAULT_PARAM_KEYS) c.params[j] = null;
    assert.equal(check(c), "");
    c.params[k] = 30;
    assert.match(check(c), new RegExp(`params\\.${k} 必須是 null：params\\.deployVault=false`), k);
  }
});

test("params：maxProfitBps 必須在 10000–250000，0 不允許", () => {
  for (const bad of [0, 9999, 250001, "50000"]) {
    const c = filled();
    c.params.maxProfitBps = bad;
    assert.match(check(c), /params\.maxProfitBps 必須是 10000–250000/, String(bad));
  }
  const c = filled();
  c.params.maxProfitBps = null;
  assert.match(check(c), /params\.maxProfitBps 未填/);
});

test("params：oracleKind 只有 guarded／mock；mock 不上主網、不配金庫", () => {
  const c = filled();
  c.params.oracleKind = "chainlink";
  assert.match(check(c), /params\.oracleKind 必須是 guarded \/ mock/);
  const m = mockNoVault();
  m.params.deployVault = true;
  m.params.vaultRedeemFeeBps = 30;
  m.params.vaultMinReserveRatioBps = 11000;
  assert.match(check(m), /deployVault=true 需要 oracleKind=guarded/);
  const ok = mockNoVault();
  assert.equal(check(ok), "");
  ok.network.chainId = 8453;
  assert.match(check(ok), /oracleKind=mock 不得用於 Base 主網/);
  const u = filled();
  u.params.oiCapUsdc = 1;
  u.params.deployVault = "yes";
  const out = check(u);
  assert.match(out, /params 未知欄位 oiCapUsdc/);
  assert.match(out, /params\.deployVault 必須是 true 或 false/);
});

test("guardian 不得兼 marketOperator 或 treasury；marketOperator 可以就是 keeper", () => {
  const c = filled();
  c.roles.marketOperator = c.roles.guardian;
  assert.match(check(c), /roles\.guardian 與 roles\.marketOperator 是同一個地址/);
  const d = filled();
  d.roles.treasury = d.roles.guardian;
  assert.match(check(d), /roles\.guardian 與 roles\.treasury 是同一個地址/);
  const ok = filled();
  ok.roles.marketOperator = ok.roles.keeper;
  assert.equal(check(ok), "");
  const adm = filled();
  adm.roles.marketOperator = adm.roles.admin;
  assert.match(check(adm), /roles\.admin 與 roles\.marketOperator 是同一個地址/);
});

// ── 部署紀錄（<id>.deployed.json）─────────────────────────────────────────

test("部署紀錄：與設定對得上的紀錄通過", () => {
  assert.equal(checkRec(record()), "");
});

test("部署紀錄：只收廣播過的（dry-run／test 的位址是模擬的）", () => {
  for (const mode of ["dry-run", "test", undefined]) {
    const r = record();
    r.mode = mode;
    assert.match(checkRec(r), /只有 DeployTenant 廣播後寫出的紀錄/, String(mode));
  }
});

test("部署紀錄：同一租戶的合約位址不得重複、不得是零位址", () => {
  const r = record();
  r.contracts.FeeRouter = r.contracts.InsuranceVault;
  assert.match(checkRec(r), /contracts\.FeeRouter 與 contracts\.InsuranceVault 是同一個地址/);
  const t = record();
  t.tokens.sAAPL = t.contracts.PerpetualExchange;
  assert.match(checkRec(t), /tokens\.sAAPL 與 contracts\.PerpetualExchange 是同一個地址/);
  const z = record();
  z.contracts.PerpetualExchange = "0x0000000000000000000000000000000000000000";
  assert.match(checkRec(z), /contracts\.PerpetualExchange 是零位址/);
  const m = record();
  delete m.contracts.CopyTracker;
  assert.match(checkRec(m), /contracts\.CopyTracker=undefined 不是位址/);
});

test("部署紀錄：租戶隔離——不得出現正式站的 exchange／vault／任何合約", () => {
  const prod = live.PerpetualExchange;
  for (const k of ["PerpetualExchange", "InsuranceVault", "FeeRouter", "AssetVaultV2", "Oracle"]) {
    const r = record();
    r.contracts[k] = prod;
    assert.match(checkRec(r), new RegExp(`contracts\\.${k}=.* 是現行正式站`), k);
  }
  const t = record();
  t.tokens.sMSFT = prod;
  assert.match(checkRec(t), /tokens\.sMSFT=.* 是現行正式站/);
});

test("部署紀錄：租戶的合約不是共用元件，也不是任何角色地址", () => {
  const cfg = deployedCfg();
  const r = record(cfg);
  r.contracts.Oracle = cfg.shared.priceSource;
  assert.match(checkRec(r, cfg), /contracts\.Oracle 與 shared\.priceSource 是同一個地址/);
  const k = record(cfg);
  k.contracts.FeeRouter = cfg.roles.treasury;
  assert.match(checkRec(k, cfg), /contracts\.FeeRouter 與 roles\.treasury 是同一個地址/);
  const d = record(cfg);
  d.deployer = cfg.roles.keeper;
  assert.match(checkRec(d, cfg), /deployer 與 roles\.keeper 是同一個地址——部署者不得持有任何租戶角色/);
});

test("部署紀錄：必須與設定一致（鏈、oracle 種類、結算幣、收款地址、owner＝admin）", () => {
  const r = record();
  r.chainId = 8453;
  r.oracleKind = "mock";
  r.settlementToken = B(200);
  r.treasury = B(201);
  r.owner = r.deployer;
  const out = checkRec(r);
  assert.match(out, /chainId=8453 與設定的 network\.chainId=84532 不一致/);
  assert.match(out, /oracleKind=mock 與設定的 params\.oracleKind 不一致/);
  assert.match(out, /settlementToken 與設定的 shared\.settlementToken 不一致/);
  assert.match(out, /treasury 與設定的 roles\.treasury 不一致/);
  assert.match(out, /owner 與設定的 roles\.admin 不一致/);
});

test("部署紀錄：設定還不是 deployed、或找不到設定，都擋", () => {
  assert.match(checkRec(record(), filled()), /有部署紀錄，但 demo-bank\.json 的 status 是 ready/);
  assert.match(checkRec(record(), null), /找不到對應的部署設定 demo-bank\.json/);
  assert.match(checkRec(record(), deployedCfg(), "other.deployed.json"), /tenantId「demo-bank」與檔名「other」不一致/);
});

test("部署紀錄：金庫與代幣跟著 params.deployVault 與 assets.registered", () => {
  const cfg = deployedCfg();
  const r = record(cfg);
  delete r.tokens.sAAPL;
  r.tokens.sBTC = B(300);
  const out = checkRec(r, cfg);
  assert.match(out, /tokens 缺少 sAAPL/);
  assert.match(out, /tokens\.sBTC 不在設定的 assets\.registered 裡/);

  const noVault = deployedCfg();
  noVault.params.deployVault = false;
  assert.match(checkRec(record(noVault), noVault), /params\.deployVault 不是 true，紀錄卻有金庫位址/);
  const zeroVault = record(noVault);
  zeroVault.contracts.AssetVaultV2 = zeroVault.contracts.AssetVaultV2Impl = "0x0000000000000000000000000000000000000000";
  zeroVault.tokens = {};
  assert.equal(checkRec(zeroVault, noVault), "");
});

test("部署紀錄：私鑰形狀、網址、未知欄位都擋", () => {
  const r = record();
  r.note = `0x${"12".repeat(32)}`;
  r.contracts.Extra = B(400);
  const out = checkRec(r);
  assert.match(out, /未知欄位 note/);
  assert.match(out, /note 看起來是私鑰/);
  assert.match(out, /contracts 未知欄位 Extra/);
});

test("部署紀錄：兩個租戶的合約不得相同；紀錄與自己的設定不算兩個租戶", () => {
  const a = checkDeployedRecord({ file: "a.deployed.json", rec: { ...record(), tenantId: "a" }, cfg: deployedCfg(), ctx });
  const b = checkDeployedRecord({ file: "b.deployed.json", rec: { ...record(), tenantId: "b" }, cfg: deployedCfg(), ctx });
  const out = checkCrossTenant([
    { file: "a.json", ...a },
    { file: "b.json", ...b },
  ]).join("\n");
  assert.match(out, /b\.json: contracts\.PerpetualExchange=.* 與 a\.json 的 contracts\.PerpetualExchange 相同/);
});

test("CLI：設定＋紀錄一起檢查，前端登記還指向平台就擋；--print-frontend 印出前端部署登記", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-deploy-"));
  const cfg = deployedCfg();
  writeFileSync(join(dir, "demo-bank.json"), JSON.stringify(cfg));
  const recFile = join(dir, "demo-bank.deployed.json");
  writeFileSync(recFile, JSON.stringify(record(cfg)));
  // 設定與紀錄本身沒有問題；唯一的問題是 repo 裡 demo-bank 的前端登記仍是 kind: platform
  //（示範租戶沒有真的部署）——已部署的租戶不能讓前端繼續連平台的合約。
  const all = spawnSync(process.execPath, [script, join(dir, "demo-bank.json"), recFile], { encoding: "utf8" });
  assert.equal(all.status, 1, all.stdout + all.stderr);
  assert.match(all.stdout, /1 份租戶部署設定、1 份部署紀錄/);
  assert.match(all.stdout, /status=deployed，但 frontend\/src\/contracts\/deployments\/demo-bank\.json 的 kind 是 platform/);
  assert.match(all.stdout, /\n1 個問題/);

  const r = spawnSync(process.execPath, [script, "--print-frontend", recFile], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const fe = JSON.parse(r.stdout);
  assert.deepEqual(fe, frontendDeployment(record(cfg)));
  assert.equal(fe.kind, "dedicated");
  assert.equal(fe.tenant, "demo-bank");
  assert.equal(fe.contracts.SettlementToken, cfg.shared.settlementToken);
  assert.equal(fe.contracts.PerpetualExchange, record(cfg).contracts.PerpetualExchange);
  assert.equal(fe.contracts.AssetVaultV2Impl, undefined, "實作合約不是前端要用的位址");
  assert.deepEqual(Object.keys(fe.tokens), cfg.assets.registered);
  // 部署者、owner、收款地址都不進前端登記。
  assert.doesNotMatch(r.stdout, new RegExp(record(cfg).deployer, "i"));
  assert.doesNotMatch(r.stdout, new RegExp(cfg.roles.treasury, "i"));
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

test("--print-env 印出 DeployTenant 的 dry-run 指令與角色對照，不含任何秘密值、也沒有 --broadcast", () => {
  const cfg = filled();
  const plan = envPlan(cfg);
  assert.match(plan, /TENANT=demo-bank PREFLIGHT_ONLY=true forge script script\/DeployTenant\.s\.sol:DeployTenant --fork-url "\$BASE_SEPOLIA_RPC_URL"/);
  assert.match(plan, /script\/VerifyTenant\.s\.sol:VerifyTenant/);
  assert.match(plan, new RegExp(`admin（部署結束時的 owner）=${cfg.roles.admin}`));
  assert.match(plan, /OI 上限／每邊（USDC）：非 RWA 1000、RWA 500；maxProfitBps=50000/);
  assert.doesNotMatch(plan, /PRIVATE_KEY=/);
  assert.doesNotMatch(plan, /--broadcast/);
  assert.doesNotMatch(plan, /--private-key/);
});

// ── 審查修正（PR #197）─────────────────────────────────────────────────────

test("admin／keeper／guardian／risk 的 6 組配對與 keeper–treasury 全部在檢查清單裡", () => {
  const key = (a, b) => [a, b].sort().join("-");
  const got = new Set(MUST_DIFFER.map(([a, b]) => key(a, b)));
  const roles = ["admin", "keeper", "guardian", "risk"];
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) assert.ok(got.has(key(roles[i], roles[j])), key(roles[i], roles[j]));
  }
  assert.ok(got.has(key("keeper", "treasury")));
  assert.ok(got.has(key("guardian", "marketOperator")));
  assert.ok(got.has(key("guardian", "treasury")));
  assert.ok(got.has(key("admin", "marketOperator")));
  assert.equal(got.size, 10);
});

test("PARAM_RANGES 與 VerifyTenant.s.sol（TenantBase）的常數逐一相同", () => {
  const sol = readFileSync(join(root, "contracts/script/VerifyTenant.s.sol"), "utf8");
  const unit = { minutes: 60, hours: 3600, days: 86400 };
  const c = (name) => {
    const m = new RegExp(`constant ${name}\\s*=\\s*([0-9_]+)\\s*(minutes|hours|days)?\\s*;`).exec(sol);
    assert.ok(m, `VerifyTenant.s.sol 找不到 ${name}`);
    return Number(m[1].replace(/_/g, "")) * (m[2] ? unit[m[2]] : 1);
  };
  assert.deepEqual(PARAM_RANGES, {
    oracleMaxDeviationBps: [c("ORACLE_DEVIATION_BPS_MIN"), c("ORACLE_DEVIATION_BPS_MAX")],
    oracleWindowSeconds: [c("ORACLE_WINDOW_SECONDS_MIN"), c("ORACLE_WINDOW_SECONDS_MAX")],
    oracleWindowDeviationBps: [c("ORACLE_WINDOW_BPS_MIN"), c("ORACLE_WINDOW_BPS_MAX")],
    oiCapNonRwaUsdc: [1, c("MAX_OI_CAP_USDC")],
    oiCapRwaUsdc: [1, c("MAX_OI_CAP_USDC")],
    maxProfitBps: [c("MIN_PROFIT_BPS"), c("MAX_PROFIT_BPS")],
    maxLeverage: [1, c("MAX_TENANT_LEVERAGE")],
    liquidationPenaltyBps: [0, c("MAX_LIQUIDATION_PENALTY_BPS")],
    markPremiumCapBps: [0, c("MAX_MARK_PREMIUM_CAP_BPS")],
    vaultFeeShareBps: [0, c("MAX_VAULT_FEE_SHARE_BPS")],
    vaultRedeemFeeBps: [0, c("MAX_VAULT_REDEEM_FEE_BPS")],
    vaultMinReserveRatioBps: [c("VAULT_MIN_RESERVE_BPS_MIN"), c("VAULT_MIN_RESERVE_BPS_MAX")],
  });
  assert.equal(c("SCHEMA_VERSION"), 3);
});

test("guardian 與 risk 不得是同一個地址", () => {
  const c = filled();
  c.roles.risk = c.roles.guardian;
  assert.match(check(c), /roles\.guardian 與 roles\.risk 是同一個地址/);
});

test("$comment 可以用區塊瀏覽器連結（/tx/0x…）引用 tx hash", () => {
  const c = filled();
  c.$comment = `Phase A 部署交易 https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}，見 broadcast 紀錄。`;
  assert.equal(check(c), "");
});

test("$comment 裡不在 /tx/ 之後的 0x＋64 位十六進位一律擋", () => {
  for (const comment of [
    `Phase A 部署交易 0x${"ab".repeat(32)}，見 broadcast 紀錄。`, // 裸 hash——可能是帶 0x 的私鑰
    `keeper key: 0x${"ef".repeat(32)}`,
    `https://sepolia.basescan.org/address/0x${"ab".repeat(32)}`, // 不是 /tx/
    `/tx/0x${"ab".repeat(32)} 之後又貼了 0x${"cd".repeat(32)}`, // 放行的只有連結裡那一段
  ]) {
    const c = filled();
    c.$comment = comment;
    assert.match(check(c), /\$comment 看起來是私鑰/, comment);
  }
});

test("$comment 裡不帶 0x 的 64 位十六進位仍視為私鑰", () => {
  const c = filled();
  c.$comment = `備忘 ${"cd".repeat(32)}`;
  assert.match(check(c), /\$comment 看起來是私鑰/);
});

test("助記詞在任何欄位（含 $comment）都擋", () => {
  const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const c = filled();
  c.$comment = `keeper 備份：${words}`;
  assert.match(check(c), /\$comment 看起來是助記詞/);
  const d = filled();
  d.keeper.note = `${words} account accuse achieve`;
  assert.match(check(d), /keeper\.note 看起來是助記詞/);
});

test("助記詞偵測：逗號分隔、大寫、字串陣列都擋", () => {
  const list = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
  const cases = {
    逗號: list.join(","),
    逗號加空白: list.join(", "),
    換行與多重空白: list.join(" \n  "),
    首字大寫: list.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    全大寫: list.join(" ").toUpperCase(),
  };
  for (const [name, value] of Object.entries(cases)) {
    const c = filled();
    c.keeper.note = value;
    assert.match(check(c), /keeper\.note 看起來是助記詞/, name);
  }
  const arr = filled();
  arr.keeper.words = list; // 一字一格：每一格單看都無害，join 起來就是助記詞
  assert.match(check(arr), /keeper\.words 看起來是助記詞/);
  const commentArr = filled();
  commentArr.$comment = ["備份", ...list];
  assert.match(check(commentArr), /\$comment 看起來是助記詞/);
});

test("11 個字不算助記詞（下限是 12）", () => {
  const c = filled();
  c.keeper.note = "abandon ability able about above absent absorb abstract absurd abuse access";
  assert.equal(check(c).includes("助記詞"), false);
});

test("assets.registered 滿 12 檔也不會被當成助記詞（每格都必須是已知資產代號）", () => {
  const c = filled();
  // 已知資產只有 11 檔，重複一檔湊成 12 格：會被「重複」擋，但不能被當成助記詞。
  c.assets.registered = [...ctx.symbols, ctx.symbols[0]];
  const out = check(c);
  assert.match(out, /assets\.registered 有重複/);
  assert.equal(out.includes("助記詞"), false, out);
});

test("一般英文說明不會被當成助記詞", () => {
  const c = filled();
  c.$comment = "Placeholder values only. Copy this file, fill in the role addresses, then run the checker.";
  assert.equal(check(c), "");
});

test("已知限制：連續 12 個 3–8 字母單字的英文長句會被誤判為助記詞", () => {
  // 刻意記錄的誤判（docs/TENANT_DEPLOYMENT.md）：寧可擋一句說明，也不放過一組助記詞。
  const c = filled();
  c.$comment = "Keeper runs every fifteen minutes using the shared oracle feed plus its own wallet only";
  assert.match(check(c), /\$comment 看起來是助記詞/);
});

test("frontendTenant 必須與 tenantId 相同", () => {
  const c = filled();
  c.frontendTenant = "default";
  assert.match(check(c), /frontendTenant「default」必須與 tenantId「demo-bank」相同/);
});

test("chainId 只接受允許清單（84532、8453）", () => {
  for (const chainId of [1, 11155111, 31337, "84532"]) {
    const c = filled();
    c.network.chainId = chainId;
    assert.match(check(c), /network\.chainId 必須是 84532 \/ 8453 之一/, String(chainId));
  }
  // 8453 本身是允許的鏈；但平台在 Base 主網還沒有共用元件（結算幣、價格來源），
  // 所以共用元件的白名單是空的，任何值都過不了——要先定義主網的共用元件才能部署。
  const main = filled();
  main.network.chainId = 8453;
  const out = check(main);
  assert.doesNotMatch(out, /network\.chainId 必須是/);
  assert.match(out, /shared\.settlementToken=.* 不是平台在 chain 8453 的 MockUSDC（這條鏈沒有平台的對應元件）/);
  const noRef = filled();
  noRef.network.chainId = 8453;
  noRef.shared.referenceSource = "none";
  assert.match(check(noRef), /Base 主網的 guarded oracle 必須有參考來源/);
});

test("JSON 重複的鍵：設定與紀錄都擋（JSON.parse 取最後一個值，審查者看到的是第一個）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-deploy-dup-"));
  const file = join(dir, "demo-bank.json");
  const text = JSON.stringify(filled(), null, 2).replace(
    `"keeper": "${A(4)}",`,
    `"keeper": "${A(4)}",\n    "keeper": "${A(1)}",`,
  );
  assert.match(text, /"keeper": .*\n.*"keeper": /);
  writeFileSync(file, text);
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /JSON 重複的鍵 roles: keeper/);
});

// ── 前端部署登記 ↔ 部署紀錄 ────────────────────────────────────────────────

/** 把設定（與選用的紀錄）寫進暫存目錄，以指定的前端登記跑 run()。 */
const runWith = ({ cfg, rec, frontend, coverage = false }) => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-deploy-"));
  const files = [join(dir, "demo-bank.json")];
  writeFileSync(files[0], JSON.stringify(cfg));
  if (rec) {
    files.push(join(dir, "demo-bank.deployed.json"));
    writeFileSync(files[1], JSON.stringify(rec));
  }
  const context = { ...ctx, frontendDeployments: frontend };
  return run({ root, files, log: () => {}, coverage, context }).join("\n");
};
const platformReg = { schemaVersion: 1, tenant: "demo-bank", kind: "platform", note: "demo" };

test("前端登記：已部署的租戶，前端必須是 dedicated 而且與部署紀錄完全相同", () => {
  const cfg = deployedCfg();
  const rec = record(cfg);
  const fe = frontendDeployment(rec);
  assert.equal(runWith({ cfg, rec, frontend: { "demo-bank": fe } }), "");

  // 仍指向平台：租戶的站把使用者送進共用的 exchange。
  assert.match(
    runWith({ cfg, rec, frontend: { "demo-bank": platformReg } }),
    /status=deployed，但 frontend\/src\/contracts\/deployments\/demo-bank\.json 的 kind 是 platform/,
  );
  // 抄錯一個位址。
  const wrong = structuredClone(fe);
  wrong.contracts.PerpetualExchange = B(77);
  assert.match(
    runWith({ cfg, rec, frontend: { "demo-bank": wrong } }),
    /與部署紀錄不一致 —— contracts\.PerpetualExchange：前端登記是 0xb+4d，部署紀錄是 /,
  );
  // 沒有登記檔。
  assert.match(runWith({ cfg, rec, frontend: {} }), /前端沒有部署登記 .*demo-bank\.json——這個租戶的 build 會失敗/);
});

test("前端登記：只有 X402FeeRouter 可以是部署紀錄以外的合約；大小寫不同不算不一致", () => {
  const rec = record();
  const fe = frontendDeployment(rec);
  fe.contracts.X402FeeRouter = B(500);
  fe.contracts.PerpetualExchange = fe.contracts.PerpetualExchange.toUpperCase().replace("0X", "0x");
  assert.deepEqual(frontendMismatches(fe, rec), []);
  fe.contracts.Backdoor = B(501);
  delete fe.tokens.sAAPL;
  fe.tokens.sBTC = B(502);
  fe.oracleKind = "mock";
  fe.shared = [];
  const out = frontendMismatches(fe, rec).join("\n");
  assert.match(out, /shared：前端登記是 \[\]，應為 \["contracts\.SettlementToken"\]/);
  assert.match(out, /contracts\.Backdoor：部署紀錄裡沒有這個合約/);
  assert.match(out, /tokens\.sAAPL：前端登記是 （沒有）/);
  assert.match(out, /tokens\.sBTC：部署紀錄裡沒有這個代幣/);
  assert.match(out, /oracleKind：前端登記是 "mock"，部署紀錄是 "guarded"/);
});

test("前端登記：還沒部署的租戶不能先登記成 dedicated；dedicated 一定要有已部署的設定", () => {
  const fe = frontendDeployment(record());
  assert.match(
    runWith({ cfg: filled(), frontend: { "demo-bank": fe } }),
    /status=ready（尚未部署），但 .*demo-bank\.json 已經是 dedicated/,
  );
  assert.equal(runWith({ cfg: filled(), frontend: { "demo-bank": platformReg } }), "");
  // 整個目錄的檢查：前端有一份 dedicated，deploy/tenants 卻沒有它。
  const ghost = { ...fe, tenant: "ghost-bank" };
  assert.match(
    runWith({ cfg: filled(), frontend: { "demo-bank": platformReg, "ghost-bank": ghost }, coverage: true }),
    /deployments\/ghost-bank\.json: kind=dedicated，但 deploy\/tenants\/ 沒有 status=deployed 的 ghost-bank\.json/,
  );
});

// ── 複審 A2：平台的角色 EOA ─────────────────────────────────────────────────
// 平台合約的 owner 寫在 contracts/script/Verify130.s.sol（DEPLOYER_OWNER）；DEFAULT_ADMIN／
// GUARDIAN／PAUSER／RISK／KEEPER 寫在 docs/ROLE_SEPARATION.md 的角色表。位址從檔案讀出，不是手抄。
const roleSeparationAddresses = () => {
  const md = readFileSync(join(root, "docs/ROLE_SEPARATION.md"), "utf8");
  const rows = md
    .split(/\r?\n/)
    .filter((l) => /^\|\s*`(DEFAULT_ADMIN_ROLE|KEEPER_ROLE|GUARDIAN_ROLE|PAUSER_ROLE|RISK_ROLE)`/.test(l));
  assert.ok(rows.length >= 5, "docs/ROLE_SEPARATION.md 的角色表少於 5 列？");
  return rows.map((l) => /0x[0-9a-fA-F]{40}/.exec(l)[0]);
};
const verify130Owner = () => {
  const sol = readFileSync(join(root, "contracts/script/Verify130.s.sol"), "utf8");
  const m = /address internal constant DEPLOYER_OWNER\s*=\s*(0x[0-9a-fA-F]{40})/.exec(sol);
  assert.ok(m, "Verify130.s.sol 找不到 DEPLOYER_OWNER");
  return m[1];
};

test("平台角色 EOA（Verify130 的 owner、ROLE_SEPARATION 角色表）不得作為租戶的任何角色", () => {
  for (const addr of [verify130Owner(), ...roleSeparationAddresses()]) {
    assert.ok(ctx.universe.has(addr.toLowerCase()), `${addr} 不在平台位址全集`);
    for (const role of ["admin", "risk", "guardian", "keeper", "marketOperator", "treasury"]) {
      const c = filled();
      c.roles[role] = addr;
      assert.match(check(c), new RegExp(`roles\\.${role}=${addr} 是現行正式站（平台）用過的位址`), `${role}=${addr}`);
    }
  }
});

test("平台角色 EOA 不得作為租戶的部署者", () => {
  for (const addr of [verify130Owner(), ...roleSeparationAddresses()]) {
    const r = record();
    r.deployer = addr;
    assert.match(checkRec(r), new RegExp(`deployer=${addr} 是現行正式站（平台）用過的位址`), addr);
  }
});

test("Anvil 預設帳號（私鑰公開）不得作為租戶角色或部署者", () => {
  const anvil0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const c = filled();
  c.roles.admin = anvil0;
  assert.match(check(c), /roles\.admin=0xf39F.* 是 Anvil 預設帳號 #0/);
  const r = record();
  r.deployer = anvil0;
  assert.match(checkRec(r), /deployer=0xf39F.* 是 Anvil 預設帳號 #0/);
});

test("全集改為掃描整個 repo 後，demo-bank（kind: platform）與 repo 內現有設定仍通過", () => {
  assert.equal(ctx.frontendDeployments["demo-bank"].kind, "platform");
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("部署紀錄：deployBlock 必填、必須是非負整數（VerifyTenant 從這裡起掃角色事件）", () => {
  assert.equal(checkRec(record()), "");
  for (const v of [undefined, null, -1, 1.5, "123", 2 ** 60]) {
    const r = record();
    if (v === undefined) delete r.deployBlock;
    else r.deployBlock = v;
    assert.match(checkRec(r), /deployBlock=.* 必須是非負整數/, String(v));
  }
});

// ── 租戶目錄：docs/tenants/<id>/、contracts/broadcast/tenants/<id>/ ─────────────

const C = (n) => `0x${n.toString(16).padStart(40, "c")}`;
const runJson = (...created) =>
  JSON.stringify({
    transactions: created.map((a) => ({ transactionType: "CREATE", contractAddress: a, additionalContracts: [] })),
  });
const dirs = (entries, configIds = ["demo-bank"], records = {}) =>
  checkTenantDirs({ entries, configIds: new Set(configIds), universe: ctx.universe, records }).problems.join("\n");

test("租戶目錄：目錄直下的檔案、default、不是 slug 的 id 都報錯", () => {
  assert.match(dirs([{ rel: "docs/tenants/a.md", text: "" }]), /直下不可放檔案/);
  assert.match(dirs([{ rel: "contracts/broadcast/tenants/run-latest.json", text: "{}" }]), /直下不可放檔案/);
  // 把平台位址藏進 docs/tenants/default/：不排除（仍在全集），而且報錯。
  assert.match(dirs([{ rel: "docs/tenants/default/WALLETS.md", text: live.MockUSDC }]), /不是合格的租戶 id/);
  assert.match(dirs([{ rel: "docs/tenants/Bank_A/x.md", text: "" }]), /不是合格的租戶 id/);
  assert.equal(dirs([{ rel: "docs/tenants/demo-bank/WALLETS.md", text: C(1) }]), "");
});

test("租戶目錄：廣播紀錄必須有部署設定；沒有設定時 docs 只能放 .md", () => {
  assert.match(
    dirs([{ rel: "contracts/broadcast/tenants/ghost/DeployTenant.s.sol/84532/run-latest.json", text: runJson() }]),
    /deploy\/tenants\/ghost\.json 不存在/,
  );
  assert.equal(dirs([{ rel: "docs/tenants/ghost/WALLETS.md", text: C(2) }]), "");
  assert.match(dirs([{ rel: "docs/tenants/ghost/wallets.json", text: "{}" }]), /只能放 \.md/);
});

test("租戶目錄：廣播建立的合約必須在部署紀錄或租戶文件裡", () => {
  const rel = "contracts/broadcast/tenants/demo-bank/DeploySessionCredentialAnchor.s.sol/84532/run-latest.json";
  assert.match(dirs([{ rel, text: runJson(C(3)) }]), /建立的合約 0x.* 不在 deploy\/tenants\/demo-bank\.deployed\.json/);
  // 寫在文件裡（例如部署腳本以外的 Anchor）就可以。
  assert.equal(dirs([{ rel, text: runJson(C(3)) }, { rel: "docs/tenants/demo-bank/DEPLOYMENT.md", text: `Anchor ${C(3)}` }]), "");
  // 在部署紀錄裡也可以。
  assert.equal(dirs([{ rel, text: runJson(C(3)) }], ["demo-bank"], { "demo-bank": { contracts: { X: C(3) } } }), "");
  // 別的租戶的文件不算。
  assert.match(
    dirs([{ rel, text: runJson(C(3)) }, { rel: "docs/tenants/other/DEPLOYMENT.md", text: C(3) }]),
    /不在 deploy\/tenants\/demo-bank\.deployed\.json/,
  );
  // dry-run 不檢查；壞掉的 JSON 報錯。
  assert.equal(dirs([{ rel: rel.replace("84532/", "84532/dry-run/"), text: runJson(C(4)) }]), "");
  assert.match(dirs([{ rel, text: "{" }]), /不是合法的 forge 廣播紀錄/);
});

test("租戶目錄：文件與廣播裡的位址併入該租戶做跨租戶比對", () => {
  const cfg = filled();
  const run1 = (entries) => {
    const dir = mkdtempSync(join(tmpdir(), "tenant-dirs-"));
    const file = join(dir, "demo-bank.json");
    writeFileSync(file, JSON.stringify(cfg));
    const context = { ...ctx, frontendDeployments: { "demo-bank": platformReg }, tenantDirEntries: entries };
    return run({ root, files: [file], log: () => {}, coverage: true, context }).join("\n");
  };
  assert.equal(run1([{ rel: "docs/tenants/demo-bank/WALLETS.md", text: cfg.roles.keeper }]), "");
  // 另一個租戶的文件寫了 demo-bank 的 keeper：兩個租戶共用金鑰。
  assert.match(run1([{ rel: "docs/tenants/other/WALLETS.md", text: cfg.roles.keeper }]), /租戶之間不得共用/);
  // 廣播紀錄裡的合約一樣算（other 沒有設定，另外報錯）。
  assert.match(
    run1([{ rel: "contracts/broadcast/tenants/other/X.s.sol/84532/run-latest.json", text: runJson(cfg.roles.admin) }]),
    /租戶之間不得共用/,
  );
  // 平台位址與白名單不算進租戶。
  assert.equal(run1([{ rel: "docs/tenants/other/NOTES.md", text: live.MockUSDC }]), "");
});
