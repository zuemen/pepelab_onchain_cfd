#!/usr/bin/env node
// 部署後 smoke test（Base Sepolia）：唯讀、不需要任何私鑰。部署或 cutover 之後跑一次，
// 確認「部署了」真的等於「使用者碰得到、而且接對了」。
//
// 檢查四類（任何一項 FAIL → 非零結束）：
//   1. 接線：ops/monitoring/monitors.json 的 active 接線規則（exchange.oracle()、
//      InsuranceVault.exchange()…，與監控 Worker 同一份定義），位址一律由
//      frontend/src/contracts/** 解析；另加 AgentSessionManager.exchange() 與
//      exchange.authorizedAgents(sessionManager)、AssetVaultV2 的 EIP-1967 實作非零。
//   2. 外洩地址：ops/release-status/components.json 列的 owner()／platformTreasury()／角色／
//      authorizedAgents／verifiers，對 agent/shared/src/payoutSafety.ts 的 COMPROMISED_ADDRESSES
//      逐一查；命中即 FAIL。輸出只寫縮寫。
//   3. keeper：exchange 實際讀的 oracle 上每個資產的 updatedAt，與 exchange.maxPriceAge()
//      比（門檻與加密資產清單取自 monitors.json 的 oracle-stale 規則與參數預設值，與監控相同）；
//      keeper 錢包（oracle owner）的 gas 餘額。
//   4. signal-api：GET /healthz、GET /（payTo 與 payToSafety）、未付款的 GET /oracle/sBTC
//      必須回 402 付款要求——回 503 payto_unsafe 代表付費端點 fail-closed。
//
// 只用 eth_chainId／eth_blockNumber／eth_getBlockByNumber／eth_getBalance／eth_getStorageAt／
// eth_call 與 HTTP GET；不送交易、不付款。
//
// 用法：
//   node scripts/post-deploy-smoke.mjs
//   node scripts/post-deploy-smoke.mjs --rpc https://… --signal-api https://… --json out.json
//   node scripts/post-deploy-smoke.mjs --skip-http        # 只做鏈上檢查
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IMPL_SLOT, PRIMARY_CHAIN, loadSources, makeRpc, resolveTargets, shortAddr } from "./check-deployment-status.mjs";
import { keccak256, selector } from "../ops/monitoring/keccak.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (s) => String(s).toLowerCase();
const pad32 = (hex) => String(hex).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const wordToAddr = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0").slice(-40);
export const SMOKE_RPC_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBalance", "eth_getStorageAt", "eth_call"]);
/** keeper 錢包低於這個 ETH 數量時 WARN（與監控 keeper-gas 規則同一個方向；這裡只是部署後的粗檢）。 */
export const KEEPER_MIN_WEI = 10n ** 15n; // 0.001 ETH

export function signalApiUrl(root) {
  const src = readFileSync(join(root, "agent/sdk/src/signalApi.ts"), "utf8");
  const m = src.match(/SIGNAL_API_TESTNET_URL\s*=\s*["'](https:\/\/[^"']+)["']/);
  if (!m) throw new Error("agent/sdk/src/signalApi.ts 找不到 SIGNAL_API_TESTNET_URL");
  return m[1].replace(/\/$/, "");
}

/** monitors.json 的 active 接線規則 → [{ name, to, fn, expected }]（expected 為 null 表示只讀不比）。 */
export function wiringCalls(root, roles) {
  const cfg = JSON.parse(readFileSync(join(root, "ops/monitoring/monitors.json"), "utf8"));
  const out = [];
  for (const rule of cfg.rules ?? []) {
    if (rule.status !== "active" || rule.check !== "wiring") continue;
    for (const call of rule.calls ?? []) {
      const c = (rule.contracts ?? []).find((x) => x.as === call.on);
      const to = c && roles[c.ref];
      if (!to || lc(to) === ZERO) continue;
      let expected = null;
      if (call.expect?.ref) expected = roles[call.expect.ref] ?? null;
      else if (call.expect?.zero) expected = ZERO;
      if (call.expect?.snapshot) continue; // 快照值（例如 treasury）由外洩地址檢查負責
      out.push({ name: `${c.ref}.${call.fn}`, to, fn: call.fn, expected, rule: rule.id });
    }
  }
  if (roles.AgentSessionManager && lc(roles.AgentSessionManager) !== ZERO) {
    out.push({ name: "AgentSessionManager.exchange()", to: roles.AgentSessionManager, fn: "exchange()", expected: roles.PerpetualExchange, rule: "session" });
  }
  return out;
}

