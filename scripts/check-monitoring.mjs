#!/usr/bin/env node
// 監控設定一致性檢查（ops/monitoring/monitors.json ↔ 前端設定與 ABI）。
//
// 為什麼存在：監控最糟的失敗模式是「看起來在監控」——對一顆已經沒人用的合約、或一個
// 合約根本不會發出的事件設告警，永遠不會響，也永遠不會有人發現。2026-09-29 三支
// workflow 指向舊 exchange、CI 全綠（#178），就是同一類問題。這支腳本確保：
//
//   1. 每個 active 規則的合約位址 == frontend/src/contracts/**（addresses.ts、V2_STACK、
//      x402.ts、sessionManager.ts）解析出來的位址。位址不手抄，由 --write 產生。
//   2. 每個 active 事件簽章存在於該合約在 frontend/src/contracts/abi/*.json 的 ABI；
//      topic0 == keccak256(簽章)；inputs 與 ABI 相同。
//   3. pending-deploy 規則沒有位址、不會被 Worker 載入，但事件必須真的宣告在指定的
//      Solidity 原始碼裡（部署後改 active 時，ABI 檢查接手）。
//   4. state 規則呼叫的函式存在於 ABI；selector 正確；金額小數位依代幣原始碼推得。
//   5. 處置段落（runbook）真的是 docs/INCIDENT_RESPONSE.md 的標題；related 連結的標題存在。
//   6. rules.md 是 monitors.json 的渲染結果（人看的清單不會與機器設定脫鉤）。
//   7. 設定目錄裡沒有秘密：wrangler.toml [vars] 不含憑證鍵名，任何檔案不含 bot token／webhook URL。
//   8. 引擎用到的參數都有定義；SIGNAL_API_URL 預設值 == SDK 的 SIGNAL_API_TESTNET_URL。
//   9. **部署版真的會發這個事件、真的有這個函式**（審查 H2）：前端 ABI 來自 master 原始碼，
//      可能比鏈上的版本新。ops/monitoring/deployed.json 是以唯讀 RPC 抓下來的 runtime
//      bytecode（UUPS 讀實作位址）與幾個 getter 的鏈上快照；active 事件的 topic0、state 規則的
//      selector 必須出現在 bytecode 裡，接線規則的預期值必須等於鏈上快照。檢查本身不連網。
//
// 零依賴。用法：
//   node scripts/check-monitoring.mjs            # 檢查，有問題非零結束（不連網）
//   node scripts/check-monitoring.mjs --write    # 依來源重新產生 monitors.json 的產生欄位與 rules.md
//   node scripts/check-monitoring.mjs --refresh-deployed [--rpc <url>]
//                                                # 以唯讀 RPC 重抓 deployed.json（合約重新部署、升級或加規則後）
//   node scripts/check-monitoring.mjs --root <dir>
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontendConfig } from "./check-addresses.mjs";
import { keccak256, selector } from "../ops/monitoring/keccak.mjs";
import { _internal as engineInternal, SEVERITIES } from "../ops/monitoring/engine.mjs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const KINDS = ["event", "state", "http"];
const STATUSES = ["active", "pending-deploy"];
const IR_DOC = "docs/INCIDENT_RESPONSE.md";
const DEPLOYED_FILE = "ops/monitoring/deployed.json";
/** EIP-1967 implementation slot：keccak256("eip1967.proxy.implementation") - 1。 */
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** 讀代幣位址的 getter（本專案所有持有 USDC 的合約都叫 usdc()）。 */
const TOKEN_GETTER = "usdc()";
/** 代幣小數位：MockUSDC 沒有覆寫 decimals()（OZ ERC20 預設 18）；Circle 官方 USDC 是 6。 */
const TOKENS = {
  MockUSDC: { file: "contracts/src/MockUSDC.sol", default: 18, ref: "MockUSDC" },
  // Circle 官方 Base Sepolia USDC；位址的單一來源是 agent/shared/src/env.ts。
  USDC: { fixed: 6, constant: { file: "agent/shared/src/env.ts", name: "OFFICIAL_BASE_SEPOLIA_USDC" } },
};
/** 這些名稱只能用 `wrangler secret put` 設定，出現在 [vars] 就是把秘密寫進 repo。 */
export const SECRET_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_WEBHOOK_URL",
  "ALERT_WEBHOOK_URL",
  "ALERT_WEBHOOK_SECRET",
  "HEARTBEAT_URL",
  "RPC_URL",
  "GITHUB_TOKEN",
];
/** [vars] 允許的非參數鍵（公開資訊）。 */
const EXTRA_VARS = ["EXTRA_GAS_WALLETS", "EXPECTED_PAY_TO"];

// ── 小工具 ───────────────────────────────────────────────────────────────────

const read = (root, p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const lc = (s) => String(s).toLowerCase();

/** GitHub 標題錨點（github-slugger 的規則：去標點、小寫、空白換成 -）。 */
export function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Markdown 標題（略過 code fence 裡的）。 */
export function headingsOf(md) {
  const out = new Set();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) out.add(m[1]);
  }
  return out;
}

function braceBlock(src, start) {
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

// ── ABI 與 Solidity ──────────────────────────────────────────────────────────

const canonicalType = (inp) => {
  if (inp.type.startsWith("tuple")) return `(${inp.components.map(canonicalType).join(",")})${inp.type.slice(5)}`;
  return inp.type;
};
export const abiSig = (item) => `${item.name}(${item.inputs.map(canonicalType).join(",")})`;

/** 掃 contracts/src 收集 enum 與 contract/interface/library 名稱（事件參數型別正規化用）。 */
function solTypeNames(root) {
  const enums = new Set();
  const contracts = new Set(["IERC20", "IERC20Metadata"]);
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".sol")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\benum\s+(\w+)/g)) enums.add(m[1]);
        for (const m of src.matchAll(/\b(?:contract|interface|library)\s+(\w+)/g)) contracts.add(m[1]);
      }
    }
  };
  walk(join(root, "contracts/src"));
  return { enums, contracts };
}

/** 解析 Solidity 原始碼裡的 event 宣告 → [{ sig, inputs:[{name,type,indexed}] }]。 */
export function parseSolEvents(src, { enums = new Set(), contracts = new Set() } = {}) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const local = solTypeNamesFrom(clean);
  const isEnum = (t) => enums.has(t) || local.enums.has(t);
  // 介面慣例 I + 大寫開頭（IERC20 等，宣告在 lib 裡）也視為 address。
  const isContract = (t) => contracts.has(t) || local.contracts.has(t) || /^I[A-Z]\w*$/.test(t);
  const norm = (t) => {
    const m = t.match(/^([\w.]+)((?:\[\d*\])*)$/);
    if (!m) throw new Error(`無法解析的型別 ${t}`);
    let base = m[1].split(".").pop();
    if (base === "uint") base = "uint256";
    else if (base === "int") base = "int256";
    else if (isEnum(base)) base = "uint8";
    else if (isContract(base)) base = "address";
    return base + m[2];
  };
  const out = [];
  for (const m of clean.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*(anonymous\s*)?;/g)) {
    const inputs = m[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => {
        const parts = p.split(/\s+/);
        const indexed = parts.includes("indexed");
        const rest = parts.filter((x) => x !== "indexed");
        return { name: rest.length > 1 ? rest[rest.length - 1] : "", type: norm(rest[0]), indexed };
      });
    out.push({ name: m[1], sig: `${m[1]}(${inputs.map((i) => i.type).join(",")})`, inputs });
  }
  return out;
}
function solTypeNamesFrom(src) {
  return {
    enums: new Set([...src.matchAll(/\benum\s+(\w+)/g)].map((m) => m[1])),
    contracts: new Set([...src.matchAll(/\b(?:contract|interface|library)\s+(\w+)/g)].map((m) => m[1])),
  };
}

