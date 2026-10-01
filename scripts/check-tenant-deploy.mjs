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
//        印出 DeployTenant.s.sol 的 dry-run／驗證指令與這份設定的角色對照（不含任何秘密）。
//   node scripts/check-tenant-deploy.mjs --print-frontend deploy/tenants/x.deployed.json
//        由部署紀錄印出前端部署登記（frontend/src/contracts/deployments/<id>.json）的內容。
//
// 一個租戶在這個目錄最多兩個檔：
//   <id>.json           部署設定（人寫）：角色、共用元件、上限、資產。DeployTenant.s.sol 的輸入。
//   <id>.deployed.json  部署紀錄（DeployTenant.s.sol 廣播後寫出、人工複製進來）：整組合約位址。
// 兩者必須同時成立：有紀錄 ⇔ 設定的 status 是 deployed。
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
/**
 * 64 位十六進位＝私鑰的形狀。帶不帶 0x 都擋——設定檔的值裡不該出現任何 32-byte 十六進位。
 *
 * `$comment` 唯一的例外：**緊接在 `/tx/` 之後**的 `0x`＋64 位（區塊瀏覽器的交易連結，
 * 例如 `https://sepolia.basescan.org/tx/0x…`）。檢查前先把這種連結裡的 hash 拿掉，剩下的
 * 照一般規則擋。舊規則是「註解裡帶 0x 的一律放行」，代價是帶 0x 的私鑰貼進註解會漏擋；
 * 要引用部署交易請貼完整的 explorer 連結。
 */
const HEX64_ANY = /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/;
const EXPLORER_TX_HASH = /\/tx\/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
/**
 * BIP-39 助記詞的形狀：連續 12 個以上、每個 3–8 個英文字母的單字，以空白或逗號分隔
 * （12/15/18/21/24 字的助記詞都落在這個範圍）。大小寫不敏感——「Abandon Ability …」或
 * 「abandon,ability,…」一樣擋。所有欄位含 `$comment` 都檢查；字串陣列會先以空白 join
 * 再測（把助記詞拆成一字一格的陣列也擋得到）。
 *
 * 一般英文句子多半會被標點、a/to/of 這類短字或 9 個字母以上的長字打斷，但**不保證**：
 * 連續 12 個 3–8 字母的單字組成的長句會被誤判（見 docs/TENANT_DEPLOYMENT.md）。
 * 寧可誤擋一句說明，也不放過一組助記詞。
 */
const MNEMONIC_SHAPE = /(^|[^a-z])([a-z]{3,8}[\s,]+){11,}[a-z]{3,8}([^a-z]|$)/i;
/**
 * 不做陣列 join 助記詞檢查的路徑。assets.registered 是資產代號（sAAPL、sGOLD…，全是
 * 字母、長度 4–6），註冊滿 12 檔就會湊成「12 個單字」；而它的每一格都另外必須是
 * addresses.ts 已知的資產代號（下面的資產檢查），塞不進任何別的東西。
 */
const ARRAY_JOIN_EXEMPT = new Set(["assets.registered"]);
/** 允許部署的鏈：Base Sepolia（現行測試網）與 Base 主網（ADR-008 的目標鏈）。 */
export const ALLOWED_CHAIN_IDS = [84532, 8453];
/** 鍵名看起來是秘密的欄位，只允許出現在 secretsEnv 底下（而且值只能是環境變數名稱）。 */
const SECRET_KEY_NAME = /private|mnemonic|secret|seed|password|api_?key|auth_?token|access_?token/i;

