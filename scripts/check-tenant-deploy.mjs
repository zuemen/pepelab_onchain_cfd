#!/usr/bin/env node
// 租戶部署設定檢查（deploy/tenants/*.json）。**只讀、不送任何交易、不讀任何秘密**。
//
// 為什麼存在：每個白標租戶一套 vault＋保險金＋keeper＋金鑰與收款地址
// （docs/ADR-008-tenant-isolation.md）。部署一個新租戶時最容易出的錯不是合約，而是
// 參數：把正式站的 exchange 位址抄進新租戶、keeper 與 admin 用同一把鑰匙、把私鑰或帶
// API key 的 RPC 網址貼進設定檔、前端白名單開了一檔金庫根本沒註冊的資產。這支腳本在
// 任何 broadcast 之前把這些擋下來。
//
// 零依賴（只用 node 內建模組），CI 不需要 npm install。沿用 check-addresses.mjs 的
// 前端設定解析，位址的唯一真相仍是 frontend/src/contracts/addresses.ts。
//
// 用法：
//   node scripts/check-tenant-deploy.mjs                       # 檢查 deploy/tenants/ 全部
//   node scripts/check-tenant-deploy.mjs deploy/tenants/x.json # 只檢查指定檔案
//   node scripts/check-tenant-deploy.mjs --print-env deploy/tenants/x.json
//        印出既有部署腳本要的「位址類」環境變數對照（不含任何秘密），給人工核對與 dry-run。
//
// 結束碼：0 通過；1 有問題；2 檢查本身中止（檔案讀不到等）。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadChains } from "./check-addresses.mjs";

const ADDR_EXACT = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** 64 位十六進位（可帶 0x）＝私鑰的形狀。設定檔裡任何地方出現都視為外洩。 */
const PRIVKEY_SHAPE = /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/;
/** 鍵名看起來是秘密的欄位，只允許出現在 secretsEnv 底下（而且值只能是環境變數名稱）。 */
const SECRET_KEY_NAME = /private|mnemonic|secret|seed|password|api_?key|auth_?token|access_?token/i;

export const STATUSES = ["template", "ready", "deployed"];
export const ROLE_KEYS = ["admin", "risk", "guardian", "keeper", "marketOperator", "treasury"];
export const SECRET_ENV_KEYS = ["deployerPrivateKey", "keeperPrivateKey", "rpcUrl"];
export const SHARED_KEYS = ["settlementToken", "priceSource"];
export const DEPLOYED_KEYS = [
  "GuardedOracle",
  "AssetVaultV2",
  "InsuranceVault",
  "FeeRouter",
  "PerpetualExchange",
  "AgentSessionManager",
  "ESGRegistryV2",
];
/** 這幾組角色必須是不同的地址（docs/DEPLOY_129_CUTOVER.md、docs/KEY_MANAGEMENT.md）。 */
export const MUST_DIFFER = [
  ["admin", "keeper"],
  ["admin", "guardian"],
  ["admin", "risk"],
  ["keeper", "guardian"],
  ["keeper", "risk"],
  ["keeper", "treasury"],
];

const TOP_KEYS = [
  "$comment",
  "schemaVersion",
  "tenantId",
  "status",
  "frontendTenant",
  "network",
  "secretsEnv",
  "roles",
  "shared",
  "assets",
  "fees",
  "keeper",
  "deployed",
];

// ── 讀前端設定 ───────────────────────────────────────────────────────────

/** addresses.ts 的 ASSET_IDS 鍵（資產代號）。 */
export function parseAssetSymbols(addressesSrc) {
  const i = addressesSrc.indexOf("export const ASSET_IDS = {");
  if (i < 0) throw new Error("addresses.ts：找不到 ASSET_IDS");
  // 值帶著 `as \`0x${string}\`` 型別註記（裡面有 `}`），所以找的是區塊結尾的 `} as const`。
  const end = addressesSrc.indexOf("} as const", i);
  if (end < 0) throw new Error("addresses.ts：ASSET_IDS 區塊沒有以 } as const 結尾");
  const body = addressesSrc.slice(i, end);
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*"0x[0-9a-fA-F]{64}"/gm)].map((m) => m[1]);
}

// ── 單檔檢查 ─────────────────────────────────────────────────────────────

const isPlaceholder = (v) => typeof v === "string" && /^<[A-Z0-9_]+>$/.test(v);

