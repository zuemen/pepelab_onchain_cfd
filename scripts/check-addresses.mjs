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
// 用法：
//   node scripts/check-addresses.mjs
//   node scripts/check-addresses.mjs --workflows <dir> --addresses <file> --session <file>
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // admin-base-sepolia.yml 的 workflow_dispatch input；描述寫明預設是 PerpetualExchange。
  "input:target": "PerpetualExchange",
};

const CHAIN_OF_NAME = { "base-sepolia": "84532", sepolia: "11155111" };

export function checkWorkflow({ file, text, chains, allowlist = ALLOWLIST }) {
  const { entries, raw } = scanWorkflow(text);
  const problems = [];
  const name = basename(file);

  // 依 KEEPER_CHAIN（job 層優先於 workflow 層）判斷鏈，再退回檔名；null = 無法判斷。
  // KEEPER_CHAIN 不是位址，所以另外抓一次。
  const chainKeys = [];
  {
    const stack = [];
    text.split(/\r?\n/).forEach((line) => {
      if (/^\s*(#|$)/.test(line)) return;
      const indent = line.match(/^ */)[0].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const m = line.slice(indent).match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) return;
      const v = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
      if (m[1] === "KEEPER_CHAIN") chainKeys.push({ path: stack.map((s) => s.key), value: v });
      if (v === "" || /^[|>]/.test(v)) stack.push({ indent, key: m[1] });
    });
  }
  const jobOf = (path) => (path[0] === "jobs" ? path[1] : null);
  const chainOf = (path) => {
    const job = jobOf(path);
    const hit =
      chainKeys.find((c) => job && jobOf(c.path) === job) ??
      chainKeys.find((c) => c.path[0] === "env");
    if (hit && CHAIN_OF_NAME[hit.value]) return CHAIN_OF_NAME[hit.value];
    if (/base-sepolia/.test(name)) return "84532";
    return null;
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
    const chain = chains[chainId];
    if (role) {
      const expected = chain.roles[role];
      if (!expected) {
        problems.push(`${where} —— 前端設定裡 chain ${chainId} 沒有 ${role}`);
      } else if (expected.toLowerCase() !== e.value.toLowerCase()) {
        problems.push(`${where} —— chain ${chainId} 的 ${role} 應為 ${expected}`);
      }
    } else if (!chain.known.has(e.value.toLowerCase())) {
      problems.push(`${where} —— chain ${chainId} 的前端設定裡沒有這個位址（新鍵請補進 ROLE_OF_KEY 或 allowlist）`);
    }
  }

  // run:／with:／其他非 env 位置的位址：也依 job 的鏈檢查（審查 Medium 4）——
  // 在 Base Sepolia 的 job 裡對 Sepolia exchange 下 cast send，位址「認得」但鏈錯了。
  for (const r of raw) {
    if (r.value.toLowerCase() === ZERO || isAllowed(r.value)) continue;
    const where = `${name}:${r.line} ${r.value}${r.path?.length ? `（${r.path.join(".")}）` : ""}`;
    const chainId = chainOf(r.path ?? []);
    if (chainId) {
      if (!chains[chainId].known.has(r.value.toLowerCase())) {
        problems.push(`${where} —— 寫死在非 env 位置，chain ${chainId} 的前端設定裡沒有這個位址`);
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

export function run({ workflowsDir, addressesFile, sessionFile, x402File, log = console.log }) {
  const chains = loadChains({ addressesFile, sessionFile, x402File });
  const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  let problems = [];
  let checked = 0;
  for (const f of files) {
    const r = checkWorkflow({ file: f, text: readFileSync(join(workflowsDir, f), "utf8"), chains });
    problems = problems.concat(r.problems);
    checked += r.checked;
  }
  for (const [id, c] of Object.entries(chains)) {
    log(`chain ${id}: exchange=${c.roles.PerpetualExchange} oracle=${c.roles.MockOracle} 已知位址 ${c.known.size} 個`);
  }
  log(`掃描 ${files.length} 支 workflow，${checked} 個位址`);
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

  const problems = run({ workflowsDir: opt("--workflows", join(root, ".github/workflows")), ...files });
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
