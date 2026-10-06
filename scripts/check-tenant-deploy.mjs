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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadChains } from "./check-addresses.mjs";
import { parseJsonStrict } from "./lib/strict-json.mjs";
import {
  addressesInText,
  describeSources,
  platformAddressUniverse,
  publicKeyAccountProblem,
  repoFiles,
  wellKnownEntry,
} from "./lib/platform-addresses.mjs";

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
export const SCHEMA_VERSION = 4;
export const SHARED_KEYS = ["settlementToken", "priceSource", "referenceSource"];
/**
 * shared.* 是與平台共用的元件，所以**只能**指向平台在該鏈的這些角色（白名單，不是黑名單）：
 *   settlementToken  結算代幣——同一條鏈上就是平台那一顆（審查 F2：先前可以填任何地址，
 *                    包括平台的保險金份額這種 18 位 ERC20）；
 *   priceSource      只在部署時替租戶自己的 oracle 取一次初始價；
 *   referenceSource  租戶 GuardedOracle 的參考來源（去中心化行情），或字串 "none"。
 * 一條鏈上沒有對應角色（例如 Base 主網還沒有平台部署）就沒有任何值能通過——那條鏈要先
 * 定義共用元件，才能部署租戶。
 */
export const SHARED_ALLOWED_ROLES = {
  settlementToken: ["MockUSDC"],
  priceSource: ["MockOracle", "GuardedOracle", "AggregatorOracle"],
  referenceSource: ["AggregatorOracle", "ChainlinkAdapter", "PythAdapter"],
};
export const NO_REFERENCE = "none";
export const PARAM_KEYS = [
  "oracleKind",
  "oracleMaxDeviationBps",
  "oracleWindowSeconds",
  "oracleWindowDeviationBps",
  "oiCapNonRwaUsdc",
  "oiCapRwaUsdc",
  "maxProfitBps",
  "maxLeverage",
  "liquidationPenaltyBps",
  "markPremiumCapBps",
  "vaultFeeShareBps",
  "deployVault",
  "vaultRedeemFeeBps",
  "vaultMinReserveRatioBps",
  "kycRegistry",
];
export const ORACLE_KINDS = ["guarded", "mock"];
/**
 * params.kycRegistry（v4）：exchange 的 KYC 閘門是哪一種登錄。
 *   allowlist  KYCRegistry——verifier 逐一核准地址（平台現況）；
 *   vc         VCKycRegistry——投資人提交受信任發證者簽的合格投資人憑證（docs/SSI_RWA_ACCESS.md）。
 * 兩者都由 DeployTenant 在部署當下建好、接上 exchange，所有權從一開始就是 roles.admin；
 * 在 admin 指派 verifier／發證者之前，所有 RWA 市場對所有人關閉。
 */
export const KYC_REGISTRY_KINDS = ["allowlist", "vc"];
/**
 * 內建的 RWA 分類（要 KYC 的資產）。資產本身的性質，不是租戶設定——租戶不能把 sAAPL 標成非 RWA
 * 來關掉 KYC。與 contracts/script/VerifyTenant.s.sol 的 `_isRwa` 相同（測試讀那個檔案比對），
 * 後者又與平台的 Cutover130Base._isRwa 由 forge 測試釘住。
 * 租戶只能用 assets.additionalRwa「追加」（例如把 sGOLD 也納入 KYC），不能取消。
 */