export const STATUSES = ["template", "ready", "deployed"];
export const ROLE_KEYS = ["admin", "risk", "guardian", "keeper", "marketOperator", "treasury"];
export const SECRET_ENV_KEYS = ["deployerPrivateKey", "keeperPrivateKey", "rpcUrl"];
export const SHARED_KEYS = ["settlementToken", "priceSource"];
export const PARAM_KEYS = ["oracleKind", "oiCapNonRwaUsdc", "oiCapRwaUsdc", "maxProfitBps", "deployVault"];
export const ORACLE_KINDS = ["guarded", "mock"];
/** 與 PerpetualExchange 的 MIN_PROFIT_CAP_BPS / MAX_PROFIT_CAP_BPS 相同（DeployTenant 也會擋）。 */
export const PROFIT_BPS_RANGE = [10_000, 250_000];
/** 部署紀錄（<id>.deployed.json）的 contracts 鍵——DeployTenant.s.sol `_recordJson` 寫出的那一組。 */
export const RECORD_CONTRACT_KEYS = [
  "Oracle",
  "ESGRegistryV2",
  "KYCRegistry",
  "InsuranceVault",
  "FeeRouter",
  "TraderStake",
  "PerpetualExchange",
  "StrategyRegistry",
  "CopyTracker",
  "AgentSessionManager",
  "AssetVaultV2",
  "AssetVaultV2Impl",
];
/** 只有 params.deployVault 為 true 時才存在；否則紀錄裡是零位址。 */
export const VAULT_RECORD_KEYS = ["AssetVaultV2", "AssetVaultV2Impl"];
const RECORD_TOP_KEYS = [
  "schemaVersion",
  "tenantId",
  "chainId",
  "mode",
  "oracleKind",
  "deployer",
  "owner",
  "settlementToken",
  "treasury",
  "contracts",
  "tokens",
];
const RECORD_SUFFIX = ".deployed.json";
export const isRecordFile = (file) => basename(file).endsWith(RECORD_SUFFIX);
/**
 * 這幾組角色必須是不同的地址（docs/DEPLOY_129_CUTOVER.md、docs/KEY_MANAGEMENT.md）：
 * admin／keeper／guardian／risk 四個兩兩不同（6 組），加上 keeper 不兼 treasury、
 * guardian 不兼 marketOperator 也不兼 treasury（marketOperator 可以就是 keeper，正式站如此）。
 * 由清單產生，不手寫配對——手寫曾漏掉 guardian–risk。
 */