// ── 來源載入 ─────────────────────────────────────────────────────────────────

/**
 * 讀 repo 的所有來源。回傳 ctx：位址解析、ABI、原始碼事件、文件標題、角色、資產 ID…
 */
export function loadContext(root) {
  const addressesSrc = read(root, "frontend/src/contracts/addresses.ts");
  const chains = parseFrontendConfig(
    addressesSrc,
    read(root, "frontend/src/contracts/sessionManager.ts"),
    read(root, "frontend/src/contracts/x402.ts"),
  );

  // V2_STACK[84532].tokens：parseFrontendConfig 只取最外層鍵，代幣在巢狀區塊裡，這裡另外取。
  const v2Tokens = {};
  {
    const i = addressesSrc.indexOf("export const V2_STACK");
    const body = braceBlock(addressesSrc, addressesSrc.indexOf("= {", i));
    const j = body?.search(/\b84532\s*:\s*\{/) ?? -1;
    const chainBlock = j >= 0 ? braceBlock(body, j) : null;
    const t = chainBlock?.indexOf("tokens") ?? -1;
    const tokBlock = t >= 0 ? braceBlock(chainBlock, t) : "";
    for (const m of (tokBlock ?? "").matchAll(/(\w+)\s*:\s*["'](0x[0-9a-fA-F]{40})["']/g)) v2Tokens[m[1]] = m[2];
  }

  // ASSET_IDS
  const assetIds = {};
  {
    const block = braceBlock(addressesSrc, addressesSrc.indexOf("export const ASSET_IDS"));
    for (const m of (block ?? "").matchAll(/(\w+)\s*:\s*["'](0x[0-9a-fA-F]{64})["']/g)) assetIds[m[1]] = m[2];
  }

  // 位址來源的說明文字（給 rules.md）。
  const showcase = new Set(["ChainlinkAdapter", "PythAdapter", "AggregatorOracle"]);
  const v2Keys = new Set(["GuardedOracle", "AssetVaultV2", "ESGRegistryV2", "SustainabilityBadge"]);
  const resolveRef = (ref, chainId = "84532") => {
    if (ref.startsWith("V2_STACK.tokens.")) {
      const sym = ref.slice("V2_STACK.tokens.".length);
      return { address: v2Tokens[sym] ?? null, source: `addresses.ts V2_STACK[${chainId}].tokens.${sym}` };
    }
    const address = chains[chainId]?.roles[ref] ?? null;
    let source = `addresses.ts BASE_SEPOLIA.${ref}`;
    if (showcase.has(ref)) source = `addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.${ref}`;
    else if (v2Keys.has(ref)) source = `addresses.ts V2_STACK[${chainId}].${ref}`;
    else if (ref === "X402FeeRouter") source = `x402.ts X402_FEE_ROUTER[${chainId}]`;
    else if (ref === "AgentSessionManager") source = `sessionManager.ts SESSION_MANAGER_ADDRESS[${chainId}]`;
    return { address, source };
  };

  const abiDir = join(root, "frontend/src/contracts/abi");
  const abis = {};
  for (const f of readdirSync(abiDir).filter((f) => f.endsWith(".json"))) {
    const j = JSON.parse(readFileSync(join(abiDir, f), "utf8"));
    abis[f.replace(/\.json$/, "")] = Array.isArray(j) ? j : j.abi;
  }

  const typeNames = solTypeNames(root);
  const solCache = {};
  const solEvents = (path) => {
    if (!(path in solCache)) {
      const full = join(root, path);
      solCache[path] = existsSync(full) ? parseSolEvents(readFileSync(full, "utf8"), typeNames) : null;
    }
    return solCache[path];
  };

  // 角色雜湊 → 名稱：從 contracts/src 的 `X_ROLE = keccak256("X_ROLE")` 收集，加上 DEFAULT_ADMIN_ROLE。
  const roleNames = { ["0x" + "0".repeat(64)]: "DEFAULT_ADMIN_ROLE" };
  {
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".sol")) {
          for (const m of readFileSync(p, "utf8").matchAll(/constant\s+(\w+_ROLE)\s*=\s*keccak256\("(\w+)"\)/g)) {
            roleNames[keccak256(m[2])] = m[1];
          }
        }
      }
    };
    walk(join(root, "contracts/src"));
  }

  const docHeadings = {};
  const headings = (doc) => {
    if (!(doc in docHeadings)) docHeadings[doc] = existsSync(join(root, doc)) ? headingsOf(read(root, doc)) : null;
    return docHeadings[doc];
  };

  const tokenDecimals = (token) => {
    const t = TOKENS[token];
    if (!t) throw new Error(`未知的代幣 ${token}（只認得 ${Object.keys(TOKENS).join("/")}）`);
    if (t.fixed !== undefined) return t.fixed;
    const src = read(root, t.file);
    if (/function\s+decimals\s*\(/.test(src)) {
      throw new Error(`${t.file} 覆寫了 decimals()，請更新 check-monitoring.mjs 的 TOKENS`);
    }
    return t.default;
  };

  /** 代幣標籤 → 位址（MockUSDC 來自 addresses.ts；官方 USDC 來自 agent/shared/src/env.ts 的常數）。 */
  const tokenAddress = (token) => {
    const t = TOKENS[token];
    if (!t) throw new Error(`未知的代幣 ${token}（只認得 ${Object.keys(TOKENS).join("/")}）`);
    if (t.ref) return resolveRef(t.ref).address;
    const m = read(root, t.constant.file).match(new RegExp(`${t.constant.name}\\s*=\\s*["'](0x[0-9a-fA-F]{40})["']`));
    if (!m) throw new Error(`${t.constant.file} 找不到 ${t.constant.name}`);
    return m[1];
  };

  const sdkUrl = read(root, "agent/sdk/src/signalApi.ts").match(/SIGNAL_API_TESTNET_URL\s*=\s*"([^"]+)"/)?.[1] ?? null;

  const deployed = loadDeployed(root);
  return { root, chains, v2Tokens, assetIds, resolveRef, abis, solEvents, roleNames, headings, tokenDecimals, tokenAddress, sdkUrl, deployed };
}

// ── 已部署 bytecode 與鏈上快照（deployed.json）────────────────────────────────

const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const readKey = (address, fn) => `${lc(address)}|${fn}`;
const wordToAddr = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0").slice(24);

/**
 * 讀 deployed.json，回傳查詢介面（檔案不存在時每個查詢都回 null，由呼叫端報「需要 --refresh-deployed」）。
 *   codeOf(addr)          → 該位址的 runtime bytecode（proxy 則接上實作的 bytecode），沒有記錄回 null
 *   hasTopic(addr, sig)   → 事件 topic0 是否出現在 bytecode；沒有記錄回 null
 *   hasSelector(addr, fn) → 函式 selector 是否出現在 bytecode；沒有記錄回 null
 *   read(addr, fn)        → 該 getter 的鏈上快照（位址或數值的 32 bytes hex）；沒有記錄回 null
 *
 * 為什麼存完整 bytecode 而不是「PUSH32 常數清單」：線性反組譯會被資料段帶偏，實測 2026-10-01
 * 在 PerpetualExchange.PositionClosed 與 AssetVaultV2.RoleGranted 上漏判；子字串比對沒有這個問題。
 */
export function loadDeployed(root) {
  const file = join(root, DEPLOYED_FILE);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const cache = new Map();
  const codeOf = (address) => {
    const k = lc(address ?? "");
    if (cache.has(k)) return cache.get(k);
    const c = data?.contracts?.[k];
    let code = null;
    if (c) {
      const own = data.codes?.[c.codeHash];
      const impl = c.implCodeHash ? data.codes?.[c.implCodeHash] : "";
      if (typeof own === "string" && typeof impl === "string") code = (own + impl.replace(/^0x/, "")).toLowerCase();
    }
    cache.set(k, code);
    return code;
  };
  const hashes = new Map(); // 簽章 → keccak256（BigInt 實作慢，同一個簽章會被問很多次）
  const hashOf = (sig) => {
    if (!hashes.has(sig)) hashes.set(sig, keccak256(sig));
    return hashes.get(sig);
  };
  const hasHex = (address, hex) => {
    const code = codeOf(address);
    return code === null ? null : code.includes(hex.replace(/^0x/, "").toLowerCase());
  };
  return {
    data,
    codeOf,
    hasTopic: (address, sig) => (codeOf(address) === null ? null : hasHex(address, hashOf(sig))),
    hasSelector: (address, fn) => (codeOf(address) === null ? null : hasHex(address, hashOf(fn).slice(0, 10))),
    read: (address, fn) => data?.reads?.[readKey(address, fn)] ?? null,
    implOf: (address) => data?.contracts?.[lc(address ?? "")]?.impl ?? null,
  };
}

/**
 * deployed.json 應該涵蓋什麼：每條規則的合約位址（pending-deploy 規則的合約若已有位址也算，
 * 用來確認「部署版真的不發這個事件」）、接線規則的每個 getter、金額規則的代幣與小數位。
 */
export function deployedTargets(cfg, ctx) {
  const addresses = new Map(); // lc(addr) → ref（僅供訊息用）
  const reads = new Map(); // readKey → { to, fn }
  const tokenHolders = new Map(); // lc(addr) → ref：要讀 usdc() 再讀該代幣 decimals() 的合約
  const addrOf = (ref) => {
    const a = ctx.resolveRef(ref).address;
    return a && ADDR.test(a) && lc(a) !== ZERO ? a : null;
  };
  for (const rule of cfg.rules ?? []) {
    for (const c of rule.contracts ?? []) {
      const a = addrOf(c.ref);
      if (!a) continue;
      if (!addresses.has(lc(a))) addresses.set(lc(a), c.ref);
      if (rule.status === "active" && (rule.amount || rule.token)) {
        const abi = ctx.abis[c.abi];
        if (abi?.some((x) => x.type === "function" && abiSig(x) === TOKEN_GETTER)) tokenHolders.set(lc(a), c.ref);
      }
    }
    if (rule.status === "active" && rule.check === "wiring") {
      for (const call of rule.calls ?? []) {
        const c = (rule.contracts ?? []).find((x) => x.as === call.on);
        const a = c && addrOf(c.ref);
        if (a) reads.set(readKey(a, call.fn), { to: a, fn: call.fn });
      }
    }
  }
  return { addresses, reads, tokenHolders };
}

/** deployed.json 自身的完整性：雜湊對得上內容、沒有缺也沒有多。回傳 problems。 */
export function checkDeployed(cfg, ctx) {
  const problems = [];
  const d = ctx.deployed.data;
  const hint = "執行 node scripts/check-monitoring.mjs --refresh-deployed（唯讀 RPC）後再 --write";
  if (!d) return [`${DEPLOYED_FILE} 不存在 —— ${hint}`];
  if (d.chainId !== cfg.network?.chainId) problems.push(`${DEPLOYED_FILE} 的 chainId ${d.chainId} 不等於 network.chainId ${cfg.network?.chainId}`);
  for (const [hash, code] of Object.entries(d.codes ?? {})) {
    if (!/^0x([0-9a-f]{2})+$/.test(code)) problems.push(`${DEPLOYED_FILE} codes[${hash}] 不是合法的 hex bytecode`);
    else if (keccak256(hexToBytes(code)) !== hash) problems.push(`${DEPLOYED_FILE} codes[${hash}] 的內容與雜湊不符（被手改？）—— ${hint}`);
  }
  const { addresses, reads, tokenHolders } = deployedTargets(cfg, ctx);
  for (const [a, ref] of addresses) {
    if (ctx.deployed.codeOf(a) === null) problems.push(`${DEPLOYED_FILE} 沒有 ${ref}（${a}）的 bytecode：位址換了或 fixture 過期 —— ${hint}`);
  }
  for (const a of Object.keys(d.contracts ?? {})) {
    if (!addresses.has(a)) problems.push(`${DEPLOYED_FILE} 多了沒有規則在用的位址 ${a} —— ${hint}`);
  }
  for (const [k, r] of reads) {
    if (d.reads?.[k] === undefined) problems.push(`${DEPLOYED_FILE} 沒有 ${r.to} ${r.fn} 的鏈上快照 —— ${hint}`);
  }
  for (const [a, ref] of tokenHolders) {
    const tok = d.reads?.[readKey(a, TOKEN_GETTER)];
    if (!tok) problems.push(`${DEPLOYED_FILE} 沒有 ${ref}.${TOKEN_GETTER} 的鏈上快照 —— ${hint}`);
    else if (d.reads?.[readKey(wordToAddr(tok), "decimals()")] === undefined) problems.push(`${DEPLOYED_FILE} 沒有代幣 ${wordToAddr(tok)} 的 decimals() 快照 —— ${hint}`);
  }
  return problems;
}

/**
 * 以唯讀 RPC 重抓 deployed.json。只用 eth_chainId／eth_blockNumber／eth_getCode／eth_getStorageAt／
 * eth_call，全部釘在同一個區塊；不送交易、不需要任何金鑰。CI 不跑這個（CI 不連網）。
 */
export async function refreshDeployed({ root, rpcUrl, fetchImpl = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const ctx = loadContext(root);
  const cfg = JSON.parse(readFileSync(join(root, "ops/monitoring/monitors.json"), "utf8"));
  const url = rpcUrl ?? cfg.network.publicRpc;
  const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);
  let id = 1;
  const rpc = async (method, params) => {
    if (!ALLOWED.has(method)) throw new Error(`refresh 不允許的 RPC 方法 ${method}`);
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      const limited = res.status === 429 || j?.error?.code === -32007 || /limit reached|rate limit/i.test(j?.error?.message ?? "");
      if (limited || res.status >= 500) {
        await sleep(1500);
        continue;
      }
      if (!res.ok || !j) throw new Error(`${method} HTTP ${res.status}：${text.slice(0, 160)}`);
      return j; // { result } 或 { error }（eth_call revert）
    }
    throw new Error(`${method} 連續被限流或 5xx`);
  };
  const must = async (method, params) => {
    const j = await rpc(method, params);
    if (j.error) throw new Error(`${method} ${JSON.stringify(params[0]).slice(0, 80)}：${j.error.message}`);
    return j.result;
  };

  const chainId = Number(BigInt(await must("eth_chainId", [])));
  if (chainId !== cfg.network.chainId) throw new Error(`RPC 的 chainId ${chainId} 不是 ${cfg.network.chainId}`);
  const block = await must("eth_blockNumber", []);
  const out = { chainId, block: Number(BigInt(block)), fetchedAt: new Date().toISOString().slice(0, 10), contracts: {}, reads: {}, codes: {} };
  const addCode = (code) => {
    const hash = keccak256(hexToBytes(code));
    out.codes[hash] = code.toLowerCase();
    return hash;
  };
  const { addresses, reads, tokenHolders } = deployedTargets(cfg, ctx);
  for (const [a, ref] of [...addresses].sort()) {
    const code = await must("eth_getCode", [a, block]);
    if (code === "0x") throw new Error(`${ref}（${a}）在鏈上沒有程式碼`);
    const slot = await must("eth_getStorageAt", [a, IMPL_SLOT, block]);
    const entry = { ref, codeHash: addCode(code), impl: null, implCodeHash: null };
    if (BigInt(slot) !== 0n) {
      entry.impl = wordToAddr(slot);
      entry.implCodeHash = addCode(await must("eth_getCode", [entry.impl, block]));
    }
    out.contracts[a] = entry;
    log(`  ${ref} ${a} ${(code.length - 2) / 2} bytes${entry.impl ? `（實作 ${entry.impl}）` : ""}`);
  }
  const call = async (to, fn) => {
    const j = await rpc("eth_call", [{ to, data: selector(fn) }, block]);
    if (j.error) throw new Error(`eth_call ${to} ${fn} 失敗：${j.error.message}（部署版沒有這個函式？）`);
    out.reads[readKey(to, fn)] = j.result;
    return j.result;
  };
  for (const [, r] of [...reads].sort()) await call(r.to, r.fn);
  for (const [a] of [...tokenHolders].sort()) {
    const tok = wordToAddr(await call(a, TOKEN_GETTER));
    if (out.reads[readKey(tok, "decimals()")] === undefined) await call(tok, "decimals()");
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  const file = {
    $comment:
      "已部署合約的 runtime bytecode 與幾個 getter 的鏈上快照。由 node scripts/check-monitoring.mjs --refresh-deployed 以唯讀 RPC 產生，不要手改（CI 會驗 codes 的 keccak256）。用途：確認 active 事件的 topic0 與 state 規則的 selector 真的在部署版 bytecode 裡、接線規則的預期值等於鏈上實況、金額小數位等於代幣的 decimals()。合約重新部署、UUPS 升級或新增規則後要重抓。",
    chainId: out.chainId,
    block: out.block,
    fetchedAt: out.fetchedAt,
    contracts: sorted(out.contracts),
    reads: sorted(out.reads),
    codes: sorted(out.codes),
  };
  writeFileSync(join(root, DEPLOYED_FILE), JSON.stringify(file, null, 1) + "\n");
  log(`已寫入 ${DEPLOYED_FILE}：區塊 ${out.block}，${Object.keys(out.contracts).length} 個位址、${Object.keys(out.codes).length} 份 bytecode、${Object.keys(out.reads).length} 個快照`);
  return file;
}

// ── 產生 ─────────────────────────────────────────────────────────────────────

const strip = (cfg) => {
  const c = structuredClone(cfg);
  delete c.assets;
  delete c.assetLabels;
  delete c.roleNames;
  for (const r of c.rules ?? []) {
    delete r.runbookUrl;
    delete r.decimals;
    if (r.amount) delete r.amount.decimals;
    for (const k of r.contracts ?? []) delete k.address;
    for (const e of r.events ?? []) {
      delete e.topic0;
      delete e.inputs;
    }
    for (const call of r.calls ?? []) {
      delete call.selector;
      delete call.expected;
    }
  }
  return c;
};

/**
 * 從手寫欄位與 repo 來源算出完整設定。回傳 { config, problems }：problems 是
 * 無法產生的錯（未知合約、ABI 裡沒有的事件…），這些用 --write 也修不好。
 */
export function generate(input, ctx) {
  const problems = [];
  const cfg = strip(input);
  const p = (rule, msg) => problems.push(`${rule?.id ?? "(全域)"}：${msg}`);

  const ids = new Set();
  for (const rule of cfg.rules ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id ?? "")) p(rule, "id 必須是小寫 kebab-case");
    if (ids.has(rule.id)) p(rule, "id 重複");
    ids.add(rule.id);
    if (!KINDS.includes(rule.kind)) p(rule, `kind 必須是 ${KINDS.join("/")}`);
    if (!STATUSES.includes(rule.status)) p(rule, `status 必須是 ${STATUSES.join("/")}`);
    if (!SEVERITIES.includes(rule.severity)) p(rule, `severity 必須是 ${SEVERITIES.join("/")}`);
    for (const f of ["title", "description", "category"]) if (!rule[f]) p(rule, `缺少 ${f}`);
    const active = rule.status === "active";

    // 合約位址
    for (const c of rule.contracts ?? []) {
      if (active) {
        if (!c.abi) p(rule, `${c.ref}：active 規則必須指定 abi`);
        else if (!ctx.abis[c.abi]) p(rule, `${c.ref}：frontend/src/contracts/abi/${c.abi}.json 不存在`);
        const { address } = ctx.resolveRef(c.ref);
        if (!address || !ADDR.test(address) || lc(address) === ZERO) {
          p(rule, `${c.ref}：前端設定裡解析不到 chain 84532 的位址（或為零位址）`);
          c.address = null;
        } else c.address = address;
      } else {
        if (!c.source) p(rule, `${c.ref}：pending-deploy 規則必須指定 source（Solidity 原始碼路徑）`);
        else if (!ctx.solEvents(c.source)) p(rule, `${c.ref}：原始碼 ${c.source} 不存在（CI 需要 submodules）`);
        c.address = null; // 未部署：不給位址，Worker 也不載入
      }
    }

    // 事件
    if (rule.kind === "event") {
      if (!rule.events?.length) p(rule, "event 規則至少要有一個事件");
      for (const ev of rule.events ?? []) {
        ev.topic0 = keccak256(ev.sig);
        let inputs = null;
        for (const c of rule.contracts ?? []) {
          let found;
          if (active) {
            const abi = ctx.abis[c.abi];
            if (!abi) continue;
            found = abi.find((x) => x.type === "event" && abiSig(x) === ev.sig);
            if (!found) {
              p(rule, `${ev.sig} 不在 ${c.abi}.json 的 ABI 裡（${c.ref}）——監控一個不存在的事件永遠不會響`);
              continue;
            }
            found = { inputs: found.inputs.map((i) => ({ name: i.name, type: canonicalType(i), indexed: !!i.indexed })) };
          } else {
            const evs = c.source ? ctx.solEvents(c.source) : null;
            if (!evs) continue;
            found = evs.find((x) => x.sig === ev.sig);
            if (!found) {
              p(rule, `${ev.sig} 沒有宣告在 ${c.source}`);
              continue;
            }
          }
          if (!inputs) inputs = found.inputs;
          else if (JSON.stringify(inputs) !== JSON.stringify(found.inputs)) {
            p(rule, `${ev.sig} 在不同合約的參數名稱或 indexed 不一致（${c.ref}），解碼會錯`);
          }
        }
        ev.inputs = inputs ?? [];
        checkEventDeployed(rule, ev, ctx, p);
      }
      if (active && (rule.events ?? []).length && (rule.contracts ?? []).length && ctx.deployed.data) {
        const live = rule.events.some((ev) => rule.contracts.some((c) => c.address && ctx.deployed.hasTopic(c.address, ev.sig) !== false));
        if (!live) p(rule, "沒有任何一個事件出現在已部署的 bytecode 裡：這條規則永遠不會響，必須改成 pending-deploy（並補一條狀態規則）");
      }
      if (rule.amount) {
        const a = rule.amount;
        if ((rule.events ?? []).length !== 1) p(rule, "amount 規則只能有一個事件");
        const inp = rule.events?.[0]?.inputs?.find((i) => i.name === a.param);
        if (!inp) p(rule, `amount.param ${a.param} 不是事件參數`);
        else if (inp.indexed || !/^uint\d*$/.test(inp.type)) p(rule, `amount.param ${a.param} 必須是非 indexed 的 uint`);
        for (const k of ["threshold", "windowThreshold", "windowSec"]) {
          if (a[k] && !cfg.params?.[a[k]]) p(rule, `amount.${k} 參照未定義的參數 ${a[k]}`);
        }
        if (!a.threshold) p(rule, "amount 規則必須有 threshold");
        if (!!a.windowThreshold !== !!a.windowSec) p(rule, "windowThreshold 與 windowSec 必須同時設定");
        try {
          a.decimals = ctx.tokenDecimals(a.token);
          if (active) checkTokenOnChain(rule, a.token, a.decimals, ctx, p);
        } catch (e) {
          p(rule, e.message);
        }
      }
    } else if (rule.events) p(rule, "只有 event 規則可以有 events");

    // state：函式與 selector
    if (rule.kind === "state") {
      if (!engineInternal.checks[rule.check]) p(rule, `未知的 state 檢查 ${rule.check}`);
      for (const call of rule.calls ?? []) {
        const c = (rule.contracts ?? []).find((x) => x.as === call.on);
        if (!c) {
          p(rule, `calls.on=${call.on} 沒有對應的 contracts[].as`);
          continue;
        }
        const abi = ctx.abis[c.abi];
        const fnAbi = abi?.find((x) => x.type === "function" && abiSig(x) === call.fn);
        if (abi && !fnAbi) p(rule, `${call.fn} 不在 ${c.abi}.json 的 ABI 裡`);
        call.selector = selector(call.fn);
        if (active && c.address && ctx.deployed.hasSelector(c.address, call.fn) === false) {
          p(rule, `${call.fn} 的 selector 不在 ${c.ref} 已部署的 bytecode 裡 —— 部署版沒有這個函式，讀取只會 revert`);
        }
        if (rule.check === "wiring") checkWiringCall(rule, c, call, fnAbi, ctx, p);
        else if (call.expect) p(rule, `只有 wiring 檢查的 calls 可以有 expect（${call.fn}）`);
      }
      if (rule.check === "wiring" && !(rule.calls ?? []).length) p(rule, "wiring 規則至少要有一個 calls");
      if (rule.token) {
        try {
          rule.decimals = ctx.tokenDecimals(rule.token);
          if (active) checkTokenOnChain(rule, rule.token, rule.decimals, ctx, p);
        } catch (e) {
          p(rule, e.message);
        }
      }
      for (const s of [...(rule.assets ?? []), ...(rule.cryptoAssets ?? [])]) {
        if (!ctx.assetIds[s]) p(rule, `資產 ${s} 不在 addresses.ts 的 ASSET_IDS`);
      }
    }
    if (rule.kind === "http" && !engineInternal.httpChecks[rule.check]) p(rule, `未知的 http 檢查 ${rule.check}`);

    // 處置段落
    if (!rule.runbook?.length) p(rule, `至少要對應一個 ${IR_DOC} 的處置段落`);
    const irHeads = ctx.headings(IR_DOC);
    for (const h of rule.runbook ?? []) {
      if (!irHeads?.has(h)) p(rule, `runbook「${h}」不是 ${IR_DOC} 的標題`);
    }
    if (rule.runbook?.[0]) rule.runbookUrl = `${cfg.repoBlobBase}/${IR_DOC}#${slug(rule.runbook[0])}`;
    for (const r of rule.related ?? []) {
      const [doc, head] = r.split("#");
      const hs = ctx.headings(doc);
      if (!hs) p(rule, `related 文件 ${doc} 不存在`);
      else if (!hs.has(head)) p(rule, `related「${head}」不是 ${doc} 的標題`);
    }
  }

  // 全域產生欄位
  cfg.assets = {};
  cfg.assetLabels = {};
  for (const [sym, id] of Object.entries(ctx.assetIds)) {
    if (keccak256(sym) !== lc(id)) problems.push(`(全域)：addresses.ts ASSET_IDS.${sym} 不等於 keccak256("${sym}")`);
    cfg.assets[sym] = lc(id);
    cfg.assetLabels[lc(id)] = sym;
  }
  cfg.roleNames = ctx.roleNames;

  // 參數
  const used = new Set();
  for (const src of [engineSource(ctx.root)]) {
    for (const m of src.matchAll(/(?:numParam|param)\(config, env, "([A-Z0-9_]+)"\)/g)) used.add(m[1]);
  }
  for (const name of used) if (!cfg.params?.[name]) problems.push(`(全域)：engine.mjs 用到參數 ${name}，但 monitors.json 沒有定義`);
  if (cfg.params?.SIGNAL_API_URL?.default !== ctx.sdkUrl) {
    problems.push(`(全域)：SIGNAL_API_URL 預設值必須等於 agent/sdk/src/signalApi.ts 的 SIGNAL_API_TESTNET_URL（${ctx.sdkUrl}）`);
  }
  return { config: cfg, problems };
}
const engineSource = (root) => read(root, "ops/monitoring/engine.mjs");

/** 事件簽章的 notDeployed 宣告（true = 這條規則的所有合約；陣列 = 指定的 ref）。 */
const notDeployedRefs = (rule, ev) =>
  ev.notDeployed === true ? (rule.contracts ?? []).map((c) => c.ref) : Array.isArray(ev.notDeployed) ? ev.notDeployed : [];

/**
 * 事件 × 已部署 bytecode（審查 H2）。
 *   active：topic0 不在 bytecode ⇒ 這個事件永遠不會響。必須由人明確標 notDeployed（並寫 note 說明
 *           由什麼替代），rules.md 會標「部署版不發此事件」；標了卻其實會發也是錯（標記過期）。
 *   pending-deploy：合約若已有位址，topic0 出現在 bytecode ⇒ 已經部署了，規則該改 active。
 */
function checkEventDeployed(rule, ev, ctx, p) {
  if (ev.notDeployed !== undefined && ev.notDeployed !== true && !Array.isArray(ev.notDeployed)) {
    p(rule, `${ev.sig} 的 notDeployed 必須是 true 或合約 ref 的陣列`);
  }
  const declared = notDeployedRefs(rule, ev);
  const refs = (rule.contracts ?? []).map((c) => c.ref);
  for (const r of declared) if (!refs.includes(r)) p(rule, `${ev.sig} 的 notDeployed 含不在這條規則裡的合約 ${r}`);
  if (rule.status !== "active") {
    if (ev.notDeployed !== undefined) p(rule, `${ev.sig}：pending-deploy 規則不需要 notDeployed`);
    for (const c of rule.contracts ?? []) {
      const a = ctx.resolveRef(c.ref).address;
      if (a && ADDR.test(a) && lc(a) !== ZERO && ctx.deployed.hasTopic(a, ev.sig) === true) {
        p(rule, `${ev.sig} 已出現在 ${c.ref} 已部署的 bytecode 裡 —— 合約已經會發這個事件，規則該改成 active`);
      }
    }
    return;
  }
  if (declared.length && !String(ev.note ?? "").trim()) p(rule, `${ev.sig} 標了 notDeployed，必須寫 note 說明（部署版為什麼不發、由什麼替代）`);
  for (const c of rule.contracts ?? []) {
    if (!c.address) continue;
    const has = ctx.deployed.hasTopic(c.address, ev.sig);
    if (has === null) continue; // deployed.json 沒有這個位址：checkDeployed 會報
    const marked = declared.includes(c.ref);
    if (!has && !marked) {
      p(rule, `${ev.sig} 的 topic0 不在 ${c.ref} 已部署的 bytecode 裡 —— 部署版不發此事件，這個告警永遠不會響。改用狀態規則，並把事件標 notDeployed 或移到 pending-deploy 規則`);
    } else if (has && marked) {
      p(rule, `${ev.sig} 標了 notDeployed（${c.ref}），但部署版其實會發 —— 移除標記`);
    }
  }
}

/** wiring 規則的每個讀取：零參數、回傳 address；預期值來自 addresses.ts、零位址或鏈上快照。 */
function checkWiringCall(rule, c, call, fnAbi, ctx, p) {
  if (fnAbi && (fnAbi.inputs.length !== 0 || fnAbi.outputs?.length !== 1 || fnAbi.outputs[0].type !== "address")) {
    p(rule, `wiring 的 ${call.fn} 必須是零參數、回傳單一 address 的函式`);
  }
  const e = call.expect ?? {};
  const kinds = ["ref", "zero", "snapshot"].filter((k) => e[k] !== undefined && e[k] !== false);
  if (kinds.length !== 1) {
    p(rule, `${call.on}.${call.fn} 的 expect 必須恰好指定 ref／zero／snapshot 其中之一`);
    return;
  }
  const snap = c.address ? ctx.deployed.read(c.address, call.fn) : null;
  const snapAddr = snap ? wordToAddr(snap) : null;
  let expected = null;
  if (e.ref !== undefined) {
    const a = ctx.resolveRef(e.ref).address;
    if (!a || !ADDR.test(a) || lc(a) === ZERO) p(rule, `${call.on}.${call.fn} 的 expect.ref ${e.ref} 在前端設定裡解析不到位址`);
    else expected = a;
  } else if (e.zero) expected = ZERO;
  else {
    if (!String(call.note ?? "").trim()) p(rule, `${call.on}.${call.fn} 用鏈上快照當預期值，必須寫 note 說明為什麼前端設定沒有這個位址`);
    expected = snapAddr;
  }
  if (snapAddr && expected && lc(snapAddr) !== lc(expected)) {
    p(rule, `${c.ref}.${call.fn} 的鏈上快照是 ${snapAddr}，但預期 ${expected}（${e.ref ?? "零位址"}）—— 鏈上接線與前端設定不一致`);
  }
  call.expected = expected;
}

/** 金額規則的代幣標籤必須等於合約 usdc() 的鏈上快照；小數位必須等於該代幣 decimals() 的快照。 */
function checkTokenOnChain(rule, token, decimals, ctx, p) {
  const want = ctx.tokenAddress(token);
  for (const c of rule.contracts ?? []) {
    if (!c.address) continue;
    const abi = ctx.abis[c.abi];
    if (!abi?.some((x) => x.type === "function" && abiSig(x) === TOKEN_GETTER)) continue;
    const snap = ctx.deployed.read(c.address, TOKEN_GETTER);
    if (!snap) continue; // checkDeployed 會報
    const tok = wordToAddr(snap);
    if (!want || lc(tok) !== lc(want)) {
      p(rule, `token 標成 ${token}（${want}），但 ${c.ref}.${TOKEN_GETTER} 的鏈上快照是 ${tok} —— 標籤錯了，金額會差 10^12 倍`);
      continue;
    }
    const d = ctx.deployed.read(tok, "decimals()");
    if (d && Number(BigInt(d)) !== decimals) p(rule, `${token} 的 decimals() 鏈上快照是 ${Number(BigInt(d))}，設定推得 ${decimals}`);
  }
}

// ── rules.md ─────────────────────────────────────────────────────────────────

const KIND_TEXT = { event: "事件", state: "狀態", http: "HTTP" };
/**
 * 規則狀態的人讀文字。pending-deploy 有兩種：合約還沒部署（待部署），或合約已部署、
 * 但鏈上的版本不發這個事件（部署版不發此事件）——後者不可以被讀成「運作中」。
 */
const isLiveContract = (ctx, ref) => {
  const a = ctx.resolveRef(ref).address;
  return !!a && ADDR.test(a) && lc(a) !== ZERO;
};
const dormant = (rule, ctx) => rule.status !== "active" && (rule.contracts ?? []).length > 0 && rule.contracts.every((c) => isLiveContract(ctx, c.ref));
const statusText = (rule, ctx) => (rule.status === "active" ? "運作中" : dormant(rule, ctx) ? "部署版不發此事件" : "待部署");
const eventText = (rule, e) => {
  const nd = notDeployedRefs(rule, e);
  if (!nd.length) return `\`${e.sig}\``;
  const who = nd.length === (rule.contracts ?? []).length ? "" : `：${nd.join("、")}`;
  return `\`${e.sig}\`（**部署版不發此事件**${who}；${e.note}）`;
};
const expectText = (call) => {
  const e = call.expect ?? {};
  if (e.ref !== undefined) return `\`${e.ref}\`（\`${call.expected}\`）`;
  if (e.zero) return "零位址";
  return `鏈上快照 \`${call.expected}\`（${call.note}）`;
};
const pv = (cfg, name) => `\`${name}\`（預設 ${cfg.params[name]?.default} ${cfg.params[name]?.unit ?? ""}）`.replace(/ ）/, "）");
const THRESHOLD = {
  oracleStaleness: (c) => `加密資產：≥ ${pv(c, "ORACLE_STALE_WARN_SEC")} → SEV-3；≥ 鏈上 \`maxPriceAge()\` → SEV-2。其他資產：≥ ${pv(c, "NONCRYPTO_STALE_SEC")} → SEV-3`,
  oracleDeviation: (c) => `偏離 ≥ ${pv(c, "ORACLE_DEVIATION_BPS")} → SEV-2；≥ ${pv(c, "ORACLE_DEVIATION_CRIT_BPS")} → SEV-1；參考價超過 ${pv(c, "REFERENCE_MAX_AGE_SEC")} 不比對`,
  guardedOraclePaused: () => "`paused() == true`",
  insuranceFund: (c) => `\`totalAssets()\` < ${pv(c, "INSURANCE_MIN_USDC")}，或較 24 小時高點下降 ≥ ${pv(c, "INSURANCE_DROP_BPS")} → SEV-2`,
  vaultReserve: (c) => `儲備率 < \`minReserveRatioBps()\` → SEV-2；< 下限 + ${pv(c, "RESERVE_WARN_MARGIN_BPS")} → SEV-3；mint 自動停止 → SEV-2；無法定價或暫停 → SEV-3`,
  gasBalance: (c) => `< ${pv(c, "GAS_MIN_ETH")} → SEV-3；< ${pv(c, "GAS_CRIT_ETH")} → SEV-2`,
  httpHealth: (c) => `非 200 或內容不是 \`ok\`，連續 ${pv(c, "HTTP_FAILS_BEFORE_ALERT")}`,
  x402PayTo: () => "`payTo` ≠ `EXPECTED_PAY_TO`（未設時為首次觀察值）→ SEV-1；`payToSafety.safe == false` → SEV-3",
  wiring: () => "任一 getter 的讀值 ≠ 預期位址",
};
function thresholdText(cfg, rule) {
  if (rule.kind === "event") {
    if (!rule.amount) return "每一筆";
    const a = rule.amount;
    let t = Number(cfg.params[a.threshold]?.default) === 0 ? `每一筆（${pv(cfg, a.threshold)}）` : `單筆 ≥ ${pv(cfg, a.threshold)}`;
    if (a.windowThreshold) t += `；${pv(cfg, a.windowSec)} 內累計 ≥ ${pv(cfg, a.windowThreshold)}`;
    return `${t}；金額 ${a.decimals} 位小數（${a.token}）`;
  }
  return THRESHOLD[rule.check]?.(cfg) ?? "—";
}
const anchor = (h) => `../../${IR_DOC}#${slug(h)}`;
const relLink = (r) => {
  const [doc, head] = r.split("#");
  return `[${doc.replace(/^docs\//, "")}「${head}」](../../${doc}#${slug(head)})`;
};

export function renderRulesMd(cfg, ctx) {
  const L = [];
  const rules = cfg.rules;
  const active = rules.filter((r) => r.status === "active");
  L.push("# 監控規則清單");
  L.push("");
  L.push("> **由 `node scripts/check-monitoring.mjs --write` 從 [`monitors.json`](monitors.json) 產生，不要手改。**");
  L.push("> CI（`consistency.yml` 的 `monitoring` job）會檢查本檔、`monitors.json` 與前端設定／ABI 三者一致。");
  L.push(">");
  L.push("> - 位址一律由 `frontend/src/contracts/**` 解析（下表「位址來源」），不手抄。");
  L.push("> - 嚴重度定義與處置見 [`docs/INCIDENT_RESPONSE.md`](../../docs/INCIDENT_RESPONSE.md)。");
  L.push("> - 決策與方案比較見 [`docs/ADR-009-monitoring.md`](../../docs/ADR-009-monitoring.md)；部署步驟見 [`README.md`](README.md)。");
  L.push("> - 「待部署」規則的事件只存在於 master 原始碼，對應合約尚未部署；Worker 不載入，部署後改為 `active`。");
  L.push("> - 「**部署版不發此事件**」：合約已部署，但鏈上那一版不發這個事件（前端 ABI 來自 master 原始碼，比部署版新）。");
  L.push(">   這些事件**現在不會響**；有對應 setter 的由「狀態」規則每輪讀 getter 比對。依據是 [`deployed.json`](deployed.json)（唯讀 RPC 抓的 runtime bytecode，CI 離線比對 topic0）。");
  L.push("");
  const dormantCount = rules.filter((r) => dormant(r, ctx)).length;
  L.push(`共 **${rules.length}** 條規則：運作中 ${active.length} 條（事件 ${active.filter((r) => r.kind === "event").length}、狀態 ${active.filter((r) => r.kind === "state").length}、HTTP ${active.filter((r) => r.kind === "http").length}），部署版不發此事件 ${dormantCount} 條，待部署 ${rules.length - active.length - dormantCount} 條。鏈：${cfg.network.name}（${cfg.network.chainId}）。`);
  if (ctx.deployed.data) L.push(`已部署 bytecode 快照：區塊 ${ctx.deployed.data.block}（${ctx.deployed.data.fetchedAt}）。`);
  L.push("");
  L.push("## 總表");
  L.push("");
  L.push("| 規則 | 分類 | 類型 | 嚴重度 | 狀態 | 門檻 | 處置 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of rules) {
    L.push(`| [\`${r.id}\`](#${slug(r.id)}) ${r.title} | ${r.category} | ${KIND_TEXT[r.kind]} | ${r.severity} | ${statusText(r, ctx)} | ${thresholdText(cfg, r).replace(/\|/g, "\\|")} | ${r.runbook.map((h) => `[§${h.split(".")[0]}](${anchor(h)})`).join(" ")} |`);
  }
  L.push("");
  L.push("「嚴重度」是規則的預設等級；狀態規則依門檻在 SEV-1～SEV-3 之間升降（見各規則）。恢復通知固定標為 SEV-4，但依原嚴重度決定是否送出。");
  L.push("");
  L.push("## 參數（門檻）");
  L.push("");
  L.push("預設值在 `monitors.json`；可用 Worker 的 `[vars]` 覆寫（見 README）。標「待使用者決定」的是佔位值。");
  L.push("");
  L.push("| 參數 | 預設 | 單位 | 說明 |");
  L.push("|---|---|---|---|");
  for (const [k, v] of Object.entries(cfg.params)) L.push(`| \`${k}\` | \`${v.default}\` | ${v.unit} | ${v.doc} |`);
  L.push("");
  L.push("## 規則明細");
  for (const r of rules) {
    L.push("");
    L.push(`### ${r.id}`);
    L.push("");
    L.push(`**${r.title}**｜${r.category}｜${KIND_TEXT[r.kind]}｜${r.severity}｜${statusText(r, ctx)}`);
    L.push("");
    L.push(r.description);
    L.push("");
    if (r.contracts?.length) {
      L.push("| 合約 | 位址來源 | 位址 |");
      L.push("|---|---|---|");
      for (const c of r.contracts) {
        const src = r.status === "active" ? ctx.resolveRef(c.ref).source : isLiveContract(ctx, c.ref) ? `${ctx.resolveRef(c.ref).source}（\`${ctx.resolveRef(c.ref).address}\`）；部署版不發此事件，事件宣告於 \`${c.source}\`` : `尚未部署；事件宣告於 \`${c.source}\``;
        L.push(`| ${c.ref}${c.abi ? `（ABI \`${c.abi}\`）` : ""} | ${src} | ${c.address ? `\`${c.address}\`` : "—"} |`);
      }
      L.push("");
    }
    if (r.events?.length) L.push(`- 事件：${r.events.map((e) => eventText(r, e)).join("、")}`);
    if (r.check === "wiring") {
      for (const c of r.calls ?? []) L.push(`- 預期：\`${r.contracts.find((x) => x.as === c.on)?.ref}.${c.fn}\` = ${expectText(c)}`);
    } else if (r.calls?.length) L.push(`- 讀取：${r.calls.map((c) => `\`${c.on}.${c.fn}\``).join("、")}`);
    if (r.assets?.length) L.push(`- 資產：${r.assets.join("、")}${r.cryptoAssets ? `（加密：${r.cryptoAssets.join("、")}）` : ""}`);
    if (r.kind === "http") L.push(`- 端點：\`{SIGNAL_API_URL}${r.path ?? "/"}\``);
    L.push(`- 門檻：${thresholdText(cfg, r)}`);
    L.push(`- 處置：${r.runbook.map((h) => `[INCIDENT_RESPONSE「${h}」](${anchor(h)})`).join("、")}`);
    if (r.related?.length) L.push(`- 相關：${r.related.map(relLink).join("、")}`);
  }
  L.push("");
  return L.join("\n");
}