export const BUILTIN_RWA_ASSETS = ["sAAPL", "sTSLA", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU", "sBOND"];
const ASSET_KEYS = ["registered", "additionalRwa"];
/**
 * 數值參數的範圍（含兩端）。與 contracts/script/VerifyTenant.s.sol（TenantBase）的常數相同，
 * check-tenant-deploy.test.mjs 讀那個檔案逐一比對。
 *   oracle*：租戶 GuardedOracle 的單次偏移上限、時間窗長度、時間窗累計上限（審查 F1：
 *            沒有時間窗時，keeper 金鑰外洩就能在同一個區塊內把價格一路推上去）。範圍不得比
 *            平台自己的設定寬鬆（複審 C1）：時間窗 ≥ 3600 秒、時間窗上限 ≤ 2500 bps、單次上限
 *            ≤ 1000 bps；預設值就是平台值（1000／3600／2500）。限速只是減速：時間窗 d 秒、
 *            上限 W 時，T 秒內最多乘 (1+W)^(⌊T/d⌋+1)，見 docs/TENANT_OPERATIONS.md。
 *   oiCap*：每邊、整數 USDC；上界避免「實務上等於不設上限」（審查 F7）。
 *   maxProfitBps：與 PerpetualExchange 的 MIN_PROFIT_CAP_BPS / MAX_PROFIT_CAP_BPS 相同。
 */
export const PARAM_RANGES = {
  oracleMaxDeviationBps: [100, 1_000],
  oracleWindowSeconds: [3_600, 86_400],
  oracleWindowDeviationBps: [100, 2_500],
  oiCapNonRwaUsdc: [1, 10_000_000],
  oiCapRwaUsdc: [1, 10_000_000],
  maxProfitBps: [10_000, 250_000],
  maxLeverage: [1, 5],
  liquidationPenaltyBps: [0, 5_000],
  markPremiumCapBps: [0, 200],
  vaultFeeShareBps: [0, 10_000],
  vaultRedeemFeeBps: [0, 300],
  vaultMinReserveRatioBps: [10_000, 20_000],
};
/** 只有 oracleKind=guarded 才有意義（MockOracle 沒有任何限速），mock 時必須是 null。 */
export const ORACLE_PARAM_KEYS = ["oracleMaxDeviationBps", "oracleWindowSeconds", "oracleWindowDeviationBps"];
/** 只有 deployVault=true 才有意義，沒有金庫時必須是 null。 */
export const VAULT_PARAM_KEYS = ["vaultRedeemFeeBps", "vaultMinReserveRatioBps"];
/** 與 PerpetualExchange 的 MIN_PROFIT_CAP_BPS / MAX_PROFIT_CAP_BPS 相同（DeployTenant 也會擋）。 */
export const PROFIT_BPS_RANGE = PARAM_RANGES.maxProfitBps;
/** 部署紀錄（<id>.deployed.json）的 contracts 鍵——DeployTenant.s.sol `_recordJson` 寫出的那一組。 */
export const RECORD_CONTRACT_KEYS = [
  "Oracle",
  "ESGRegistryV2",
  "KYCRegistry",
  "InsuranceVault",
  "InsuranceSeeder",
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
  "deployBlock",
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
  // admin（部署結束時的 owner）是多簽；marketOperator 是熱錢包。兩者相同時 VerifyTenant 的
  // 「owner 不是熱錢包」檢查就無從成立（DeployTenant 的 preflight 同樣擋）。
  ["admin", "marketOperator"],
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
  if (cfg.schemaVersion !== SCHEMA_VERSION) {
    bad(
      `schemaVersion 必須是 ${SCHEMA_VERSION}（v3：oracle 限速、exchange／金庫風控參數、shared.referenceSource；` +
        "v4：params.kycRegistry、assets.additionalRwa）",
    );
  }

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
  const chain = ctx.chains?.[String(cfg.network?.chainId)];
  const addrField = (path, value, { dedicated, allowedRoles = [] }) => {
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
      const pub = publicKeyAccountProblem(path, value);
      if (pub) bad(pub);
      if (ctx.universe.has(value.toLowerCase())) {
        bad(
          `${path}=${value} 是現行正式站（平台）用過的位址（出處：${describeSources(ctx.universe.get(value.toLowerCase()))}）` +
            "——租戶專屬的角色與合約不得與正式站共用",
        );
      }
      addrs.set(value.toLowerCase(), path);
    } else {
      // 共用元件：白名單。
      const allowed = allowedRoles.map((r) => [r, chain?.roles[r]]).filter(([, a]) => a);
      if (!allowed.some(([, a]) => a.toLowerCase() === value.toLowerCase())) {
        bad(
          `${path}=${value} 不是平台在 chain ${cfg.network?.chainId} 的 ${allowedRoles.join("／")}` +
            (allowed.length ? `（${allowed.map(([r, a]) => `${r}=${a}`).join("、")}）` : "（這條鏈沒有平台的對應元件）") +
            "——共用元件只限白名單",
        );
      }
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

  for (const k of SHARED_KEYS) {
    const v = cfg.shared?.[k];
    if (k === "referenceSource" && v === NO_REFERENCE) continue;
    addrField(`shared.${k}`, v, { dedicated: false, allowedRoles: SHARED_ALLOWED_ROLES[k] });
  }
  for (const k of Object.keys(cfg.shared ?? {})) if (!SHARED_KEYS.includes(k)) bad(`shared 未知欄位 ${k}`);

  // ── 部署參數（DeployTenant.s.sol 的輸入）──
  const prm = cfg.params ?? {};
  for (const k of Object.keys(prm)) if (!PARAM_KEYS.includes(k)) bad(`params 未知欄位 ${k}`);
  if (!ORACLE_KINDS.includes(prm.oracleKind)) bad(`params.oracleKind 必須是 ${ORACLE_KINDS.join(" / ")}`);
  if (typeof prm.deployVault !== "boolean") bad("params.deployVault 必須是 true 或 false");
  if (!KYC_REGISTRY_KINDS.includes(prm.kycRegistry)) {
    bad(`params.kycRegistry 必須是 ${KYC_REGISTRY_KINDS.join(" / ")}（沒有預設值）`);
  }
  if (prm.oracleKind === "mock") {
    // MockOracle 沒有偏離上限，一把金鑰可以寫任意價格。
    if (cfg.network?.chainId === 8453) bad("params.oracleKind=mock 不得用於 Base 主網（8453）");
    if (prm.deployVault === true) bad("params.deployVault=true 需要 oracleKind=guarded（硬化金庫不接沒有偏離上限的 oracle）");
    if (cfg.shared?.referenceSource !== NO_REFERENCE) {
      bad('oracleKind=mock 時 shared.referenceSource 必須是 "none"（MockOracle 不支援參考來源）');
    }
  }
  if (prm.oracleKind === "guarded" && cfg.network?.chainId === 8453 && cfg.shared?.referenceSource === NO_REFERENCE) {
    bad('Base 主網的 guarded oracle 必須有參考來源（shared.referenceSource 不得是 "none"）');
  }
  // 數值參數：每一個鍵都必須寫出來（沒有預設值）；值要嘛是範圍內的整數，要嘛是 null。
  //   null 只在兩種情況合法：status=template（數字還沒決定），或這個參數對這份設定不適用
  //   （mock oracle 的限速、沒有金庫時的金庫參數）——那兩種情況**必須**是 null，
  //   不能寫一個不存在的上限讓讀的人以為有。
  for (const [k, [lo, hi]] of Object.entries(PARAM_RANGES)) {
    const v = prm[k];
    const inapplicable =
      (ORACLE_PARAM_KEYS.includes(k) && prm.oracleKind === "mock") ||
      (VAULT_PARAM_KEYS.includes(k) && prm.deployVault === false);
    if (!Object.hasOwn(prm, k)) {
      bad(`params.${k} 缺少（每個參數都要寫出來；不適用時寫 null）`);
    } else if (inapplicable) {
      if (v !== null) {
        bad(
          ORACLE_PARAM_KEYS.includes(k)
            ? `params.${k} 必須是 null：oracleKind=mock 沒有任何限速，設定檔不能寫一個不存在的上限`
            : `params.${k} 必須是 null：params.deployVault=false，沒有金庫`,
        );
      }
    } else if (v === null) {
      if (strict) bad(`params.${k} 未填（status=${status} 不允許）`);
    } else if (!Number.isSafeInteger(v) || v < lo || v > hi) {
      const why =
        k.startsWith("oiCap") ? "整數 USDC、每一邊；0 在合約上代表不設上限" :
        k === "maxProfitBps" ? "整數 bps；0＝不設上限，不允許" :
        k.startsWith("oracle") ? "0＝不限速，不允許" :
        "整數";
      bad(`params.${k} 必須是 ${lo}–${hi} 的整數（${why}）`);
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
  for (const k of Object.keys(cfg.assets ?? {})) if (!ASSET_KEYS.includes(k)) bad(`assets 未知欄位 ${k}`);
  // 追加的 RWA（v4）：只能加、不能減；必須是已註冊的資產。
  const extra = cfg.assets?.additionalRwa;
  if (!Array.isArray(extra)) {
    bad("assets.additionalRwa 必須是陣列（沒有追加就寫 []）");
  } else {
    if (new Set(extra).size !== extra.length) bad("assets.additionalRwa 有重複");
    for (const s of extra) {
      if (BUILTIN_RWA_ASSETS.includes(s)) bad(`assets.additionalRwa：${s} 本來就是 RWA（內建分類），清單只能追加`);
      else if (!Array.isArray(reg) || !reg.includes(s)) bad(`assets.additionalRwa：${s} 不在 assets.registered 裡`);
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
  // 部署開始前的區塊高度：VerifyTenant 從這裡起掃角色授予事件，重建每個角色的持有者集合（複審 C4）。
  if (!Number.isSafeInteger(rec.deployBlock) || rec.deployBlock < 0) {
    bad(`deployBlock=${JSON.stringify(rec.deployBlock)} 必須是非負整數（DeployTenant 寫入的部署起始區塊）`);
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
    const pub = publicKeyAccountProblem(path, value);
    if (pub) bad(pub);
    if (ctx.universe.has(low)) {
      bad(`${path}=${value} 是現行正式站（平台）用過的位址（出處：${describeSources(ctx.universe.get(low))}）——租戶的合約不得與正式站共用`);
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
    // 結算代幣是唯一與平台共用的位址，而且一定是平台那一顆（shared.settlementToken 的白名單），
    // 所以登記檔一律顯式宣告它（check-addresses.mjs 只放行宣告過的共用欄位）。
    shared: ["contracts.SettlementToken"],
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

// ── 租戶目錄：docs/tenants/<id>/、contracts/broadcast/tenants/<id>/ ──────────────
//
// 這兩個目錄被排除在平台位址全集之外（scripts/lib/platform-addresses.mjs），所以要另外確保：
//   1. 只有「某個租戶 id 底下」的檔案：目錄直下不可有檔案；id 必須是 slug、不可是平台的 default。
//   2. contracts/broadcast/tenants/<id>/ 是真的廣播紀錄，必須有 deploy/tenants/<id>.json。
//      docs/tenants/<id>/ 可以先於部署設定存在（例如部署前的錢包表），但只能放 .md。
//   3. 這些檔案裡的位址（扣掉平台全集與眾所周知的白名單）併入該租戶，參與跨租戶比對——
//      把位址藏進某個租戶的文件，不會讓它從所有租戶的檢查裡消失。
//   4. 廣播紀錄裡 CREATE 出來的每一顆合約，必須出現在該租戶的部署紀錄或 docs/tenants/<id>/ 的文件裡
//      （VCKycRegistry、SessionCredentialAnchor 這類部署腳本以外的合約寫在文件裡即可）。

export const TENANT_FILE_DIRS = ["docs/tenants/", "contracts/broadcast/tenants/"];

/** deploy/tenants/ 只能放直下的 *.json；其他檔案不被排除在全集之外，而且報錯。 */
export function checkDeployTenantsDir(files) {
  return files
    .filter((rel) => rel.startsWith("deploy/tenants/") && !/^deploy\/tenants\/[^/]+\.json$/.test(rel))
    .map((rel) => `${rel}: deploy/tenants/ 只能放直下的 <id>.json／<id>.deployed.json／_template.json——子目錄與其他檔案不算租戶檔（仍算平台位址）`);
}

/** repo 裡（被追蹤＋未被忽略）兩個租戶目錄底下的檔案：[{ rel, text }]。 */
export function tenantDirEntries(root, files = repoFiles(root)) {
  const out = [];
  for (const rel of files) {
    if (!TENANT_FILE_DIRS.some((d) => rel.startsWith(d))) continue;
    try {
      if (!statSync(join(root, rel)).isFile()) continue;
      out.push({ rel, text: readFileSync(join(root, rel), "utf8") });
    } catch {
      continue;
    }
  }
  return out;
}

/** forge 廣播紀錄（run-*.json）裡 CREATE／CREATE2 建立的合約位址。 */
export function createdContracts(text) {
  let run;
  try {
    run = JSON.parse(text);
  } catch {
    return null;
  }
  const out = [];
  for (const tx of Array.isArray(run?.transactions) ? run.transactions : []) {
    if (/^CREATE2?$/.test(String(tx?.transactionType ?? "")) && typeof tx.contractAddress === "string") {
      out.push(tx.contractAddress);
    }
    for (const c of Array.isArray(tx?.additionalContracts) ? tx.additionalContracts : []) {
      if (typeof c?.address === "string") out.push(c.address);
    }
  }
  return out;
}

/**
 * entries：tenantDirEntries 的結果；configIds：deploy/tenants/ 裡有設定檔的 id；
 * universe：平台位址全集；records：{ id: 部署紀錄 }（建立的合約要在其中或在文件裡）。
 * 回傳 { problems, addrsById: Map<id, Map<lowercase addr, path>> }。
 */
export function checkTenantDirs({ entries, configIds, universe, records = {} }) {
  const problems = [];
  const addrsById = new Map();
  const docAddrs = new Map(); // id -> Set（docs/tenants/<id>/ 文件裡的位址）
  const created = []; // { id, rel, address }
  for (const { rel, text } of entries) {
    const dir = TENANT_FILE_DIRS.find((d) => rel.startsWith(d));
    const parts = rel.slice(dir.length).split("/");
    if (parts.length < 2) {
      problems.push(`${rel}: ${dir} 直下不可放檔案——租戶的檔案一律放在 ${dir}<id>/ 底下（這個檔案仍算平台位址）`);
      continue;
    }
    const id = parts[0];
    if (!SLUG.test(id) || id === "default") {
      problems.push(`${rel}: 「${id}」不是合格的租戶 id（小寫英數與連字號，且不可是平台的 default）——這個檔案仍算平台位址`);
      continue;
    }
    const isBroadcast = dir === "contracts/broadcast/tenants/";
    if (!configIds.has(id)) {
      if (isBroadcast) {
        problems.push(`${rel}: 有廣播紀錄，但 deploy/tenants/${id}.json 不存在——租戶的廣播必須對應一份部署設定`);
      } else if (!rel.endsWith(".md")) {
        problems.push(`${rel}: deploy/tenants/${id}.json 還不存在時，docs/tenants/${id}/ 只能放 .md 文件`);
      }
    }
    if (!addrsById.has(id)) addrsById.set(id, new Map());
    const mine = addrsById.get(id);
    for (const { address, line } of addressesInText(text)) {
      const low = address.toLowerCase();
      if (!isBroadcast) {
        if (!docAddrs.has(id)) docAddrs.set(id, new Set());
        docAddrs.get(id).add(low);
      }
      if (universe.has(low) || wellKnownEntry(low)) continue;
      if (!mine.has(low)) mine.set(low, `${rel}:${line}`);
    }
    if (isBroadcast && rel.endsWith(".json") && !rel.includes("/dry-run/")) {
      const list = createdContracts(text);
      if (list === null) problems.push(`${rel}: 不是合法的 forge 廣播紀錄 JSON`);
      else for (const address of list) created.push({ id, rel, address });
    }
  }
  for (const { id, rel, address } of created) {
    const low = address.toLowerCase();
    const recAddrs = new Set(
      records[id] ? addressesInText(JSON.stringify(records[id])).map((a) => a.address.toLowerCase()) : [],
    );
    if (recAddrs.has(low) || docAddrs.get(id)?.has(low)) continue;
    problems.push(
      `${rel}: 建立的合約 ${address} 不在 deploy/tenants/${id}.deployed.json，也沒寫在 docs/tenants/${id}/ 的文件裡——` +
        `每一顆租戶合約都要有紀錄`,
    );
  }
  return { problems, addrsById };
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
    `# referenceSource（租戶 oracle 的參考來源）=${s.referenceSource === NO_REFERENCE ? "none（無參考來源）" : s.referenceSource}`,
    `# oracleKind=${p.oracleKind}  deployVault=${p.deployVault}`,
    `# oracle 限速：單次 ${p.oracleMaxDeviationBps} bps、時間窗 ${p.oracleWindowSeconds} 秒內累計 ${p.oracleWindowDeviationBps} bps`,
    `# OI 上限／每邊（USDC）：非 RWA ${p.oiCapNonRwaUsdc}、RWA ${p.oiCapRwaUsdc}；maxProfitBps=${p.maxProfitBps}`,
    `# maxLeverage=${p.maxLeverage}  liquidationPenaltyBps=${p.liquidationPenaltyBps}  markPremiumCapBps=${p.markPremiumCapBps}  vaultFeeShareBps=${p.vaultFeeShareBps}`,
    `# 金庫：redeemFeeBps=${p.vaultRedeemFeeBps}  minReserveRatioBps=${p.vaultMinReserveRatioBps}`,
    `# assets.registered=${(cfg.assets?.registered ?? []).join(",")}`,
    `# KYC 登錄=${p.kycRegistry === "vc" ? "VCKycRegistry（可驗證憑證）" : "KYCRegistry（白名單）"}`,
    `# RWA（要 KYC）=${rwaAssetsOf(cfg).join(",")}（內建分類＋assets.additionalRwa）`,
  ].join("\n");
}

/** 這份設定的 exchange 會標成 RWA 的資產：內建分類＋assets.additionalRwa（DeployTenant 的 `_isRwaFor`）。 */
export function rwaAssetsOf(cfg) {
  const extra = Array.isArray(cfg.assets?.additionalRwa) ? cfg.assets.additionalRwa : [];
  return (cfg.assets?.registered ?? []).filter((s) => BUILTIN_RWA_ASSETS.includes(s) || extra.includes(s));
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
  // 平台位址全集：repo 內所有被追蹤的文字檔裡出現過的每一個位址＋退役清單（審查 F2、複審 A1／A2）。
  const universe = platformAddressUniverse(root);
  const feDir = join(root, "frontend/src/tenant/tenants");
  const frontendTenants = Object.fromEntries(
    readdirSync(feDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [basename(f, ".json"), JSON.parse(readFileSync(join(feDir, f), "utf8"))]),
  );
  // 前端部署登記（frontend/src/contracts/deployments/<id>.json）：前端實際會連的位址。
  // 格式與租戶隔離由 check-addresses.mjs 檢查；這裡只拿來與部署紀錄對帳。
  const depDir = join(root, "frontend/src/contracts/deployments");
  const frontendDeployments = {};
  if (existsSync(depDir)) {
    for (const f of readdirSync(depDir).filter((x) => x.endsWith(".json"))) {
      try {
        frontendDeployments[basename(f, ".json")] = parseJsonStrict(readFileSync(join(depDir, f), "utf8")).value;
      } catch {
        frontendDeployments[basename(f, ".json")] = null; // 壞掉的 JSON 由 check-addresses.mjs 報
      }
    }
  }
  return { symbols, chains, universe, frontendTenants, frontendDeployments };
}

/**
 * 前端部署登記必須等於部署紀錄（由 --print-frontend 產生的那一份）。唯一允許前端多出來的
 * 欄位是 contracts.X402FeeRouter——那顆由 DeployX402Router.s.sol 另外部署，不在紀錄裡。
 */
export function frontendMismatches(fe, rec) {
  const want = frontendDeployment(rec);
  const out = [];
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  for (const k of ["tenant", "kind", "chainId", "oracleKind"]) {
    if (fe?.[k] !== want[k]) out.push(`${k}：前端登記是 ${JSON.stringify(fe?.[k])}，部署紀錄是 ${JSON.stringify(want[k])}`);
  }
  if (JSON.stringify(fe?.shared) !== JSON.stringify(want.shared)) {
    out.push(`shared：前端登記是 ${JSON.stringify(fe?.shared)}，應為 ${JSON.stringify(want.shared)}`);
  }
  const feC = fe?.contracts ?? {};
  for (const [k, v] of Object.entries(want.contracts)) {
    if (!same(feC[k], v)) out.push(`contracts.${k}：前端登記是 ${feC[k] ?? "（沒有）"}，部署紀錄是 ${v}`);
  }
  for (const k of Object.keys(feC)) {
    if (!(k in want.contracts) && k !== "X402FeeRouter") out.push(`contracts.${k}：部署紀錄裡沒有這個合約`);
  }
  const feT = fe?.tokens ?? {};
  const wantT = want.tokens ?? {};
  for (const [k, v] of Object.entries(wantT)) {
    if (!same(feT[k], v)) out.push(`tokens.${k}：前端登記是 ${feT[k] ?? "（沒有）"}，部署紀錄是 ${v}`);
  }
  for (const k of Object.keys(feT)) if (!(k in wantT)) out.push(`tokens.${k}：部署紀錄裡沒有這個代幣`);
  return out;
}

/** 嚴格讀 JSON：重複的鍵算錯（JSON.parse 取最後一個值，審查者看到的可能是第一個）。 */
const readJson = (file) => {
  try {
    const { value, duplicates } = parseJsonStrict(readFileSync(file, "utf8"));
    if (duplicates.length) return { value, error: `${file}: JSON 重複的鍵 ${duplicates.join("、")}` };
    return { value };
  } catch (e) {
    return { error: `${file}: 不是合法 JSON：${e.message}` };
  }
};

export function run({ root, files, log = console.log, coverage = false, context = null }) {
  const ctx = context ?? loadContext(root);
  const configFiles = files.filter((f) => !isRecordFile(f));
  const recordFiles = files.filter(isRecordFile);

  const results = configFiles.map((file) => {
    const { value: cfg, error } = readJson(file);
    if (error && cfg === undefined) return { file, problems: [error], addrs: new Map() };
    const r = checkTenantDeploy({ file, cfg, ctx });
    return { file, cfg, ...r, problems: error ? [error, ...r.problems] : r.problems };
  });

  for (const file of recordFiles) {
    const { value: rec, error } = readJson(file);
    if (error && rec === undefined) {
      results.push({ file, problems: [error], addrs: new Map() });
      continue;
    }
    // 對應的設定：同一次檢查裡有就用，沒有就從紀錄旁邊讀（只檢查單一紀錄檔時）。
    const cfgFile = join(dirname(file), `${basename(file).slice(0, -RECORD_SUFFIX.length)}.json`);
    const hit = results.find((r) => resolve(r.file) === resolve(cfgFile));
    const cfg = hit ? (hit.cfg ?? null) : existsSync(cfgFile) ? (readJson(cfgFile).value ?? null) : null;
    // 以設定檔的名義進跨租戶比對：紀錄與「自己的」設定不算兩個租戶。
    const r = checkDeployedRecord({ file, rec, cfg, ctx });
    results.push({ file: cfgFile, rec, ...r, problems: error ? [error, ...r.problems] : r.problems });
  }

  // status=deployed 必須有部署紀錄（位址只放在紀錄裡，設定檔沒有位址欄位可填）。
  const problems = results.flatMap((r) => r.problems);
  for (const r of results) {
    if (r.cfg?.status !== "deployed") continue;
    const recFile = join(dirname(r.file), `${basename(r.file, ".json")}${RECORD_SUFFIX}`);
    if (!existsSync(recFile)) problems.push(`${r.file}: status=deployed 但找不到部署紀錄 ${basename(recFile)}`);
  }
  // 租戶目錄（只在檢查整個目錄時）：位址併入該租戶再做跨租戶比對。
  const crossInput = [...results];
  if (coverage) {
    const cfgDir = join(root, "deploy/tenants");
    const ids = new Set(
      existsSync(cfgDir)
        ? readdirSync(cfgDir).filter((f) => f.endsWith(".json") && !isRecordFile(f)).map((f) => basename(f, ".json"))
        : [],
    );
    for (const r of results) if (r.cfg && typeof r.cfg.tenantId === "string") ids.add(r.cfg.tenantId);
    const records = {};
    for (const r of results) if (r.rec && r.cfg?.tenantId) records[r.cfg.tenantId] = r.rec;
    const allFiles = ctx.repoFiles ?? repoFiles(root);
    problems.push(...checkDeployTenantsDir(allFiles));
    const entries = ctx.tenantDirEntries ?? tenantDirEntries(root, allFiles);
    const dirs = checkTenantDirs({ entries, configIds: ids, universe: ctx.universe, records });
    problems.push(...dirs.problems);
    for (const [id, addrs] of dirs.addrsById) {
      const own = results.find((r) => r.cfg?.tenantId === id && !isRecordFile(r.file));
      crossInput.push({ file: own ? own.file : join(cfgDir, `${id}.json`), addrs });
    }
  }
  problems.push(...checkCrossTenant(crossInput));

  // 前端部署登記 ↔ 部署設定／紀錄：前端連的必須就是這個租戶部署出來的那一組。
  const deployedIds = new Set();
  for (const r of results) {
    if (!r.cfg || basename(r.file).startsWith("_")) continue;
    const id = r.cfg.frontendTenant;
    if (!(id in ctx.frontendTenants)) continue; // 已經報過「找不到前端租戶設定」
    const fe = ctx.frontendDeployments[id];
    const where = `frontend/src/contracts/deployments/${id}.json`;
    if (!fe) {
      problems.push(`${r.file}: 前端沒有部署登記 ${where}——這個租戶的 build 會失敗`);
      continue;
    }
    if (r.cfg.status !== "deployed") {
      if (fe.kind === "dedicated") {
        problems.push(`${r.file}: status=${r.cfg.status}（尚未部署），但 ${where} 已經是 dedicated——前端會連到沒有部署紀錄的位址`);
      }
      continue;
    }
    deployedIds.add(id);
    if (fe.kind !== "dedicated") {
      problems.push(`${r.file}: status=deployed，但 ${where} 的 kind 是 ${fe.kind}——這個租戶的站仍連到平台的合約（用 --print-frontend 產生登記內容）`);
      continue;
    }
    const recFile = join(dirname(r.file), `${basename(r.file, ".json")}${RECORD_SUFFIX}`);
    const rec =
      results.find((x) => x.rec && resolve(x.file) === resolve(r.file))?.rec ??
      (existsSync(recFile) ? readJson(recFile).value : null);
    if (!rec) continue; // 「找不到部署紀錄」上面已經報過
    for (const m of frontendMismatches(fe, rec)) problems.push(`${where}: 與部署紀錄不一致 —— ${m}`);
  }
  // 反方向（只在檢查整個目錄時）：前端登記成 dedicated 的租戶，必須真的有已部署的設定。
  if (coverage) {
    for (const [id, fe] of Object.entries(ctx.frontendDeployments)) {
      if (fe?.kind === "dedicated" && !deployedIds.has(id)) {
        problems.push(`frontend/src/contracts/deployments/${id}.json: kind=dedicated，但 deploy/tenants/ 沒有 status=deployed 的 ${id}.json 與部署紀錄`);
      }
    }
  }

  log(
    `檢查 ${configFiles.length} 份租戶部署設定、${recordFiles.length} 份部署紀錄` +
      `（已知資產 ${ctx.symbols.length} 檔、平台位址全集 ${ctx.universe.size} 個）`,
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
  process.exit(run({ root, files, coverage: args.length === 0 }).length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`::error::check-tenant-deploy 中止：${e.message}`);
    process.exit(2);
  }
}