const SEPARATED_ROLES = ["admin", "keeper", "guardian", "risk"];
export const MUST_DIFFER = [
  ...SEPARATED_ROLES.flatMap((a, i) => SEPARATED_ROLES.slice(i + 1).map((b) => [a, b])),
  ["keeper", "treasury"],
  // DeployTenant.s.sol 的 preflight 也擋這兩組；在這裡先擋，問題就不會等到 forge 才出現。
  // guardian 兼 marketOperator：一把鑰匙同時能暫停與切換市場。熱錢包不收款。
  ["guardian", "marketOperator"],
  ["guardian", "treasury"],
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
  "params",
  "assets",
  "fees",
  "keeper",
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
  if (cfg.schemaVersion !== 2) bad("schemaVersion 必須是 2（v2：新增 params、已部署位址改放 <id>.deployed.json）");

  // ── 秘密不得進設定檔 ──
  for (const [path, key, value] of walk(cfg)) {
    const where = path.join(".");
    const isComment = path[0] === "$comment";
    const hexProbe = typeof value === "string" && isComment ? value.replace(EXPLORER_TX_HASH, "/tx/") : value;
    if (typeof hexProbe === "string" && HEX64_ANY.test(hexProbe)) {
      bad(
        isComment
          ? `${where} 看起來是私鑰（64 位十六進位）——註解只能以區塊瀏覽器連結（…/tx/0x…）引用交易 hash`
          : `${where} 看起來是私鑰（64 位十六進位）——私鑰只能放在 secret store，設定檔只寫環境變數名稱`,
      );
    }
    const wordProbe =
      typeof value === "string"
        ? value
        : Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") && !ARRAY_JOIN_EXEMPT.has(where)
          ? value.join(" ")
          : null;
    if (wordProbe !== null && MNEMONIC_SHAPE.test(wordProbe)) {
      bad(`${where} 看起來是助記詞（連續 12 個以上的英文單字）——助記詞只能放在 secret store`);
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
    if (cfg.frontendTenant !== cfg.tenantId) {
      bad(`frontendTenant「${cfg.frontendTenant}」必須與 tenantId「${cfg.tenantId}」相同——一個租戶的前端與部署設定用同一個 id`);
    }
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
  if (!ALLOWED_CHAIN_IDS.includes(cfg.network?.chainId)) {
    bad(`network.chainId 必須是 ${ALLOWED_CHAIN_IDS.join(" / ")} 之一，目前是 ${JSON.stringify(cfg.network?.chainId)}`);
  }

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

  // ── 部署參數（DeployTenant.s.sol 的輸入）──
  const prm = cfg.params ?? {};
  for (const k of Object.keys(prm)) if (!PARAM_KEYS.includes(k)) bad(`params 未知欄位 ${k}`);
  if (!ORACLE_KINDS.includes(prm.oracleKind)) bad(`params.oracleKind 必須是 ${ORACLE_KINDS.join(" / ")}`);
  if (typeof prm.deployVault !== "boolean") bad("params.deployVault 必須是 true 或 false");
  if (prm.oracleKind === "mock") {
    // MockOracle 沒有偏離上限，一把金鑰可以寫任意價格。
    if (cfg.network?.chainId === 8453) bad("params.oracleKind=mock 不得用於 Base 主網（8453）");
    if (prm.deployVault === true) bad("params.deployVault=true 需要 oracleKind=guarded（硬化金庫不接沒有偏離上限的 oracle）");
  }
  for (const k of ["oiCapNonRwaUsdc", "oiCapRwaUsdc"]) {
    const v = prm[k];
    if (v === null || v === undefined) {
      if (strict) bad(`params.${k} 未填（status=${status} 不允許；0 或留空在合約上代表不設上限）`);
    } else if (!Number.isSafeInteger(v) || v <= 0) {
      bad(`params.${k} 必須是正整數（整數 USDC，每一邊）；0 在合約上代表不設上限`);
    }
  }
  {
    const v = prm.maxProfitBps;
    const [lo, hi] = PROFIT_BPS_RANGE;
    if (v === null || v === undefined) {
      if (strict) bad(`params.maxProfitBps 未填（status=${status} 不允許）`);
    } else if (!Number.isSafeInteger(v) || v < lo || v > hi) {
      bad(`params.maxProfitBps 必須是 ${lo}–${hi} 的整數 bps（0＝不設上限，不允許）`);
    }
  }

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

  return { problems, addrs };
}

/**
 * 檢查一份部署紀錄（<id>.deployed.json）。cfg 是同一個租戶的部署設定（沒有就是 null）。
 * 回傳形狀與 checkTenantDeploy 相同，addrs 一樣進跨租戶比對。
 */
export function checkDeployedRecord({ file, rec, cfg, ctx }) {
  const problems = [];
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  const addrs = new Map();
  const id = basename(file).slice(0, -RECORD_SUFFIX.length);

  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    bad("不是 JSON 物件");
    return { problems, addrs };
  }
  for (const k of Object.keys(rec)) if (!RECORD_TOP_KEYS.includes(k)) bad(`未知欄位 ${k}`);
  for (const [path, , value] of walk(rec)) {
    if (typeof value === "string" && HEX64_ANY.test(value)) bad(`${path.join(".")} 看起來是私鑰（64 位十六進位）`);
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) bad(`${path.join(".")} 是網址——部署紀錄只放位址`);
  }
  if (rec.schemaVersion !== 1) bad("schemaVersion 必須是 1");
  if (rec.tenantId !== id) bad(`tenantId「${rec.tenantId}」與檔名「${id}」不一致`);
  // dry-run／test 產生的位址是模擬出來的；只有真的廣播過的紀錄能進版控。
  if (rec.mode !== "broadcast") {
    bad(`mode=${JSON.stringify(rec.mode)}——只有 DeployTenant 廣播後寫出的紀錄（mode=broadcast）能放進 deploy/tenants/`);
  }

  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (!cfg) {
    bad(`找不到對應的部署設定 ${id}.json`);
  } else {
    if (cfg.status !== "deployed") bad(`有部署紀錄，但 ${id}.json 的 status 是 ${cfg.status}（應改成 deployed）`);
    if (rec.chainId !== cfg.network?.chainId) bad(`chainId=${rec.chainId} 與設定的 network.chainId=${cfg.network?.chainId} 不一致`);
    if (rec.oracleKind !== cfg.params?.oracleKind) bad(`oracleKind=${rec.oracleKind} 與設定的 params.oracleKind 不一致`);
    if (!same(rec.settlementToken, cfg.shared?.settlementToken)) bad("settlementToken 與設定的 shared.settlementToken 不一致");
    if (!same(rec.treasury, cfg.roles?.treasury)) bad("treasury 與設定的 roles.treasury 不一致——FeeRouter 的收款地址是 immutable");
    // DeployTenant 的最後一步把所有權交給 admin；紀錄的 owner 不是 admin 代表移交沒發生。
    if (!same(rec.owner, cfg.roles?.admin)) bad("owner 與設定的 roles.admin 不一致——部署應以移交給 admin 結束");
  }

  const seen = new Map();
  const dedicated = (path, value, { allowZero = false } = {}) => {
    if (typeof value !== "string" || !ADDR_EXACT.test(value)) {
      bad(`${path}=${JSON.stringify(value)} 不是位址`);
      return;
    }
    const low = value.toLowerCase();
    if (low === ZERO) {
      if (!allowZero) bad(`${path} 是零位址`);
      return;
    }
    if (ctx.productionAddrs.has(low)) {
      bad(`${path}=${value} 是現行正式站（addresses.ts）的位址——租戶的合約不得與正式站共用`);
    }
    if (cfg) {
      for (const k of ROLE_KEYS) {
        if (same(cfg.roles?.[k], value)) {
          bad(path === "deployer" ? `deployer 與 roles.${k} 是同一個地址——部署者不得持有任何租戶角色` : `${path} 與 roles.${k} 是同一個地址`);
        }
      }
      for (const k of SHARED_KEYS) {
        if (same(cfg.shared?.[k], value)) bad(`${path} 與 shared.${k} 是同一個地址——租戶的合約不是共用元件`);
      }
    }
    if (seen.has(low)) bad(`${path} 與 ${seen.get(low)} 是同一個地址——同一個租戶的各合約不得重複`);
    else seen.set(low, path);
    addrs.set(low, path);
  };

  dedicated("deployer", rec.deployer);
  const wantVault = cfg?.params?.deployVault === true;
  const contracts = rec.contracts ?? {};
  for (const k of Object.keys(contracts)) if (!RECORD_CONTRACT_KEYS.includes(k)) bad(`contracts 未知欄位 ${k}`);
  for (const k of RECORD_CONTRACT_KEYS) {
    const isVaultKey = VAULT_RECORD_KEYS.includes(k);
    dedicated(`contracts.${k}`, contracts[k], { allowZero: isVaultKey && !wantVault });
    if (isVaultKey && !wantVault && ADDR_EXACT.test(contracts[k] ?? "") && contracts[k].toLowerCase() !== ZERO) {
      bad(`contracts.${k}：設定的 params.deployVault 不是 true，紀錄卻有金庫位址`);
    }
  }
  const tokens = rec.tokens ?? {};
  const wantTokens = wantVault ? cfg?.assets?.registered ?? [] : [];
  for (const sym of wantTokens) if (!(sym in tokens)) bad(`tokens 缺少 ${sym}（設定的 assets.registered 有它）`);
  for (const [sym, addr] of Object.entries(tokens)) {
    if (!wantTokens.includes(sym)) bad(`tokens.${sym} 不在設定的 assets.registered 裡（或這個租戶沒有金庫）`);
    dedicated(`tokens.${sym}`, addr);
  }
  return { problems, addrs };
}