// ── 秘密掃描 ─────────────────────────────────────────────────────────────────

export function scanSecrets(files) {
  const problems = [];
  const pats = [
    [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, "疑似 Telegram bot token"],
    [/https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/, "疑似 Discord webhook URL（含 token）"],
    [/https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/, "疑似 Slack webhook URL"],
    [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "疑似 GitHub token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私鑰"],
    [/(?:alchemy\.com\/v2|infura\.io\/v3)\/[A-Za-z0-9]{16,}/, "含 API key 的 RPC URL"],
  ];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const [re, what] of pats) if (re.test(line)) problems.push(`${name}:${i + 1} ${what}`);
      if (/wrangler\.toml$/.test(name) && /\b0x[0-9a-fA-F]{64}\b/.test(line)) problems.push(`${name}:${i + 1} 疑似私鑰（32 bytes hex）`);
    });
  }
  return problems;
}

/** wrangler.toml 的 [vars]：不得含秘密鍵名；鍵必須是已知參數或允許的公開設定。 */
export function checkWranglerVars(toml, params) {
  const problems = [];
  let section = "";
  toml.split("\n").forEach((line, i) => {
    const s = line.replace(/#.*$/, "").trim();
    const h = s.match(/^\[+([^\]]+)\]+$/);
    if (h) {
      section = h[1].trim();
      return;
    }
    if (section !== "vars") return;
    const m = s.match(/^([A-Za-z0-9_]+)\s*=/);
    if (!m) return;
    if (SECRET_NAMES.includes(m[1])) problems.push(`wrangler.toml:${i + 1} ${m[1]} 是秘密，必須用 \`wrangler secret put\`，不能寫在 [vars]`);
    else if (!params[m[1]] && !EXTRA_VARS.includes(m[1])) problems.push(`wrangler.toml:${i + 1} [vars] 的 ${m[1]} 不是已知參數`);
  });
  return problems;
}

