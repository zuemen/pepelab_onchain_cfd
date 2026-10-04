// 自我測試：部署後 smoke test 對「接對了」與「接錯了」都要給出正確結論。不連網。
//   node --test scripts/post-deploy-smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRIMARY_CHAIN, loadSources, makeRpc } from "./check-deployment-status.mjs";
import { SMOKE_RPC_METHODS, renderResults, runSmoke, staleRule, wiringCalls } from "./post-deploy-smoke.mjs";
import { selector } from "../ops/monitoring/keccak.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAKED = "0xe80a81360608c1342e66743f70a00f75d792eb93";
const RPC = "https://rpc.test";
const API = "https://api.test";
const NOW = 1_800_000_000;
const SAFE = "0x" + "ab".repeat(20);
const KEEPER = "0x" + "cd".repeat(20);
const word = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** 一條「部署正確」的假鏈＋假 signal-api；overrides 用來注入錯誤。 */
function world({ calls = {}, http = {}, priceAge = {} } = {}) {
  const { frontend } = loadSources(REPO);
  const roles = frontend[PRIMARY_CHAIN].roles;
  const state = new Map();
  const set = (to, data, result) => state.set(`${to.toLowerCase()}|${data}`, result);
  for (const w of wiringCalls(REPO, roles)) set(w.to, selector(w.fn), word(w.expected ?? SAFE));
  set(roles.PerpetualExchange, selector("authorizedAgents(address)") + word(roles.AgentSessionManager).slice(2), word(1));
  set(roles.PerpetualExchange, selector("maxPriceAge()"), word((21600).toString(16)));
  set(roles.MockOracle, selector("owner()"), word(KEEPER));
  const stale = staleRule(REPO);
  for (const sym of stale.assets) {
    const age = priceAge[sym] ?? 60;
    set(roles.MockOracle, selector("getPrice(bytes32)") + stale.assetIds[sym].slice(2), "0x" + word(100).slice(2) + word((NOW - age).toString(16)).slice(2));
  }
  for (const [k, v] of Object.entries(calls)) {
    const [ref, data] = k.split("|");
    set(roles[ref] ?? ref, data, v);
  }
  const httpDefaults = {
    "/healthz": { status: 200, body: "ok" },
    "/": { status: 200, body: JSON.stringify({ payTo: SAFE, payToSafety: { safe: true, reason: "eoa" } }) },
    "/oracle/sBTC": { status: 402, body: JSON.stringify({ accepts: [{ scheme: "exact" }] }) },
    ...http,
  };
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url === RPC) {
      const { method, params, id } = JSON.parse(init.body);
      sent.push(method);
      const ok = (result) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
      if (method === "eth_chainId") return ok("0x14a34");
      if (method === "eth_blockNumber") return ok("0x100");
      if (method === "eth_getBlockByNumber") return ok({ timestamp: "0x" + NOW.toString(16) });
      if (method === "eth_getBalance") return ok("0xde0b6b3a7640000");
      if (method === "eth_getStorageAt") return ok(word("11".repeat(20)));
      if (method === "eth_call") {
        const { to, data } = params[0];
        const v = state.get(`${to.toLowerCase()}|${data}`);
        if (v !== undefined) return ok(v);
        return ok(data.length === 10 ? word(SAFE) : word(0)); // 其他 getter：安全地址；角色／名單查詢：false
      }
      throw new Error(`unexpected ${method}`);
    }
    const path = url.slice(API.length);
    const r = httpDefaults[path];
    if (!r) throw new Error(`unexpected ${url}`);
    return { status: r.status, headers: new Headers(r.headers ?? {}), text: async () => r.body };
  };
  return { roles, fetchImpl, sent };
}

const run = (w) => runSmoke({ root: REPO, rpcUrl: RPC, apiUrl: API, fetchImpl: w.fetchImpl, sleep: async () => {}, nowSec: NOW });
const fails = (results) => results.filter((r) => r.level === "FAIL");

test("部署正確 → 沒有 FAIL；四類檢查都有跑；只用唯讀 RPC", async () => {
  const w = world();
  const results = await run(w);
  assert.deepEqual(fails(results), []);
  for (const g of ["接線", "外洩地址", "keeper", "signal-api"]) assert.ok(results.some((r) => r.group === g), g);
  assert.ok(results.some((r) => r.name === "AgentSessionManager.exchange()" && r.level === "PASS"));
  assert.ok(w.sent.every((m) => SMOKE_RPC_METHODS.has(m)));
});

