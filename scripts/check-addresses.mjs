#!/usr/bin/env node
// 位址一致性檢查：.github/workflows/*.yml 裡寫死的合約位址必須與前端設定一致。
//
// 為什麼存在：2026-09-29 發現三支 workflow 仍寫著舊 exchange 位址（#178 修正）。
// keeper／健檢／admin 都在「看起來正常」地對一顆已經沒人用的合約運作，CI 全綠。
// 位址的唯一真相是前端設定：
//   - frontend/src/contracts/addresses.ts   CHAIN_MAP（11155111 / 84532）、
//                                           BASE_SEPOLIA_ORACLE_SHOWCASE、V2_STACK
//   - frontend/src/contracts/sessionManager.ts  SESSION_MANAGER_ADDRESS
//   - frontend/src/contracts/x402.ts            X402_FEE_ROUTER（官方 USDC 的 FeeRouter）
// 這支腳本把兩邊對起來，對不上就列出並以非零結束。
//
// 零依賴（只用 node 內建模組）：CI 不需要 npm install，也不會因為依賴壞掉而沉默。
// YAML 與 TS 都用「夠用的」逐行解析，不是完整 parser —— 只抓 `KEY: 0x…` 形狀。
//
// 租戶（ADR-008）：default 以外的租戶各有一份部署登記
// frontend/src/contracts/deployments/<id>.json（kind: platform＝沿用上面的平台部署；
// kind: dedicated＝租戶自己的整組合約）。這支腳本也檢查它們：
//   - 格式：kind 必填、欄位不得缺也不得多（沒有預設值）、JSON 不得有重複的鍵；
//   - 專屬部署登記裡的**每一個**位址（自動列舉，不是手寫欄位清單）都不得出現在「平台位址
//     全集」裡（scripts/lib/platform-addresses.mjs：平台設定檔、退役清單、workflow、agent
//     設定裡出現過的每一個位址）——共用就是共用資金、收款地址與暫停鍵；
//   - 唯一的例外是 `shared` 顯式宣告、而且在白名單 SHAREABLE_PATHS 內的欄位（只有結算代幣），
//     值必須就是平台在該鏈的那一顆；
//   - 兩個租戶之間同一條規則；同一租戶各位址不重複；
//   - 每個前端租戶都有登記檔（沒有就 build 失敗，這裡先擋）。
// 鏈上的綁定、所有權與參數不在這裡：由 scripts/verify-dedicated-tenants.mjs（tenant-verify.yml）跑 VerifyTenant。
// 帶 `KEEPER_TENANT: <id>` 的 workflow（租戶自己的 keeper）改以該租戶的登記比對位址，
// 並要求它用自己的 environment（keeper-<id>）與自己的 concurrency group。
//
// 用法：
//   node scripts/check-addresses.mjs
//   node scripts/check-addresses.mjs --workflows <dir> --addresses <file> --session <file>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonStrict } from "./lib/strict-json.mjs";
import { describeSources, platformAddressUniverse } from "./lib/platform-addresses.mjs";

const ADDR = /0x[0-9a-fA-F]{40}/g;
const ADDR_EXACT = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

// ── 例外清單 ─────────────────────────────────────────────────────────────────
// 只有「前端設定裡刻意沒有、但 workflow 必須寫死」的位址才放這裡，每筆都要寫理由。
// 比對不分大小寫；`files` 省略代表所有 workflow 皆適用。
//
// 目前是空的，這是刻意的：
//   • Sepolia 的 GuardedOracle（0x32A1…49A1，price-keeper.yml）不需要例外 ——
//     檢查是「依鏈」解析的，它就是 V2_STACK[11155111].GuardedOracle。
//   • 註解裡的歷史位址（舊 exchange、keeper EOA）不會被檢查，註解整行略過。
// 新增例外前先問：這個位址為什麼不在 addresses.ts？通常答案是「該補進去」。
export const ALLOWLIST = [
  // { address: "0x…", files: ["some.yml"], reason: "為什麼它不在前端設定裡" },
];

// ── 讀 addresses.ts / sessionManager.ts ──────────────────────────────────────