/** 部署紀錄 → 前端部署登記（frontend/src/contracts/deployments/<id>.json）的內容。 */
export function frontendDeployment(rec) {
  const c = rec.contracts ?? {};
  const hasVault = typeof c.AssetVaultV2 === "string" && c.AssetVaultV2.toLowerCase() !== ZERO;
  const out = {
    schemaVersion: 1,
    tenant: rec.tenantId,
    kind: "dedicated",
    chainId: rec.chainId,
    oracleKind: rec.oracleKind,
    contracts: {
      SettlementToken: rec.settlementToken,
      Oracle: c.Oracle,
      ESGRegistryV2: c.ESGRegistryV2,
      KYCRegistry: c.KYCRegistry,
      InsuranceVault: c.InsuranceVault,
      FeeRouter: c.FeeRouter,
      TraderStake: c.TraderStake,
      PerpetualExchange: c.PerpetualExchange,
      StrategyRegistry: c.StrategyRegistry,
      CopyTracker: c.CopyTracker,
      AgentSessionManager: c.AgentSessionManager,
    },
  };
  if (hasVault) {
    out.contracts.AssetVaultV2 = c.AssetVaultV2;
    out.tokens = { ...(rec.tokens ?? {}) };
  }
  return out;
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
  const p = cfg.params ?? {};
  const id = cfg.tenantId;
  const rpc = "$" + (cfg.secretsEnv?.rpcUrl ?? "RPC_ENV");
  return [
    "# 以下只是對照，不會執行任何東西。秘密（私鑰、RPC）請從 secret store 以",
    `# ${cfg.secretsEnv?.deployerPrivateKey ?? "<DEPLOYER_KEY_ENV>"} / ${cfg.secretsEnv?.rpcUrl ?? "<RPC_ENV>"} 帶入，不要寫進任何檔案。`,
    "",
    "# 1. 模擬（不帶金鑰、不送交易）— contracts/script/DeployTenant.s.sol",
    "cd contracts",
    `TENANT=${id} PREFLIGHT_ONLY=true forge script script/DeployTenant.s.sol:DeployTenant --fork-url "${rpc}" --sender <部署者位址> -vv`,
    `TENANT=${id} forge script script/DeployTenant.s.sol:DeployTenant --fork-url "${rpc}" --sender <部署者位址> -vv`,
    "",
    "# 2. 廣播由持有部署者金鑰的人執行（docs/TENANT_DEPLOYMENT.md），不在這裡、不在 CI。",
    "",
    "# 3. 廣播後讀回驗證（唯讀）",
    `TENANT=${id} TENANT_RECORD=cache/tenants/${id}.deployed.json forge script script/VerifyTenant.s.sol:VerifyTenant --rpc-url "${rpc}" -vv`,
    "",
    "# 這份設定會寫上鏈的角色與參數（DeployTenant 讀的就是這個檔案，不讀環境變數）：",
    `# admin（部署結束時的 owner）=${r.admin}`,
    `# risk=${r.risk}  guardian=${r.guardian}  keeper=${r.keeper}`,
    `# marketOperator=${r.marketOperator}  treasury（FeeRouter，immutable）=${r.treasury}`,
    `# settlementToken=${s.settlementToken}  priceSource（只用來替新 oracle 取初始價）=${s.priceSource}`,
    `# oracleKind=${p.oracleKind}  deployVault=${p.deployVault}`,
    `# OI 上限／每邊（USDC）：非 RWA ${p.oiCapNonRwaUsdc}、RWA ${p.oiCapRwaUsdc}；maxProfitBps=${p.maxProfitBps}`,
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

const readJson = (file) => {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: `${file}: 不是合法 JSON：${e.message}` };
  }
};