// ── 主程式 ───────────────────────────────────────────────────────────────────

function diffPaths(a, b, path = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
  } else out.push({ path, file: a, expected: b });
  return out;
}
const describe = (cfg, path) => {
  const m = path.match(/^\.rules\[(\d+)\]/);
  return m ? path.replace(/^\.rules\[\d+\]/, `rules[${cfg.rules[Number(m[1])]?.id}]`) : path;
};

/**
 * 比對檔案裡的設定與「從來源推得的設定」。回傳 { config, problems, rulesMd }。
 * rulesMd 傳 null 代表不比對 rules.md（--write 時）。
 */
export function checkConfig({ current, ctx, rulesMd }) {
  const { config, problems } = generate(current, ctx);
  const expectedMd = renderRulesMd(config, ctx);
  for (const d of diffPaths(current, config)) {
    const fmt = (v) => (v === undefined ? "（缺）" : JSON.stringify(v)?.slice(0, 90));
    problems.push(`monitors.json ${describe(config, d.path)} = ${fmt(d.file)}，來源推得 ${fmt(d.expected)} —— 執行 node scripts/check-monitoring.mjs --write`);
  }
  if (rulesMd !== null && rulesMd?.replace(/\r\n/g, "\n") !== expectedMd) {
    problems.push("ops/monitoring/rules.md 與 monitors.json 不一致 —— 執行 node scripts/check-monitoring.mjs --write");
  }
  return { config, problems, rulesMd: expectedMd };
}

