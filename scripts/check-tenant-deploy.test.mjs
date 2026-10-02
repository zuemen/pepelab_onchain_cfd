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
  RECORD_CONTRACT_KEYS,
  checkCrossTenant,
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

// 一組看起來合法、且不在 addresses.ts 裡的測試位址。
const A = (n) => `0x${n.toString(16).padStart(40, "a")}`;
const filled = () => {
  const c = structuredClone(demo);
  c.status = "ready";
  c.roles = { admin: A(1), risk: A(2), guardian: A(3), keeper: A(4), marketOperator: A(5), treasury: A(6) };
  c.shared = { settlementToken: A(7), priceSource: A(8) };
  c.params = { oracleKind: "guarded", oiCapNonRwaUsdc: 1000, oiCapRwaUsdc: 500, maxProfitBps: 50000, deployVault: true };
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

test("設定檔沒有放已部署位址的欄位（v2：位址只在 <id>.deployed.json）", () => {
  const c = filled();
  c.deployed = { PerpetualExchange: A(20) };
  assert.match(check(c), /未知欄位 deployed/);
  const old = filled();
  old.schemaVersion = 1;
  assert.match(check(old), /schemaVersion 必須是 2/);
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

test("params：ready 以上必須填上限，而且不能是 0（合約上 0＝不設上限）", () => {
  for (const k of ["oiCapNonRwaUsdc", "oiCapRwaUsdc"]) {
    const c = filled();
    c.params[k] = null;
    assert.match(check(c), new RegExp(`params\\.${k} 未填`), k);
    for (const bad of [0, -5, 1.5, "1000"]) {
      const d = filled();
      d.params[k] = bad;
      assert.match(check(d), new RegExp(`params\\.${k} 必須是正整數`), `${k}=${bad}`);
    }
  }
  const t = structuredClone(demo);
  assert.equal(check(t), "", "template 可以留 null");
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
  const m = filled();
  m.params.oracleKind = "mock";
  assert.match(check(m), /deployVault=true 需要 oracleKind=guarded/);
  m.params.deployVault = false;
  assert.equal(check(m), "");
  m.network.chainId = 8453;
  assert.match(check(m), /oracleKind=mock 不得用於 Base 主網/);
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
  const chains = ctx.productionAddrs;
  const prod = [...chains][0];
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
  assert.equal(got.size, 9);
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
  const ok = filled();
  ok.network.chainId = 8453;
  assert.equal(check(ok), "");
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
  const out = frontendMismatches(fe, rec).join("\n");
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