/** 走訪整份 JSON，回傳 [路徑, 鍵名, 值]。 */
function walk(node, path = []) {
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => [[path.concat(k), k, v], ...walk(v, path.concat(k))]);
  }
  return [];
}

/**
 * 檢查一份租戶部署設定。
 * ctx: { symbols, frontendTenants: {id: config}, productionAddrs: Set<lowercase> }
 * 回傳 { problems: string[], addrs: Map<lowercase addr, path> }（addrs 給跨租戶比對用）。
 */
export function checkTenantDeploy({ file, cfg, ctx }) {
  const problems = [];
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  const addrs = new Map();

  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    bad("不是 JSON 物件");
    return { problems, addrs };
  }

  const status = cfg.status;
  if (!STATUSES.includes(status)) bad(`status 必須是 ${STATUSES.join(" / ")}，目前是 ${JSON.stringify(status)}`);
  const strict = status === "ready" || status === "deployed";

  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) bad(`未知欄位 ${k}（打錯字？）`);
  if (cfg.schemaVersion !== 1) bad("schemaVersion 必須是 1");

  // ── 秘密不得進設定檔 ──
  for (const [path, key, value] of walk(cfg)) {
    const where = path.join(".");
    if (typeof value === "string" && PRIVKEY_SHAPE.test(value)) {
      bad(`${where} 看起來是私鑰（64 位十六進位）——私鑰只能放在 secret store，設定檔只寫環境變數名稱`);
    }
    if (path[0] !== "$comment" && typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      bad(`${where} 是網址——RPC／API 網址常帶金鑰，一律放 secret store，設定檔只寫環境變數名稱`);
    }
    if (path[0] !== "secretsEnv" && path[0] !== "$comment" && SECRET_KEY_NAME.test(key)) {
      bad(`${where}：看起來是秘密的欄位只能放在 secretsEnv 底下`);
    }
  }

  // ── id 與前端租戶 ──
  const fname = basename(file, ".json");
  const isTemplateFile = fname.startsWith("_");
  if (isTemplateFile) {
    if (status !== "template") bad("以 _ 開頭的檔案是範本，status 必須是 template");
  } else {
    if (typeof cfg.tenantId !== "string" || !SLUG.test(cfg.tenantId)) bad("tenantId 必須是小寫英數與連字號");
    else if (cfg.tenantId !== fname) bad(`tenantId「${cfg.tenantId}」與檔名「${fname}」不一致`);
    if (cfg.tenantId === "default") bad("default 是現行正式站，不是用這份設定部署的新租戶");
  }

  let frontendAssets = null;
  if (!isTemplateFile) {
    const fe = ctx.frontendTenants[cfg.frontendTenant];
    if (!fe) {
      bad(`frontendTenant「${cfg.frontendTenant}」在 frontend/src/tenant/tenants/ 找不到對應設定`);
    } else {
      frontendAssets = fe.assets?.enabled === "all" ? ctx.symbols : fe.assets?.enabled ?? [];
    }
  }

  // ── network ──
  if (!Number.isInteger(cfg.network?.chainId) || cfg.network.chainId <= 0) bad("network.chainId 必須是正整數");

  // ── secretsEnv：只收環境變數名稱 ──
  for (const k of SECRET_ENV_KEYS) {
    const v = cfg.secretsEnv?.[k];
    if (typeof v !== "string" || !ENV_NAME.test(v)) bad(`secretsEnv.${k} 必須是環境變數名稱（大寫、數字、底線），不是值`);
  }
  for (const k of Object.keys(cfg.secretsEnv ?? {})) if (!SECRET_ENV_KEYS.includes(k)) bad(`secretsEnv 未知欄位 ${k}`);
  if (!isTemplateFile && cfg.secretsEnv?.deployerPrivateKey === cfg.secretsEnv?.keeperPrivateKey) {
    bad("secretsEnv：部署者與 keeper 必須是不同的金鑰");
  }

  // ── 位址欄位 ──
  const addrField = (path, value, { dedicated }) => {
    if (value === null || value === undefined) {
      bad(`${path} 未填`);
      return;
    }
    if (isPlaceholder(value)) {
      if (strict) bad(`${path} 仍是佔位值 ${value}（status=${status} 不允許）`);
      return;
    }
    if (typeof value !== "string" || !ADDR_EXACT.test(value)) {
      bad(`${path}=${JSON.stringify(value)} 不是位址`);
      return;
    }
    if (value.toLowerCase() === ZERO) {
      bad(`${path} 是零位址`);
      return;
    }
    if (dedicated) {
      if (ctx.productionAddrs.has(value.toLowerCase())) {
        bad(`${path}=${value} 是現行正式站（addresses.ts）的位址——租戶專屬的角色與合約不得與正式站共用`);
      }
      addrs.set(value.toLowerCase(), path);
    }
  };

  for (const k of ROLE_KEYS) addrField(`roles.${k}`, cfg.roles?.[k], { dedicated: true });
  for (const k of Object.keys(cfg.roles ?? {})) if (!ROLE_KEYS.includes(k)) bad(`roles 未知欄位 ${k}`);
  for (const [a, b] of MUST_DIFFER) {
    const va = cfg.roles?.[a];
    const vb = cfg.roles?.[b];
    if (typeof va === "string" && typeof vb === "string" && !isPlaceholder(va) && va.toLowerCase() === vb.toLowerCase()) {
      bad(`roles.${a} 與 roles.${b} 是同一個地址——這兩個角色必須分開`);
    }
  }

  for (const k of SHARED_KEYS) addrField(`shared.${k}`, cfg.shared?.[k], { dedicated: false });
  for (const k of Object.keys(cfg.shared ?? {})) if (!SHARED_KEYS.includes(k)) bad(`shared 未知欄位 ${k}`);

  // ── 資產 ──
  const reg = cfg.assets?.registered;
  if (!Array.isArray(reg) || reg.length === 0) bad("assets.registered 必須是非空陣列");
  else {
    if (new Set(reg).size !== reg.length) bad("assets.registered 有重複");
    for (const s of reg) if (!ctx.symbols.includes(s)) bad(`assets.registered：${s} 不是 addresses.ts 已知資產`);
    if (frontendAssets) {
      const missing = frontendAssets.filter((s) => !reg.includes(s));
      if (missing.length) {
        bad(`前端租戶「${cfg.frontendTenant}」白名單開了金庫沒註冊的資產：${missing.join(", ")}`);
      }
    }
  }

  // ── 費率：base fee + 租戶 markup，數字待決 ──
  const fees = cfg.fees ?? {};
  if (fees.status === "pending-decision") {
    if (fees.baseFeeBps !== null || fees.tenantMarkupBps !== null) {
      bad("fees.status=pending-decision 時 baseFeeBps / tenantMarkupBps 必須是 null（數字尚未決定）");
    }
    if (status === "deployed") bad("fees 仍是 pending-decision，不能標成 deployed");
  } else if (fees.status === "decided") {
    for (const k of ["baseFeeBps", "tenantMarkupBps"]) {
      if (!Number.isInteger(fees[k]) || fees[k] < 0 || fees[k] > 10000) bad(`fees.${k} 必須是 0–10000 的整數 bps`);
    }
  } else {
    bad("fees.status 必須是 pending-decision 或 decided");
  }

  // ── keeper ──
  if (typeof cfg.keeper?.cron !== "string" || cfg.keeper.cron.trim().split(/\s+/).length !== 5) {
    bad("keeper.cron 必須是 5 欄的 cron 字串");
  }

  // ── 已部署合約 ──
  for (const k of DEPLOYED_KEYS) {
    const v = cfg.deployed?.[k];
    if (status === "deployed") addrField(`deployed.${k}`, v, { dedicated: true });
    else if (v !== null) bad(`deployed.${k}：status=${status} 時必須是 null（還沒部署）`);
  }
  for (const k of Object.keys(cfg.deployed ?? {})) if (!DEPLOYED_KEYS.includes(k)) bad(`deployed 未知欄位 ${k}`);

  return { problems, addrs };
}

