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
//
// 零依賴。用法：
//   node scripts/check-monitoring.mjs            # 檢查，有問題非零結束
//   node scripts/check-monitoring.mjs --write    # 依來源重新產生 monitors.json 的產生欄位與 rules.md
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
/** 代幣小數位：MockUSDC 沒有覆寫 decimals()（OZ ERC20 預設 18）；Circle 官方 USDC 是 6。 */
const TOKENS = { MockUSDC: { file: "contracts/src/MockUSDC.sol", default: 18 }, USDC: { fixed: 6 } };
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

  const sdkUrl = read(root, "agent/sdk/src/signalApi.ts").match(/SIGNAL_API_TESTNET_URL\s*=\s*"([^"]+)"/)?.[1] ?? null;

  return { root, chains, v2Tokens, assetIds, resolveRef, abis, solEvents, roleNames, headings, tokenDecimals, sdkUrl };
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
    for (const call of r.calls ?? []) delete call.selector;
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
        if (abi && !abi.some((x) => x.type === "function" && abiSig(x) === call.fn)) {
          p(rule, `${call.fn} 不在 ${c.abi}.json 的 ABI 裡`);
        }
        call.selector = selector(call.fn);
      }
      if (rule.token) {
        try {
          rule.decimals = ctx.tokenDecimals(rule.token);
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

// ── rules.md ─────────────────────────────────────────────────────────────────

const KIND_TEXT = { event: "事件", state: "狀態", http: "HTTP" };
const STATUS_TEXT = { active: "運作中", "pending-deploy": "待部署" };
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
  L.push("");
  L.push(`共 **${rules.length}** 條規則：運作中 ${active.length} 條（事件 ${active.filter((r) => r.kind === "event").length}、狀態 ${active.filter((r) => r.kind === "state").length}、HTTP ${active.filter((r) => r.kind === "http").length}），待部署 ${rules.length - active.length} 條。鏈：${cfg.network.name}（${cfg.network.chainId}）。`);
  L.push("");
  L.push("## 總表");
  L.push("");
  L.push("| 規則 | 分類 | 類型 | 嚴重度 | 狀態 | 門檻 | 處置 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of rules) {
    L.push(`| [\`${r.id}\`](#${slug(r.id)}) ${r.title} | ${r.category} | ${KIND_TEXT[r.kind]} | ${r.severity} | ${STATUS_TEXT[r.status]} | ${thresholdText(cfg, r).replace(/\|/g, "\\|")} | ${r.runbook.map((h) => `[§${h.split(".")[0]}](${anchor(h)})`).join(" ")} |`);
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
    L.push(`**${r.title}**｜${r.category}｜${KIND_TEXT[r.kind]}｜${r.severity}｜${STATUS_TEXT[r.status]}`);
    L.push("");
    L.push(r.description);
    L.push("");
    if (r.contracts?.length) {
      L.push("| 合約 | 位址來源 | 位址 |");
      L.push("|---|---|---|");
      for (const c of r.contracts) {
        const src = r.status === "active" ? ctx.resolveRef(c.ref).source : `尚未部署；事件宣告於 \`${c.source}\``;
        L.push(`| ${c.ref}${c.abi ? `（ABI \`${c.abi}\`）` : ""} | ${src} | ${c.address ? `\`${c.address}\`` : "—"} |`);
      }
      L.push("");
    }
    if (r.events?.length) L.push(`- 事件：${r.events.map((e) => `\`${e.sig}\``).join("、")}`);
    if (r.calls?.length) L.push(`- 讀取：${r.calls.map((c) => `\`${c.on}.${c.fn}\``).join("、")}`);
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

  // pending 規則若已出現在前端 ABI，提示可以改 active（不算錯）。
  for (const r of config.rules.filter((x) => x.status === "pending-deploy")) {
    const role = r.contracts[0]?.ref;
    const abi = ctx.abis[role === "AssetVaultV2" ? "AssetVaultV2" : role];
    if (abi && r.events.every((e) => abi.some((x) => x.type === "event" && abiSig(x) === e.sig))) {
      log(`::notice::${r.id} 的事件已出現在前端 ABI ${role}.json，確認部署後可改為 active`);
    }
  }

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
    const problems = run({ root, write: args.includes("--write") });
    process.exit(problems.length ? 1 : 0);
  } catch (e) {
    console.error(`::error::check-monitoring 中止：${e.message}`);
    process.exit(2);
  }
}