/** 從 `start` 起找第一個 `{`，回傳對應 `}` 為止的區塊文字（不含外層括號）。 */
function braceBlock(src, start) {
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** 把區塊裡的 `Key: "0x…"` 攤平成 { Key: addr }（只取最外層的鍵）。 */
function flatPairs(block) {
  const out = {};
  if (!block) return out;
  let depth = 0;
  for (const line of block.split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(/^\s*([A-Za-z0-9_]+)\s*:\s*["'](0x[0-9a-fA-F]{40})["']/);
    if (m && depth === 0) out[m[1]] = m[2];
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return out;
}

function blockAfter(src, marker) {
  const i = src.indexOf(marker);
  return i < 0 ? null : braceBlock(src, i + marker.length);
}

/**
 * 解析前端設定成 { [chainId]: { roles: {role: addr}, known: Set<lowercase addr> } }。
 * roles 是可以精確比對的角色（MockOracle、PerpetualExchange…）；known 是該鏈
 * 前端認得的所有位址（含代幣），給沒有角色對應的 workflow 鍵做寬鬆比對。
 */
export function parseFrontendConfig(addressesSrc, sessionSrc = "", x402Src = "") {
  const chainVar = {};
  const chainMap = braceBlock(addressesSrc, addressesSrc.indexOf("CHAIN_MAP"));
  for (const m of (chainMap ?? "").matchAll(/(\d+)\s*:\s*([A-Z_]+)/g)) chainVar[m[1]] = m[2];

  const chains = {};
  const ensure = (id) => (chains[id] ??= { roles: {}, known: new Set() });
  const add = (id, role, addr) => {
    const c = ensure(id);
    if (role) c.roles[role] = addr;
    if (addr.toLowerCase() !== ZERO) c.known.add(addr.toLowerCase());
  };

  for (const id of ["11155111", "84532"]) {
    const v = chainVar[id];
    if (!v) throw new Error(`addresses.ts：CHAIN_MAP 找不到 ${id}`);
    const pairs = flatPairs(blockAfter(addressesSrc, `const ${v}: ChainAddresses =`));
    if (!pairs.PerpetualExchange || !pairs.MockOracle) {
      throw new Error(`addresses.ts：${v} 解析不到 PerpetualExchange / MockOracle`);
    }
    for (const [k, a] of Object.entries(pairs)) add(id, k, a);
  }

  // BASE_SEPOLIA_ORACLE_SHOWCASE：keeper 的 relay 來源（AggregatorOracle）。
  for (const [k, a] of Object.entries(flatPairs(blockAfter(addressesSrc, "BASE_SEPOLIA_ORACLE_SHOWCASE")))) {
    add("84532", k, a);
  }

  // V2_STACK / SYNTH_TOKENS：依鏈的巢狀區塊。
  for (const marker of ["export const V2_STACK", "export const SYNTH_TOKENS"]) {
    const i = addressesSrc.indexOf(marker);
    if (i < 0) continue;
    // 跳過型別註記裡的 `{ … }`，找 `= {` 開始的值。
    const eq = addressesSrc.indexOf("= {", i);
    const body = braceBlock(addressesSrc, eq);
    for (const id of ["11155111", "84532"]) {
      const j = body?.search(new RegExp(`\\b${id}\\s*:\\s*\\{`));
      if (j === undefined || j < 0) continue;
      const chainBlock = braceBlock(body, j);
      for (const [k, a] of Object.entries(flatPairs(chainBlock))) add(id, k, a);
      for (const m of (chainBlock ?? "").matchAll(ADDR)) add(id, null, m[0]);
    }
  }

  // sessionManager.ts：`84532: '0x…'`
  for (const m of sessionSrc.matchAll(/^\s*(\d+)\s*:\s*['"](0x[0-9a-fA-F]{40})['"]/gm)) {
    if (chains[m[1]]) add(m[1], "AgentSessionManager", m[2]);
  }

  // x402.ts：X402_FEE_ROUTER（官方 USDC 的 FeeRouter，不是 ChainAddresses.FeeRouter）。
  const x402Block = blockAfter(x402Src, "X402_FEE_ROUTER");
  for (const m of (x402Block ?? "").matchAll(/^\s*(\d+)\s*:\s*['"](0x[0-9a-fA-F]{40})['"]/gm)) {
    if (chains[m[1]]) add(m[1], "X402FeeRouter", m[2]);
  }

  return chains;
}

// ── 租戶部署登記（frontend/src/contracts/deployments/*.json）────────────────

const TENANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 專屬部署必填的合約。 */
export const DEDICATED_REQUIRED_KEYS = [
  "SettlementToken",
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
];
export const DEDICATED_OPTIONAL_KEYS = ["AssetVaultV2", "X402FeeRouter"];
/** 前端目前能連的專屬部署鏈（與 frontend/src/contracts/tenantDeployment.ts 一致）。 */
export const DEDICATED_CHAIN_IDS = [84532];
const PLATFORM_TOP_KEYS = { required: ["schemaVersion", "tenant", "kind"], optional: ["note"] };
const DEDICATED_TOP_KEYS = {
  required: ["schemaVersion", "tenant", "kind", "chainId", "oracleKind", "contracts", "shared"],
  optional: ["tokens"],
};

/**
 * 允許與平台（以及其他租戶）共用的欄位：**明確白名單**，每一個都綁定它必須等於的平台角色。
 * 只有結算代幣：同一條鏈上本來就是同一顆代幣。登記檔必須在 `shared` 裡顯式宣告，檢查器
 * 才放行；沒宣告、宣告了白名單以外的欄位、或宣告了卻不是平台的那一顆，一律紅燈。
 * 與 frontend/src/contracts/tenantDeployment.ts 的 SHAREABLE_PATHS 相同（測試釘住）。
 */
export const SHAREABLE_PATHS = {
  "contracts.SettlementToken": { role: "MockUSDC", why: "結算代幣（同一條鏈上就是平台的那一顆）" },
};

/** 走訪 JSON，回傳每一個字串葉節點：[路徑, 值]。 */
function stringLeaves(node, path = []) {
  if (typeof node === "string") return [[path.join("."), node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, path.concat(String(i))));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, path.concat(k)));
  return [];
}

/**
 * 登記檔裡所有的位址欄位，**自動列舉**：任何一個字串葉節點只要含有位址形狀的文字就算，
 * 不看它在哪個欄位底下——新增的欄位不必改這裡就會被比對。回傳 [{ path, value, exact }]，
 * exact＝整個值就是一個位址（否則是夾帶在其他文字裡的位址，本身就是錯）。
 * `shared` 陣列裡是欄位路徑，不是位址，所以不會出現在結果裡。
 */
export function addressFields(dep) {
  const out = [];
  for (const [path, value] of stringLeaves(dep)) {
    for (const h of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.push({ path, value: h[0], exact: ADDR_EXACT.test(value) });
  }
  return out;
}

const keyProblems = (obj, { required, optional }, where, bad) => {
  for (const k of required) if (!Object.hasOwn(obj, k)) bad(`${where}缺少欄位 ${k}（不得省略，沒有預設值）`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) bad(`${where}未知欄位 ${k}`);
};

/**
 * 檢查一份部署登記。
 * @param {object} p
 * @param {string} p.file        檔名（<id>.json）
 * @param {unknown} p.dep        解析後的 JSON
 * @param {object} p.chains      parseFrontendConfig 的結果（白名單欄位要等於的平台位址）
 * @param {Map<string,string[]>} p.universe  平台位址全集（scripts/lib/platform-addresses.mjs）
 * @param {string[]} [p.duplicateKeys]  strict-json 偵測到的重複鍵
 * @returns {{ problems: string[], addrs: Map<string, {path: string, shared: boolean}> }}
 *   addrs：這個租戶的所有位址（小寫 → 欄位），給跨租戶比對。
 */
export function checkDeployment({ file, dep, chains, universe, duplicateKeys = [] }) {
  const problems = [];
  const name = basename(file);
  const bad = (msg) => problems.push(`${name}: ${msg}`);
  const addrs = new Map();
  const id = basename(file, ".json");

  for (const d of duplicateKeys) bad(`JSON 重複的鍵 ${d}（JSON.parse 取最後一個值，審查時看到的可能是第一個）`);
  if (!dep || typeof dep !== "object" || Array.isArray(dep)) {
    bad("不是 JSON 物件");
    return { problems, addrs };
  }
  if (!TENANT_ID.test(id)) bad("檔名必須是租戶 id（小寫英數與連字號）");
  if (dep.schemaVersion !== 1) bad("schemaVersion 必須是 1");
  if (dep.tenant !== id) bad(`tenant「${dep.tenant}」與檔名「${id}」不一致`);

  if (!Object.hasOwn(dep, "kind")) {
    bad("缺少 kind（platform 或 dedicated；沒有預設值）");
    return { problems, addrs };
  }
  if (dep.kind === "platform") {
    keyProblems(dep, PLATFORM_TOP_KEYS, "kind=platform：", bad);
    if (id !== "default" && (typeof dep.note !== "string" || dep.note.trim() === "")) {
      bad("default 以外的租戶沿用平台部署時必須寫 note 說明理由（它與平台共用資金、保險金與暫停鍵）");
    }
    for (const f of addressFields(dep)) bad(`kind=platform 不得有位址（${f.path} 含 ${f.value}）——platform 沒有自己的合約`);
    return { problems, addrs };
  }
  if (dep.kind !== "dedicated") {
    bad(`kind 必須是 platform 或 dedicated，目前是 ${JSON.stringify(dep.kind)}`);
    return { problems, addrs };
  }

  if (id === "default") bad("default 租戶就是平台部署（addresses.ts），不能是 dedicated");
  keyProblems(dep, DEDICATED_TOP_KEYS, "", bad);
  if (!DEDICATED_CHAIN_IDS.includes(dep.chainId)) {
    bad(`chainId 必須是 ${DEDICATED_CHAIN_IDS.join(" / ")}（前端目前能連的專屬部署鏈），目前是 ${JSON.stringify(dep.chainId)}`);
  }
  if (!["guarded", "mock"].includes(dep.oracleKind)) bad("oracleKind 必須是 guarded 或 mock");

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Object.hasOwn(dep, "contracts") && !isObj(dep.contracts)) bad("contracts 必須是物件");
  if (Object.hasOwn(dep, "tokens") && !isObj(dep.tokens)) bad("tokens 必須是物件");
  const contracts = isObj(dep.contracts) ? dep.contracts : {};
  const tokens = isObj(dep.tokens) ? dep.tokens : {};
  keyProblems(contracts, { required: DEDICATED_REQUIRED_KEYS, optional: DEDICATED_OPTIONAL_KEYS }, "contracts ", bad);
  for (const [k, v] of Object.entries(contracts)) {
    if (typeof v !== "string" || !ADDR_EXACT.test(v)) bad(`contracts.${k}=${JSON.stringify(v)} 不是位址`);
  }
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof v !== "string" || !ADDR_EXACT.test(v)) bad(`tokens.${k}=${JSON.stringify(v)} 不是位址`);
  }

  // 顯式宣告的共用欄位。
  const declared = new Set();
  if (Object.hasOwn(dep, "shared")) {
    if (!Array.isArray(dep.shared) || dep.shared.some((s) => typeof s !== "string")) {
      bad('shared 必須是欄位路徑的陣列（例如 ["contracts.SettlementToken"]）');
    } else {
      for (const s of dep.shared) {
        if (declared.has(s)) bad(`shared 重複宣告 ${s}`);
        declared.add(s);
        if (!Object.hasOwn(SHAREABLE_PATHS, s)) {
          bad(`shared 宣告了 ${s}，但只有 ${Object.keys(SHAREABLE_PATHS).join("、")} 可以與平台共用`);
        }
      }
    }
  }

  const chain = chains[String(dep.chainId)];
  const seen = new Map();
  const fields = addressFields(dep);
  for (const f of fields) {
    const low = f.value.toLowerCase();
    if (!f.exact) bad(`${f.path} 夾帶了位址 ${f.value}——位址只能是整個欄位的值`);
    if (low === ZERO) {
      bad(`${f.path} 是零位址`);
      continue;
    }
    if (seen.has(low)) bad(`${f.path} 與 ${seen.get(low)} 是同一個位址——同一個租戶的各合約不得重複`);
    else seen.set(low, f.path);

    const isShared = declared.has(f.path) && Object.hasOwn(SHAREABLE_PATHS, f.path);
    if (isShared) {
      const rule = SHAREABLE_PATHS[f.path];
      const want = chain?.roles[rule.role];
      if (!want || want.toLowerCase() !== low) {
        bad(`${f.path}=${f.value} 宣告為共用，但不是平台在 chain ${dep.chainId} 的 ${rule.role}（${want ?? "沒有"}）——共用只限${rule.why}`);
      }
    } else if (universe.has(low)) {
      bad(
        `${f.path}=${f.value} 是平台部署（default）的位址（出處：${describeSources(universe.get(low))}）——` +
          "專屬租戶不得與平台共用任何合約；結算代幣要在 shared 裡顯式宣告",
      );
    }
    addrs.set(low, { path: f.path, shared: isShared });
  }
  for (const s of declared) {
    if (Object.hasOwn(SHAREABLE_PATHS, s) && !fields.some((f) => f.path === s)) {
      bad(`shared 宣告了 ${s}，但登記裡沒有這個位址欄位`);
    }
  }

  const tokenCount = Object.keys(tokens).length;
  if (contracts.AssetVaultV2 && tokenCount === 0) bad("有 contracts.AssetVaultV2 但 tokens 是空的");
  if (!contracts.AssetVaultV2 && Object.hasOwn(dep, "tokens")) bad("有 tokens 但沒有 contracts.AssetVaultV2");
  if (contracts.AssetVaultV2 && dep.oracleKind !== "guarded") bad("contracts.AssetVaultV2 需要 oracleKind=guarded");
  return { problems, addrs };
}

/** 讀整個登記目錄並檢查（含跨租戶與「每個前端租戶都有登記檔」）。 */
export function checkDeployments({ dir, tenantsDir, chains, universe }) {
  const problems = [];
  const deployments = {};
  const owner = new Map();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  for (const f of files) {
    let parsed;
    try {
      parsed = parseJsonStrict(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`${f}: 不是合法 JSON：${e.message}`);
      continue;
    }
    const r = checkDeployment({ file: f, dep: parsed.value, chains, universe, duplicateKeys: parsed.duplicates });
    problems.push(...r.problems);
    deployments[basename(f, ".json")] = parsed.value;
    // 跨租戶：同一條規則。只有兩邊都放在顯式宣告的共用欄位（白名單）時才允許相同。
    for (const [addr, here] of r.addrs) {
      const prev = owner.get(addr);
      if (prev && !(prev.shared && here.shared)) {
        problems.push(`${f}: ${here.path}=${addr} 與 ${prev.file} 的 ${prev.path} 相同——租戶之間不得共用合約`);
      } else if (!prev) owner.set(addr, { file: f, ...here });
    }
  }
  if (tenantsDir && existsSync(tenantsDir)) {
    const tenantIds = readdirSync(tenantsDir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"));
    for (const id of tenantIds) {
      if (!(id in deployments)) problems.push(`${id}.json: 前端租戶「${id}」沒有部署登記——它的 build 會失敗（租戶不會悄悄退回平台合約）`);
    }
    for (const id of Object.keys(deployments)) {
      if (!tenantIds.includes(id)) problems.push(`${id}.json: 有部署登記，但 frontend/src/tenant/tenants/ 沒有這個租戶`);
    }
  }
  return { problems, deployments, checked: files.length };
}

/**
 * 專屬租戶在 workflow 檢查裡的「鏈視圖」：角色對應到它自己的合約。共用上游價格來源
 * （AggregatorOracle 與兩個 adapter）沿用平台的，那是 ADR-008 明訂可共用的一層。
 */
export function tenantChainView(dep, chains) {
  const platform = chains[String(dep.chainId)];
  const c = dep.contracts ?? {};
  const roles = {
    // 鍵名沿用平台的：KEEPER_ORACLE_ADDRESS 指的是「exchange 讀的那一顆 oracle」。
    MockOracle: c.Oracle,
    PerpetualExchange: c.PerpetualExchange,
    AgentSessionManager: c.AgentSessionManager,
  };
  if (dep.oracleKind === "guarded") roles.GuardedOracle = c.Oracle;
  if (c.AssetVaultV2) roles.AssetVaultV2 = c.AssetVaultV2;
  if (c.X402FeeRouter) roles.X402FeeRouter = c.X402FeeRouter;
  const known = new Set();
  for (const v of [...Object.values(c), ...Object.values(dep.tokens ?? {})]) {
    if (typeof v === "string") known.add(v.toLowerCase());
  }
  for (const k of ["AggregatorOracle", "ChainlinkAdapter", "PythAdapter"]) {
    const a = platform?.roles[k];
    if (a) {
      roles[k] = a;
      known.add(a.toLowerCase());
    }
  }
  return { roles, known };
}

// ── 讀 workflow YAML（逐行、只為了抓 KEY: 0x…）──────────────────────────────

/**
 * 回傳 { entries, raw }：
 *   entries — 值為位址的 YAML 鍵：{ line, path: string[], key, value }
 *   raw     — 其他非註解位置出現的位址（例如 run: 腳本裡寫死的）：{ line, value }
 */
export function scanWorkflow(text) {
  const entries = [];
  const raw = [];
  const stack = []; // { indent, key }
  let blockScalarIndent = -1;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/^\s*$/.test(line)) return;
    const indent = line.match(/^ */)[0].length;

    // block scalar（run: | 之類）的內容：不當 YAML 鍵解析，但要掃出寫死的位址。
    if (blockScalarIndent >= 0) {
      if (indent > blockScalarIndent) {
        if (/^\s*#/.test(line)) return;
        const code = line.replace(/(^|\s)#.*$/, "");
        const where = stack.map((s) => s.key);
        for (const m of code.matchAll(ADDR)) raw.push({ line: lineNo, value: m[0], path: where });
        return;
      }
      blockScalarIndent = -1;
    }
    if (/^\s*#/.test(line)) return;

    let body = line.slice(indent);
    let keyIndent = indent;
    if (body.startsWith("- ")) {
      body = body.slice(2);
      keyIndent = indent + 2;
    }
    while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();

    const m = body.match(/^("[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:(\s+(.*))?$/);
    if (!m) {
      const where = stack.map((s) => s.key);
      for (const a of body.replace(/(^|\s)#.*$/, "").matchAll(ADDR)) raw.push({ line: lineNo, value: a[0], path: where });
      return;
    }
    const key = m[1].replace(/^["']|["']$/g, "");
    let rest = (m[3] ?? "").trim();
    if (rest === "") {
      stack.push({ indent: keyIndent, key });
      return;
    }
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(rest)) {
      stack.push({ indent: keyIndent, key });
      blockScalarIndent = keyIndent;
      return;
    }
    // 去掉行尾註解與引號。
    if (/^["']/.test(rest)) {
      const q = rest[0];
      const end = rest.indexOf(q, 1);
      rest = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      rest = rest.replace(/\s+#.*$/, "").trim();
    }
    const path = [...stack.map((s) => s.key), key];
    if (ADDR_EXACT.test(rest)) {
      entries.push({ line: lineNo, path, key, value: rest });
    } else {
      for (const a of rest.matchAll(ADDR)) raw.push({ line: lineNo, value: a[0], path });
    }
  });
  return { entries, raw };
}

// ── 比對 ─────────────────────────────────────────────────────────────────────

/** workflow 鍵 → 前端設定裡的角色。沒列在這裡的鍵只要求「該鏈認得這個位址」。 */
export const ROLE_OF_KEY = {
  KEEPER_ORACLE_ADDRESS: "MockOracle",
  ORACLE_ADDRESS: "MockOracle",
  MOCK_ORACLE: "MockOracle",
  EXCHANGE: "PerpetualExchange",
  EXCHANGE_ADDRESS: "PerpetualExchange",
  KEEPER_EXCHANGE_ADDRESS: "PerpetualExchange",
  KEEPER_GUARDED_ORACLE: "GuardedOracle",
  GUARDED_ORACLE: "GuardedOracle",
  KEEPER_VAULT_ADDRESS: "AssetVaultV2",
  KEEPER_RELAY_SOURCE: "AggregatorOracle",
  RELAY_SOURCE: "AggregatorOracle",
  SESSION_MANAGER: "AgentSessionManager",
  SESSION_MANAGER_ADDRESS: "AgentSessionManager",
  AGENT_SESSION_MANAGER: "AgentSessionManager",
  // x402 分潤用的 FeeRouter（frontend/src/contracts/x402.ts），不是 V1 的 ChainAddresses.FeeRouter。
  X402_FEE_ROUTER: "X402FeeRouter",
  // agent/.env.example 用的鍵名。
  PERP_ADDRESS: "PerpetualExchange",
  // admin-base-sepolia.yml 的 workflow_dispatch input；描述寫明預設是 PerpetualExchange。
  "input:target": "PerpetualExchange",
};

const CHAIN_OF_NAME = { "base-sepolia": "84532", sepolia: "11155111" };

export function checkWorkflow({ file, text, chains, allowlist = ALLOWLIST, deployments = {} }) {
  const { entries, raw } = scanWorkflow(text);
  const problems = [];
  const name = basename(file);

  // 依 KEEPER_CHAIN（job 層優先於 workflow 層）判斷鏈，再退回檔名；null = 無法判斷。
  // KEEPER_CHAIN 不是位址，所以另外抓一次。
  const chainKeys = [];
  // 同一趟也抓租戶 keeper 需要的三個純量：KEEPER_TENANT、environment 名稱、concurrency group。
  const tenantKeys = [];
  const envNames = [];
  const groups = [];
  // 哪些 job 取用了 keeper 私鑰（只有它們需要自己的 environment 與 nonce 佇列）。
  const keyUsers = [];
  {
    const stack = [];
    text.split(/\r?\n/).forEach((line, idx) => {
      if (/^\s*(#|$)/.test(line)) return;
      const indent = line.match(/^ */)[0].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (/secrets\.(TENANT_)?KEEPER_PRIVATE_KEY\b/.test(line)) keyUsers.push({ path: stack.map((s) => s.key) });
      const m = line.slice(indent).match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) return;
      const v = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
      const path = stack.map((s) => s.key);
      const parent = path[path.length - 1];
      if (m[1] === "KEEPER_CHAIN") chainKeys.push({ path, value: v });
      if (m[1] === "KEEPER_TENANT") tenantKeys.push({ path, value: v, line: idx + 1 });
      // `environment: keeper` 或 `environment:\n  name: keeper`。
      if (m[1] === "environment" && v !== "") envNames.push({ path, value: v });
      if (m[1] === "name" && parent === "environment") envNames.push({ path: path.slice(0, -1), value: v });
      // `concurrency: group` 或 `concurrency:\n  group: …`。
      if (m[1] === "concurrency" && v !== "") groups.push({ path, value: v });
      if (m[1] === "group" && parent === "concurrency") groups.push({ path: path.slice(0, -1), value: v });
      if (v === "" || /^[|>]/.test(v)) stack.push({ indent, key: m[1] });
    });
  }
  const jobOf = (path) => (path[0] === "jobs" ? path[1] : null);
  const scoped = (list, path) => {
    const job = jobOf(path);
    return list.find((c) => job && jobOf(c.path) === job) ?? list.find((c) => jobOf(c.path) === null);
  };

  // 這個位置屬於哪個租戶的 keeper（job 層優先於 workflow 層）；沒有就是平台的。
  const tenantOf = (path) => scoped(tenantKeys, path)?.value ?? null;
  for (const t of tenantKeys) {
    const dep = deployments[t.value];
    const where = `${name}:${t.line} KEEPER_TENANT=${t.value}`;
    if (!dep) {
      problems.push(`${where} —— frontend/src/contracts/deployments/ 沒有這個租戶的部署登記`);
      continue;
    }
    if (dep.kind !== "dedicated") continue;
    // 專屬租戶的 keeper：自己的金鑰（environment secret）與自己的 nonce 序列。
    // 只讀不寫的 job（例如健檢）沒有取用私鑰，不需要 environment。
    const usesKey = keyUsers.some((k) => jobOf(k.path) === jobOf(t.path) || jobOf(k.path) === null || jobOf(t.path) === null);
    if (!usesKey) continue;
    const env = scoped(envNames, t.path.concat("x"))?.value;
    if (env !== `keeper-${t.value}`) {
      problems.push(`${where} —— 這個 job 的 environment 必須是 keeper-${t.value}（租戶自己的 keeper 金鑰），目前是 ${env ?? "未設定"}`);
    }
    const group = scoped(groups, t.path.concat("x"))?.value;
    if (!group || !group.includes(t.value)) {
      problems.push(`${where} —— concurrency group 必須含租戶 id（不同金鑰不共用平台的 nonce 佇列），目前是 ${group ?? "未設定"}`);
    }
  }
  const chainOf = (path) => {
    const job = jobOf(path);
    const hit =
      chainKeys.find((c) => job && jobOf(c.path) === job) ??
      chainKeys.find((c) => c.path[0] === "env");
    if (hit && CHAIN_OF_NAME[hit.value]) return CHAIN_OF_NAME[hit.value];
    if (/base-sepolia/.test(name)) return "84532";
    return null;
  };

  /**
   * 這個位置該用哪一份位址比對：平台的（前端設定的那條鏈），或 KEEPER_TENANT 指的專屬租戶。
   * skip＝這個租戶本身已經報過問題（沒有登記、鏈不符），不再重複報每個位址。
   */
  const viewOf = (path, chainId, where) => {
    const tenantId = tenantOf(path);
    const dep = tenantId ? deployments[tenantId] : null;
    // 沿用平台部署的租戶（kind: platform）就是平台的位址，訊息也照平台的。
    if (!tenantId || dep?.kind === "platform") return { chain: chains[chainId], tenant: null };
    if (!dep) return { skip: true };
    if (String(dep.chainId) !== String(chainId)) {
      problems.push(`${where} —— 租戶 ${tenantId} 的部署在 chain ${dep.chainId}，這個 job 的鏈是 ${chainId}`);
      return { skip: true };
    }
    return { chain: tenantChainView(dep, chains), tenant: tenantId };
  };

  const isAllowed = (addr) =>
    allowlist.some(
      (a) => a.address.toLowerCase() === addr.toLowerCase() && (!a.files || a.files.includes(name)),
    );
  const knownAnywhere = (addr) =>
    Object.values(chains).some((c) => c.known.has(addr.toLowerCase()));

  for (const e of entries) {
    const inEnv = e.path[e.path.length - 2] === "env";
    const inputIdx = e.path.indexOf("inputs");
    const isInputDefault = inputIdx >= 0 && e.key === "default";
    if (!inEnv && !isInputDefault) {
      raw.push({ line: e.line, value: e.value, path: e.path });
      continue;
    }
    const label = isInputDefault ? `inputs.${e.path[inputIdx + 1]}.default` : e.key;
    const roleKey = isInputDefault ? `input:${e.path[inputIdx + 1]}` : e.key;
    const where = `${name}:${e.line} ${label}=${e.value}`;

    if (e.value.toLowerCase() === ZERO) {
      problems.push(`${where} —— 零位址`);
      continue;
    }
    if (isAllowed(e.value)) continue;

    const chainId = chainOf(e.path);
    const role = ROLE_OF_KEY[roleKey];
    if (!chainId) {
      if (!knownAnywhere(e.value)) problems.push(`${where} —— 無法判斷鏈，且任何鏈的前端設定都不認得這個位址`);
      continue;
    }
    const { chain, tenant, skip } = viewOf(e.path, chainId, where);
    if (skip) continue;
    // 平台 workflow 的訊息維持原樣；租戶 keeper 的訊息指明是哪個租戶的登記。
    const scope = tenant ? `租戶 ${tenant} 的部署登記` : `chain ${chainId}`;
    if (role) {
      const expected = chain.roles[role];
      if (!expected) {
        problems.push(tenant ? `${where} —— ${scope}沒有 ${role}` : `${where} —— 前端設定裡 chain ${chainId} 沒有 ${role}`);
      } else if (expected.toLowerCase() !== e.value.toLowerCase()) {
        problems.push(`${where} —— ${scope} 的 ${role} 應為 ${expected}`);
      }
    } else if (!chain.known.has(e.value.toLowerCase())) {
      problems.push(
        tenant
          ? `${where} —— ${scope}沒有這個位址（租戶的 keeper 只能指向租戶自己的合約與共用上游價格來源）`
          : `${where} —— chain ${chainId} 的前端設定裡沒有這個位址（新鍵請補進 ROLE_OF_KEY 或 allowlist）`,
      );
    }
  }

  // run:／with:／其他非 env 位置的位址：也依 job 的鏈檢查（審查 Medium 4）——
  // 在 Base Sepolia 的 job 裡對 Sepolia exchange 下 cast send，位址「認得」但鏈錯了。
  for (const r of raw) {
    if (r.value.toLowerCase() === ZERO || isAllowed(r.value)) continue;
    const where = `${name}:${r.line} ${r.value}${r.path?.length ? `（${r.path.join(".")}）` : ""}`;
    const chainId = chainOf(r.path ?? []);
    if (chainId) {
      const { chain, tenant, skip } = viewOf(r.path ?? [], chainId, where);
      if (!skip && !chain.known.has(r.value.toLowerCase())) {
        problems.push(
          tenant
            ? `${where} —— 寫死在非 env 位置，租戶 ${tenant} 的部署登記沒有這個位址`
            : `${where} —— 寫死在非 env 位置，chain ${chainId} 的前端設定裡沒有這個位址`,
        );
      }
    } else if (!knownAnywhere(r.value)) {
      problems.push(`${where} —— 寫死在非 env 位置，且前端設定不認得`);
    }
  }
  return { problems, checked: entries.length + raw.length };
}

export function loadChains({ addressesFile, sessionFile, x402File }) {
  return parseFrontendConfig(
    readFileSync(addressesFile, "utf8"),
    sessionFile ? readFileSync(sessionFile, "utf8") : "",
    x402File ? readFileSync(x402File, "utf8") : "",
  );
}

/**
 * 掃 dotenv 範本（agent/.env.example，複審 Low）：非註解行的 `KEY=0x…`，只檢查
 * ROLE_OF_KEY 認得的鍵（範本裡還有 PAY_TO、官方 USDC 等前端不管的位址，不算錯）。
 * 範本描述的是正式鏈 Base Sepolia（84532）。
 */
export function checkEnvFile({ file, text, chains, chainId = "84532" }) {
  const problems = [];
  let checked = 0;
  text.split(/\r?\n/).forEach((line, idx) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*["']?(0x[0-9a-fA-F]{40})["']?\s*(#.*)?$/);
    if (!m) return;
    const role = ROLE_OF_KEY[m[1]];
    if (!role) return;
    checked += 1;
    const expected = chains[chainId]?.roles[role];
    const where = `${basename(file)}:${idx + 1} ${m[1]}=${m[2]}`;
    if (!expected) problems.push(`${where} —— 前端設定裡 chain ${chainId} 沒有 ${role}`);
    else if (expected.toLowerCase() !== m[2].toLowerCase()) {
      problems.push(`${where} —— chain ${chainId} 的 ${role} 應為 ${expected}`);
    }
  });
  return { problems, checked };
}

export function run({
  workflowsDir,
  addressesFile,
  sessionFile,
  x402File,
  root,
  deploymentsDir,
  tenantsDir,
  envFiles = [],
  log = console.log,
}) {
  const chains = loadChains({ addressesFile, sessionFile, x402File });
  const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  let problems = [];
  let checked = 0;
  // 租戶部署登記先檢查：workflow 的 KEEPER_TENANT 要靠它解析。
  // 平台位址全集（設定檔、workflow、agent 設定裡出現過的所有位址＋退役清單）。
  const universe = deploymentsDir ? platformAddressUniverse(root) : new Map();
  const reg = deploymentsDir
    ? checkDeployments({ dir: deploymentsDir, tenantsDir, chains, universe })
    : { problems: [], deployments: {}, checked: 0 };
  problems = problems.concat(reg.problems);
  for (const f of files) {
    const r = checkWorkflow({
      file: f,
      text: readFileSync(join(workflowsDir, f), "utf8"),
      chains,
      deployments: reg.deployments,
    });
    problems = problems.concat(r.problems);
    checked += r.checked;
  }
  for (const f of envFiles) {
    const r = checkEnvFile({ file: f, text: readFileSync(f, "utf8"), chains });
    problems = problems.concat(r.problems);
    checked += r.checked;
  }
  for (const [id, c] of Object.entries(chains)) {
    log(`chain ${id}: exchange=${c.roles.PerpetualExchange} oracle=${c.roles.MockOracle} 已知位址 ${c.known.size} 個`);
  }
  log(`掃描 ${files.length} 支 workflow，${checked} 個位址`);
  if (deploymentsDir) {
    const kinds = Object.entries(reg.deployments).map(([id, d]) => `${id}=${d?.kind}`);
    log(`租戶部署登記 ${reg.checked} 份（${kinds.join(", ")}）；平台位址全集 ${universe.size} 個`);
  }
  if (problems.length) {
    for (const p of problems) log(`::error::${p}`);
    log(`\n${problems.length} 個位址與 frontend/src/contracts 不一致`);
  } else {
    log("所有 workflow 位址與前端設定一致 ✓");
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? resolve(args[i + 1]) : def;
  };
  const files = {
    addressesFile: opt("--addresses", join(root, "frontend/src/contracts/addresses.ts")),
    sessionFile: opt("--session", join(root, "frontend/src/contracts/sessionManager.ts")),
    x402File: opt("--x402", join(root, "frontend/src/contracts/x402.ts")),
  };

  // --print <chainId> <role>：印出設定來源裡的位址，給 workflow 做執行期斷言
  // （例如 x402-settlement-worker.yml 比對 vars.X402_FEE_ROUTER）。找不到就 exit 1。
  const p = args.indexOf("--print");
  if (p >= 0) {
    const [chainId, role] = [args[p + 1], args[p + 2]];
    const addr = loadChains(files)[chainId]?.roles[role];
    if (!addr) {
      console.error(`::error::設定來源裡沒有 chain ${chainId} 的 ${role}`);
      process.exit(1);
    }
    console.log(addr);
    process.exit(0);
  }

  const problems = run({
    workflowsDir: opt("--workflows", join(root, ".github/workflows")),
    envFiles: [opt("--env", join(root, "agent/.env.example"))],
    deploymentsDir: opt("--deployments", join(root, "frontend/src/contracts/deployments")),
    tenantsDir: opt("--tenants", join(root, "frontend/src/tenant/tenants")),
    root,
    ...files,
  });
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`::error::check-addresses 中止：${e.message}`);
    process.exit(2);
  }
}