/** 跨租戶：任何兩個租戶不得共用專屬的角色或合約地址。 */
export function checkCrossTenant(results) {
  const problems = [];
  const owner = new Map();
  for (const { file, addrs } of results) {
    for (const [addr, path] of addrs) {
      const prev = owner.get(addr);
      if (prev && prev.file !== file) {
        problems.push(`${file}: ${path}=${addr} 與 ${prev.file} 的 ${prev.path} 相同——租戶之間不得共用金鑰或合約`);
      } else if (!prev) owner.set(addr, { file, path });
    }
  }
  return problems;
}

// ── 既有部署腳本的環境變數對照（只有位址，沒有秘密）──────────────────────

export function envPlan(cfg) {
  const r = cfg.roles ?? {};
  const s = cfg.shared ?? {};
  return [
    "# 以下只是對照，不會執行任何東西。秘密（私鑰、RPC）請從 secret store 以",
    `# ${cfg.secretsEnv?.deployerPrivateKey ?? "<DEPLOYER_KEY_ENV>"} / ${cfg.secretsEnv?.rpcUrl ?? "<RPC_ENV>"} 帶入，不要寫進任何檔案。`,
    "",
    "# Phase A — contracts/script/DeployHardenedVault129.s.sol（先不加 --broadcast 做模擬）",
    `MOCKUSDC_ADDR=${s.settlementToken}`,
    `MOCKORACLE_ADDR=${s.priceSource}`,
    `ADMIN_ADDRESS=${r.admin}`,
    `KEEPER_ADDRESS=${r.keeper}`,
    `GUARDIAN_ADDRESS=${r.guardian}`,
    `RISK_ADDRESS=${r.risk}`,
    "",
    "# 角色移交 — contracts/script/HandoverRoles.s.sol（HANDOVER_DRY_RUN 預設就是 true）",
    `NEW_ADMIN=${r.admin}`,
    `NEW_KEEPER=${r.keeper}`,
    `NEW_GUARDIAN=${r.guardian}`,
    `NEW_RISK=${r.risk}`,
    "HANDOVER_DRY_RUN=true",
    "",
    "# 收費路由 — contracts/script/DeployX402Router.s.sol",
    `TREASURY=${r.treasury}`,
    "",
    "# 永續交易所（Redeploy129Exchange.s.sol）目前把 USDC／oracle／FeeRouter 等寫成常數，",
    "# 尚未參數化，不能直接用於新租戶——見 docs/TENANT_DEPLOYMENT.md「已知缺口」。",
    `# marketOperator（上線後由 owner 呼叫 setMarketOperator）=${r.marketOperator}`,
    `# assets.registered=${(cfg.assets?.registered ?? []).join(",")}`,
  ].join("\n");
}