export function staleRule(root) {
  const cfg = JSON.parse(readFileSync(join(root, "ops/monitoring/monitors.json"), "utf8"));
  const rule = cfg.rules.find((r) => r.id === "oracle-stale");
  if (!rule) throw new Error("monitors.json 沒有 oracle-stale 規則");
  return {
    assets: rule.assets,
    crypto: new Set(rule.cryptoAssets ?? []),
    assetIds: cfg.assets,
    warnSec: Number(cfg.params.ORACLE_STALE_WARN_SEC.default),
    nonCryptoSec: Number(cfg.params.NONCRYPTO_STALE_SEC.default),
  };
}

const roleHash = (role) => (role === "DEFAULT_ADMIN_ROLE" ? "0x" + "0".repeat(64) : keccak256(role));
const hours = (s) => `${(s / 3600).toFixed(1)} 小時`;

export async function runSmoke({ root, rpcUrl, apiUrl, fetchImpl = fetch, sleep, skipHttp = false, nowSec }) {
  const results = [];
  const add = (group, name, level, detail) => results.push({ group, name, level, detail });
  const src = loadSources(root);
  const roles = src.frontend[PRIMARY_CHAIN].roles;
  const denylist = src.denylist;
  const rpc = makeRpc(rpcUrl ?? src.cfg.chains[PRIMARY_CHAIN].rpc, { fetchImpl, sleep, allowed: SMOKE_RPC_METHODS });
  const must = async (method, params) => {
    const j = await rpc(method, params);
    if (j.error) throw new Error(`${method}：${j.error.message}`);
    return j.result;
  };

  let block;
  let blockTs;
  try {
    const chainId = Number(BigInt(await must("eth_chainId", [])));
    if (String(chainId) !== PRIMARY_CHAIN) throw new Error(`RPC 的 chainId ${chainId} 不是 ${PRIMARY_CHAIN}`);
    block = await must("eth_blockNumber", []);
    const b = await must("eth_getBlockByNumber", [block, false]);
    blockTs = Number(BigInt(b.timestamp));
    add("RPC", "Base Sepolia", "PASS", `區塊 ${Number(BigInt(block))}`);
  } catch (e) {
    add("RPC", "Base Sepolia", "FAIL", e.message);
    return results;
  }
  const call = async (to, data) => {
    const j = await rpc("eth_call", [{ to, data }, block]);
    return j.error ? { error: j.error.message } : { value: j.result };
  };

  // 1. 接線
  for (const w of wiringCalls(root, roles)) {
    const r = await call(w.to, selector(w.fn));
    if (r.error) {
      add("接線", w.name, "FAIL", `呼叫失敗：${r.error}`);
      continue;
    }
    const got = wordToAddr(r.value);
    if (w.expected === null) add("接線", w.name, "PASS", got);
    else if (lc(got) === lc(w.expected)) add("接線", w.name, "PASS", `= ${got}`);
    else add("接線", w.name, "FAIL", `鏈上 ${denylist.includes(lc(got)) ? shortAddr(got) : got}，前端設定 ${w.expected}`);
  }
  if (roles.AgentSessionManager && lc(roles.AgentSessionManager) !== ZERO) {
    const r = await call(roles.PerpetualExchange, selector("authorizedAgents(address)") + pad32(roles.AgentSessionManager));
    const ok = !r.error && BigInt(r.value) !== 0n;
    add("接線", "PerpetualExchange.authorizedAgents(AgentSessionManager)", ok ? "PASS" : "FAIL", ok ? "true" : r.error ?? "false：agent session 下單會被 exchange 拒絕");
  }
  if (roles.AssetVaultV2 && lc(roles.AssetVaultV2) !== ZERO) {
    try {
      const slot = await must("eth_getStorageAt", [roles.AssetVaultV2, IMPL_SLOT, block]);
      const impl = wordToAddr(slot);
      add("接線", "AssetVaultV2 EIP-1967 實作", lc(impl) === ZERO ? "FAIL" : "PASS", impl);
    } catch (e) {
      add("接線", "AssetVaultV2 EIP-1967 實作", "FAIL", e.message);
    }
  }

  // 2. 外洩地址
  const comps = new Map(src.cfg.components.map((c) => [c.id, c]));
  let leakChecks = 0;
  for (const t of resolveTargets(src, [PRIMARY_CHAIN])) {
    if (t.status) continue;
    const comp = comps.get(t.id);
    for (const { key, address } of t.addresses) {
      const label = t.addresses.length > 1 ? `${t.id}.${key}` : t.id;
      for (const fn of comp.reads ?? []) {
        leakChecks++;
        const r = await call(address, selector(fn));
        if (r.error) add("外洩地址", `${label}.${fn}`, "WARN", "讀不到（部署版沒有這個函式？）");
        else if (denylist.includes(lc(wordToAddr(r.value)))) add("外洩地址", `${label}.${fn}`, "FAIL", `仍是外洩地址 ${shortAddr(wordToAddr(r.value))}`);
      }
      for (const bad of denylist) {
        for (const role of comp.roles ?? []) {
          leakChecks++;
          const r = await call(address, selector("hasRole(bytes32,address)") + pad32(roleHash(role)) + pad32(bad));
          if (r.error) add("外洩地址", `${label}.hasRole(${role})`, "WARN", "讀不到");
          else if (BigInt(r.value) !== 0n) add("外洩地址", `${label}.hasRole(${role}, ${shortAddr(bad)})`, "FAIL", "外洩地址仍持有這個角色");
        }
        for (const fn of comp.denyChecks ?? []) {
          leakChecks++;
          const r = await call(address, selector(fn) + pad32(bad));
          if (r.error) add("外洩地址", `${label}.${fn}`, "WARN", "讀不到");
          else if (BigInt(r.value) !== 0n) add("外洩地址", `${label}.${fn.split("(")[0]}(${shortAddr(bad)})`, "FAIL", "外洩地址仍在名單內");
        }
      }
    }
  }
  if (!results.some((r) => r.group === "外洩地址" && r.level === "FAIL")) add("外洩地址", `${leakChecks} 項查詢`, "PASS", "沒有任何 getter 或角色指向外洩地址");

  // 3. keeper：exchange 實際讀的 oracle
  try {
    const stale = staleRule(root);
    const oracle = wordToAddr((await call(roles.PerpetualExchange, selector("oracle()"))).value);
    const maxAgeRes = await call(roles.PerpetualExchange, selector("maxPriceAge()"));
    if (maxAgeRes.error) throw new Error(`maxPriceAge() 讀不到：${maxAgeRes.error}`);
    const maxAge = Number(BigInt(maxAgeRes.value));
    const now = nowSec ?? blockTs;
    let newest = 0;
    for (const sym of stale.assets) {
      const id = stale.assetIds[sym];
      let r = await call(oracle, selector("getPrice(bytes32)") + pad32(id));
      if (r.error) r = await call(oracle, selector("peek(bytes32)") + pad32(id)); // GuardedOracle 過期時 getPrice revert
      if (r.error || !r.value || r.value.length < 130) {
        add("keeper", `${sym} 價格`, "FAIL", `讀不到（${r.error ?? "回傳長度不對"}）`);
        continue;
      }
      const updatedAt = Number(BigInt("0x" + r.value.slice(66, 130)));
      newest = Math.max(newest, updatedAt);
      const age = now - updatedAt;
      const crypto = stale.crypto.has(sym);
      let level = "PASS";
      let why = `${hours(age)}前更新`;
      if (crypto && age >= maxAge) [level, why] = ["FAIL", `${hours(age)}未更新，超過交易所 maxPriceAge ${hours(maxAge)}：開平倉與清算會 revert`];
      else if (crypto && age >= stale.warnSec) [level, why] = ["WARN", `${hours(age)}未更新，超過預警 ${hours(stale.warnSec)}`];
      else if (!crypto && age >= stale.nonCryptoSec) [level, why] = ["WARN", `${hours(age)}未更新，超過非加密資產門檻 ${hours(stale.nonCryptoSec)}`];
      add("keeper", `${sym} 價格`, level, why);
    }
    if (newest) add("keeper", "最近一次寫價", "PASS", `${new Date(newest * 1000).toISOString()}（oracle ${oracle}）`);
    const owner = await call(oracle, selector("owner()"));
    if (!owner.error) {
      const keeper = wordToAddr(owner.value);
      const bal = BigInt(await must("eth_getBalance", [keeper, block]));
      const eth = Number(bal) / 1e18;
      add("keeper", "keeper 錢包 gas", bal < KEEPER_MIN_WEI ? "WARN" : "PASS", `${denylist.includes(lc(keeper)) ? shortAddr(keeper) : keeper}：${eth.toFixed(5)} ETH`);
    }
  } catch (e) {
    add("keeper", "價格新鮮度", "FAIL", e.message);
  }

  // 4. signal-api
  if (!skipHttp) {
    const url = apiUrl ?? signalApiUrl(root);
    const get = async (path) => {
      const res = await fetchImpl(url + path, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      return { status: res.status, headers: res.headers, text, json };
    };
    try {
      const h = await get("/healthz");
      add("signal-api", "GET /healthz", h.status === 200 && h.text.trim() === "ok" ? "PASS" : "FAIL", `HTTP ${h.status}`);
    } catch (e) {
      add("signal-api", "GET /healthz", "FAIL", e.message);
    }
    try {
      const r = await get("/");
      const payTo = r.json?.payTo;
      if (r.status !== 200 || !payTo) add("signal-api", "GET / payTo", "FAIL", `HTTP ${r.status}，沒有 payTo`);
      else if (denylist.includes(lc(payTo))) add("signal-api", "GET / payTo", "FAIL", `payTo 仍是外洩地址 ${shortAddr(payTo)}——換 PAY_TO（OWNER_ACTIONS 第 4 步）`);
      else if (r.json?.payToSafety?.safe !== true) add("signal-api", "GET / payTo", "FAIL", `payToSafety.safe 不是 true（${r.json?.payToSafety?.reason ?? "沒有理由"}）`);
      else add("signal-api", "GET / payTo", "PASS", `${payTo}（safe）`);
    } catch (e) {
      add("signal-api", "GET / payTo", "FAIL", e.message);
    }
    try {
      const r = await get("/oracle/sBTC");
      const v2 = r.headers?.get?.("payment-required");
      if (r.status === 402 && (v2 || Array.isArray(r.json?.accepts))) add("signal-api", "未付款 GET /oracle/sBTC", "PASS", `HTTP 402（${v2 ? "x402 v2 PAYMENT-REQUIRED" : "x402 v1 accepts"}）`);
      else if (r.status === 503 && r.json?.error === "payto_unsafe") add("signal-api", "未付款 GET /oracle/sBTC", "FAIL", "HTTP 503 payto_unsafe：付費端點 fail-closed，收款地址未通過安全檢查");
      else if (r.status === 200) add("signal-api", "未付款 GET /oracle/sBTC", "FAIL", "未付款卻回 200——付費牆沒有作用");
      else add("signal-api", "未付款 GET /oracle/sBTC", "FAIL", `HTTP ${r.status}：${(r.json?.error ?? r.text).toString().slice(0, 120)}`);
    } catch (e) {
      add("signal-api", "未付款 GET /oracle/sBTC", "FAIL", e.message);
    }
  }
  return results;
}

export function renderResults(results) {
  const L = ["| 結果 | 類別 | 檢查 | 說明 |", "|---|---|---|---|"];
  for (const r of results) L.push(`| ${r.level} | ${r.group} | ${r.name.replace(/\|/g, "\\|")} | ${String(r.detail ?? "").replace(/\|/g, "\\|")} |`);
  const n = (lv) => results.filter((r) => r.level === lv).length;
  L.push("", `PASS ${n("PASS")}、WARN ${n("WARN")}、FAIL ${n("FAIL")}`);
  return L.join("\n");
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const opt = (name) => {
    const k = args.indexOf(name);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const root = resolve(opt("--root") ?? join(here, ".."));
  const results = await runSmoke({ root, rpcUrl: opt("--rpc"), apiUrl: opt("--signal-api"), skipHttp: args.includes("--skip-http") });
  console.log(renderResults(results));
  const out = opt("--json");
  if (out) writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 1) + "\n");
  if (results.some((r) => r.level === "FAIL")) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.stack ?? e.message);
    process.exit(1);
  });
}