export function run({ root, files, log = console.log }) {
  const ctx = loadContext(root);
  const configFiles = files.filter((f) => !isRecordFile(f));
  const recordFiles = files.filter(isRecordFile);

  const results = configFiles.map((file) => {
    const { value: cfg, error } = readJson(file);
    if (error) return { file, problems: [error], addrs: new Map() };
    return { file, cfg, ...checkTenantDeploy({ file, cfg, ctx }) };
  });

  for (const file of recordFiles) {
    const { value: rec, error } = readJson(file);
    if (error) {
      results.push({ file, problems: [error], addrs: new Map() });
      continue;
    }
    // 對應的設定：同一次檢查裡有就用，沒有就從紀錄旁邊讀（只檢查單一紀錄檔時）。
    const cfgFile = join(dirname(file), `${basename(file).slice(0, -RECORD_SUFFIX.length)}.json`);
    const hit = results.find((r) => resolve(r.file) === resolve(cfgFile));
    const cfg = hit ? (hit.cfg ?? null) : existsSync(cfgFile) ? (readJson(cfgFile).value ?? null) : null;
    // 以設定檔的名義進跨租戶比對：紀錄與「自己的」設定不算兩個租戶。
    results.push({ file: cfgFile, ...checkDeployedRecord({ file, rec, cfg, ctx }) });
  }

  // status=deployed 必須有部署紀錄（位址只放在紀錄裡，設定檔沒有位址欄位可填）。
  const problems = results.flatMap((r) => r.problems);
  for (const r of results) {
    if (r.cfg?.status !== "deployed") continue;
    const recFile = join(dirname(r.file), `${basename(r.file, ".json")}${RECORD_SUFFIX}`);
    if (!existsSync(recFile)) problems.push(`${r.file}: status=deployed 但找不到部署紀錄 ${basename(recFile)}`);
  }
  problems.push(...checkCrossTenant(results));

  log(
    `檢查 ${configFiles.length} 份租戶部署設定、${recordFiles.length} 份部署紀錄` +
      `（已知資產 ${ctx.symbols.length} 檔、正式站位址 ${ctx.productionAddrs.size} 個）`,
  );
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

  const f = args.indexOf("--print-frontend");
  if (f >= 0) {
    const file = resolve(args[f + 1] ?? "");
    if (!isRecordFile(file)) {
      console.error("::error::--print-frontend 需要一份部署紀錄（<id>.deployed.json）");
      process.exit(2);
    }
    const problems = run({ root, files: [file], log: (m) => console.error(m) });
    if (problems.length) process.exit(1);
    console.log(JSON.stringify(frontendDeployment(JSON.parse(readFileSync(file, "utf8"))), null, 2));
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