export function run({ root, write = false, log = console.log }) {
  const dir = join(root, "ops/monitoring");
  const file = join(dir, "monitors.json");
  const current = JSON.parse(readFileSync(file, "utf8"));
  const ctx = loadContext(root);
  const mdPath = join(dir, "rules.md");
  let config;
  let problems;
  if (write) {
    const g = generate(current, ctx);
    ({ config, problems } = g);
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    writeFileSync(mdPath, renderRulesMd(config, ctx));
    log(`已寫入 ${relative(root, file)} 與 ops/monitoring/rules.md`);
  } else {
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : undefined;
    ({ config, problems } = checkConfig({ current, ctx, rulesMd: md }));
  }

  // 秘密與 wrangler [vars]
  const files = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => ({ name: `ops/monitoring/${f}`, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n") }));
  problems.push(...scanSecrets(files));
  const toml = files.find((f) => f.name.endsWith("wrangler.toml"));
  if (!toml) problems.push("ops/monitoring/wrangler.toml 不存在");
  else problems.push(...checkWranglerVars(toml.text, config.params));

  // 已部署 bytecode 快照本身的完整性（雜湊、涵蓋範圍）。pending 規則「事件其實已部署」由 generate 報錯。
  problems.push(...checkDeployed(config, ctx));

  const active = config.rules.filter((r) => r.status === "active");
  log(`規則 ${config.rules.length} 條（運作中 ${active.length}、待部署 ${config.rules.length - active.length}），監控合約位址 ${new Set(active.flatMap((r) => r.contracts.map((c) => lc(c.address)))).size} 個`);
  if (problems.length) {
    for (const p of problems) log(`::error::${p}`);
    log(`\n${problems.length} 個問題`);
  } else {
    log("監控設定與前端設定、ABI、處置文件一致 ✓");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const root = i >= 0 ? resolve(args[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (args.includes("--refresh-deployed")) {
      const k = args.indexOf("--rpc");
      await refreshDeployed({ root, rpcUrl: k >= 0 ? args[k + 1] : undefined });
      console.log("接著執行：node scripts/check-monitoring.mjs --write && node scripts/check-monitoring.mjs");
      process.exit(0);
    }
    const problems = run({ root, write: args.includes("--write") });
    process.exit(problems.length ? 1 : 0);
  } catch (e) {
    console.error(`::error::check-monitoring 中止：${e.message}`);
    process.exit(2);
  }
}