// ── main ────────────────────────────────────────────────────────────────

export function loadContext(root) {
  const addressesFile = join(root, "frontend/src/contracts/addresses.ts");
  const symbols = parseAssetSymbols(readFileSync(addressesFile, "utf8"));
  const chains = loadChains({
    addressesFile,
    sessionFile: join(root, "frontend/src/contracts/sessionManager.ts"),
    x402File: join(root, "frontend/src/contracts/x402.ts"),
  });
  const productionAddrs = new Set(Object.values(chains).flatMap((c) => [...c.known]));
  const feDir = join(root, "frontend/src/tenant/tenants");
  const frontendTenants = Object.fromEntries(
    readdirSync(feDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [basename(f, ".json"), JSON.parse(readFileSync(join(feDir, f), "utf8"))]),
  );
  return { symbols, productionAddrs, frontendTenants };
}

export function run({ root, files, log = console.log }) {
  const ctx = loadContext(root);
  const results = files.map((file) => {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { file, problems: [`${file}: 不是合法 JSON：${e.message}`], addrs: new Map() };
    }
    return { file, ...checkTenantDeploy({ file, cfg, ctx }) };
  });
  const problems = results.flatMap((r) => r.problems).concat(checkCrossTenant(results));
  log(`檢查 ${files.length} 份租戶部署設定（已知資產 ${ctx.symbols.length} 檔、正式站位址 ${ctx.productionAddrs.size} 個）`);
  if (problems.length) {
    for (const p of problems) log(`::error::${p}`);
    log(`\n${problems.length} 個問題`);
  } else {
    log("租戶部署設定檢查通過 ✓");
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);

  const p = args.indexOf("--print-env");
  if (p >= 0) {
    const file = resolve(args[p + 1] ?? "");
    const problems = run({ root, files: [file], log: (m) => console.error(m) });
    if (problems.length) process.exit(1);
    console.log(envPlan(JSON.parse(readFileSync(file, "utf8"))));
    process.exit(0);
  }

  const dir = join(root, "deploy/tenants");
  const files = args.length
    ? args.map((a) => resolve(a))
    : existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)).sort()
      : [];
  if (files.length === 0) {
    console.error("::error::沒有任何租戶部署設定可以檢查（deploy/tenants/*.json）");
    process.exit(2);
  }
  process.exit(run({ root, files }).length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`::error::check-tenant-deploy 中止：${e.message}`);
    process.exit(2);
  }
}