test("owner 仍是外洩地址 → FAIL，輸出只有縮寫", async () => {
  const w = world({ calls: { [`PerpetualExchange|${selector("owner()")}`]: word(LEAKED) } });
  const results = await run(w);
  const f = fails(results);
  assert.ok(f.some((r) => r.group === "外洩地址" && /PerpetualExchange\.owner\(\)/.test(r.name) && /0xe80a…eb93/.test(r.detail)));
  assert.equal(renderResults(results).toLowerCase().includes(LEAKED), false);
});

test("外洩地址仍持有角色、仍是 authorizedAgent → FAIL", async () => {
  const w = world({
    calls: {
      [`PerpetualExchange|${selector("authorizedAgents(address)")}${word(LEAKED).slice(2)}`]: word(1),
      [`GuardedOracle|${selector("hasRole(bytes32,address)")}${"0".repeat(64)}${word(LEAKED).slice(2)}`]: word(1),
    },
  });
  const f = fails(await run(w));
  assert.ok(f.some((r) => /authorizedAgents/.test(r.name)));
  assert.ok(f.some((r) => /GuardedOracle\.hasRole\(DEFAULT_ADMIN_ROLE/.test(r.name)));
});

test("接線錯誤（InsuranceVault.exchange() 指向別的合約）→ FAIL", async () => {
  const w = world({ calls: { [`InsuranceVault|${selector("exchange()")}`]: word("99".repeat(20)) } });
  assert.ok(fails(await run(w)).some((r) => r.name === "InsuranceVault.exchange()"));
});

test("agent session 沒被授權 → FAIL", async () => {
  const { roles } = world();
  const w = world({ calls: { [`PerpetualExchange|${selector("authorizedAgents(address)")}${word(roles.AgentSessionManager).slice(2)}`]: word(0) } });
  assert.ok(fails(await run(w)).some((r) => /authorizedAgents\(AgentSessionManager\)/.test(r.name)));
});

test("keeper：加密資產超過 maxPriceAge → FAIL；股票 100 小時 → WARN", async () => {
  const results = await run(world({ priceAge: { sBTC: 7 * 3600, sAAPL: 100 * 3600 } }));
  assert.ok(fails(results).some((r) => r.name === "sBTC 價格"));
  assert.equal(results.find((r) => r.name === "sAAPL 價格").level, "WARN");
});

test("signal-api：payto_unsafe（fail-closed）、payTo 是外洩地址、未付款回 200 → FAIL", async () => {
  const unsafe = await run(world({ http: { "/oracle/sBTC": { status: 503, body: JSON.stringify({ ok: false, error: "payto_unsafe" }) } } }));
  assert.ok(fails(unsafe).some((r) => /payto_unsafe/.test(r.detail)));
  const leaked = await run(world({ http: { "/": { status: 200, body: JSON.stringify({ payTo: LEAKED, payToSafety: { safe: false } }) } } }));
  assert.ok(fails(leaked).some((r) => r.name === "GET / payTo" && /0xe80a…eb93/.test(r.detail)));
  const free = await run(world({ http: { "/oracle/sBTC": { status: 200, body: "{}" } } }));
  assert.ok(fails(free).some((r) => /付費牆沒有作用/.test(r.detail)));
  const v2 = await run(world({ http: { "/oracle/sBTC": { status: 402, body: "{}", headers: { "PAYMENT-REQUIRED": "e30=" } } } }));
  assert.equal(v2.find((r) => r.name === "未付款 GET /oracle/sBTC").level, "PASS");
});

test("smoke 的 RPC 拒絕任何會送交易的方法", async () => {
  const rpc = makeRpc(RPC, { fetchImpl: async () => assert.fail("不該送出"), allowed: SMOKE_RPC_METHODS });
  await assert.rejects(() => rpc("eth_sendRawTransaction", ["0x"]), /不允許/);
  await assert.rejects(() => rpc("eth_sign", ["0x", "0x"]), /不允許/);
});
