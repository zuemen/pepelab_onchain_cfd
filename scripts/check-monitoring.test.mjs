// check-monitoring.mjs 的自我測試：repo 本身必須通過；每一種「看起來在監控、其實不會響」
// 的錯誤都必須被抓出來。
//   node --test scripts/check-monitoring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selector as selectorOf } from "../ops/monitoring/keccak.mjs";
import {
  PARAM_SPECS,
  REQUIRED_RULES,
  checkConfig,
  checkDeployed,
  checkGitignore,
  checkMuteKeys,
  checkParamValue,
  eventCoverage,
  keyedUrl,
  listFiles,
  tomlLeaves,
  checkWranglerVars,
  refreshDeployed,
  run,
  headingsOf,
  loadContext,
  parseSolEvents,
  scanSecrets,
  slug,
} from "./check-monitoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-monitoring.mjs");
const ctx = loadContext(root);
const current = () => JSON.parse(readFileSync(join(root, "ops/monitoring/monitors.json"), "utf8"));
const rulesMd = readFileSync(join(root, "ops/monitoring/rules.md"), "utf8");
const ruleOf = (cfg, id) => cfg.rules.find((r) => r.id === id);
const problemsOf = (cfg, md = rulesMd) => checkConfig({ current: cfg, ctx, rulesMd: md }).problems;

/** 把檢查器會讀的檔案複製到暫存目錄（突變測試用，不動 repo）。回傳 { dir, rd, wr, editJson, check, cleanup }。 */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "check-monitoring-"));
  const cp = (p) => cpSync(join(root, p), join(dir, p), { recursive: true });
  cp("frontend/src/contracts");
  cp("contracts/src");
  cp("contracts/lib/openzeppelin-contracts/contracts/governance/TimelockController.sol");
  mkdirSync(join(dir, "docs"), { recursive: true });
  for (const f of readdirSync(join(root, "docs"))) if (f.endsWith(".md")) cpSync(join(root, "docs", f), join(dir, "docs", f));
  cp("agent/sdk/src/signalApi.ts");
  cp("agent/shared/src/env.ts");
  cp("ops/monitoring");
  cp(".gitignore");
  const rd = (p) => readFileSync(join(dir, p), "utf8");
  const wr = (p, s) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const editJson = (fn, p = "ops/monitoring/monitors.json") => {
    const j = JSON.parse(rd(p));
    fn(j);
    wr(p, JSON.stringify(j, null, 2) + "\n");
  };
  const check = (write = false) => {
    try {
      return run({ root: dir, write, log: () => {} });
    } catch (e) {
      return [`中止：${e.message}`];
    }
  };
  /** 還原會被突變的部分（比重新複製整個副本快）。 */
  const reset = () => {
    for (const d of ["ops/monitoring", "frontend/src/contracts"]) {
      rmSync(join(dir, d), { recursive: true, force: true });
      cp(d);
    }
    cp(".gitignore");
  };
  return { dir, rd, wr, editJson, check, reset, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("現行 repo 的監控設定通過", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /一致 ✓/);
  assert.equal(problemsOf(current()).length, 0);
});

test("位址與 addresses.ts 不一致 → 錯（舊 exchange 是 #178 的真實案例）", () => {
  const cfg = current();
  ruleOf(cfg, "owner-transferred").contracts[0].address = "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072";
  const p = problemsOf(cfg);
  assert.ok(p.some((x) => /rules\[owner-transferred\]\.contracts\[0\]\.address = "0xEf75.*來源推得 "0x827eA0c6/.test(x)), p.join("\n"));
});

test("位址來源解析不到 → 錯", () => {
  const cfg = current();
  ruleOf(cfg, "owner-transferred").contracts.push({ ref: "NoSuchContract", abi: "PerpetualExchange", address: null });
  assert.ok(problemsOf(cfg).some((x) => /NoSuchContract：前端設定裡解析不到/.test(x)));
});

test("監控 ABI 裡不存在的事件 → 錯（例如對現行 exchange 監控 guardian 暫停）", () => {
  const cfg = current();
  const r = ruleOf(cfg, "exchange-pause");
  r.status = "active";
  r.contracts[0].abi = "PerpetualExchange";
  const p = problemsOf(cfg);
  assert.ok(p.some((x) => /Paused\(address\) 不在 PerpetualExchange\.json 的 ABI 裡/.test(x)), p.join("\n"));
});

test("簽章型別寫錯（uint256 寫成 uint）→ 錯", () => {
  const cfg = current();
  ruleOf(cfg, "large-margin-withdrawal").events[0].sig = "MarginWithdrawn(address,uint)";
  assert.ok(problemsOf(cfg).some((x) => /MarginWithdrawn\(address,uint\) 不在/.test(x)));
});

test("topic0／inputs／selector 被手改 → 錯", () => {
  const cfg = current();
  ruleOf(cfg, "owner-transferred").events[0].topic0 = "0x" + "11".repeat(32);
  ruleOf(cfg, "large-margin-withdrawal").events[0].inputs[1].indexed = true;
  ruleOf(cfg, "vault-reserve").calls[0].selector = "0xdeadbeef";
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /owner-transferred\]\.events\[0\]\.topic0/);
  assert.match(p, /large-margin-withdrawal\]\.events\[0\]\.inputs\[1\]\.indexed/);
  assert.match(p, /vault-reserve\]\.calls\[0\]\.selector/);
});

test("pending-deploy：事件必須宣告在原始碼裡、且不能帶位址", () => {
  const cfg = current();
  ruleOf(cfg, "exchange-asset-mode").events.push({ sig: "AssetModeSet(bytes32,uint256,address)" });
  ruleOf(cfg, "exchange-guardian-roles").contracts[0].address = "0x827eA0c62a32e995927101259042F8A27D99124D";
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /AssetModeSet\(bytes32,uint256,address\) 沒有宣告在 contracts\/src\/PerpetualExchange\.sol/);
  assert.match(p, /exchange-guardian-roles\]\.contracts\[0\]\.address = "0x827e.*來源推得 null/);
});

test("pending-deploy 原始碼不存在 → 錯", () => {
  const cfg = current();
  ruleOf(cfg, "exchange-pause").contracts[0].source = "contracts/src/Nope.sol";
  assert.ok(problemsOf(cfg).some((x) => /原始碼 contracts\/src\/Nope\.sol 不存在/.test(x)));
});

test("state 規則呼叫 ABI 沒有的函式 → 錯", () => {
  const cfg = current();
  ruleOf(cfg, "insurance-fund").calls[0].fn = "totalReserves()";
  assert.ok(problemsOf(cfg).some((x) => /totalReserves\(\) 不在 InsuranceVault\.json 的 ABI 裡/.test(x)));
});

test("金額欄位必須是非 indexed 的 uint；門檻參數必須存在", () => {
  const cfg = current();
  ruleOf(cfg, "large-margin-withdrawal").amount.param = "user";
  ruleOf(cfg, "insurance-bailout").amount.threshold = "NO_SUCH_PARAM";
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /amount\.param user 必須是非 indexed 的 uint/);
  assert.match(p, /amount\.threshold 參照未定義的參數 NO_SUCH_PARAM/);
});

test("處置段落必須是 INCIDENT_RESPONSE.md 真的標題", () => {
  const cfg = current();
  ruleOf(cfg, "owner-transferred").runbook.push("99. 不存在的段落");
  ruleOf(cfg, "keeper-gas").related = ["docs/RUNBOOK_KEEPER.md#不存在"];
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /runbook「99\. 不存在的段落」不是 docs\/INCIDENT_RESPONSE\.md 的標題/);
  assert.match(p, /related「不存在」不是 docs\/RUNBOOK_KEEPER\.md 的標題/);
});

test("基本欄位：id 重複、嚴重度、檢查名稱、資產", () => {
  const cfg = current();
  cfg.rules.push({ ...structuredClone(ruleOf(cfg, "keeper-gas")) });
  ruleOf(cfg, "insurance-fund").severity = "SEV-0";
  ruleOf(cfg, "vault-reserve").check = "noSuchCheck";
  ruleOf(cfg, "oracle-stale").assets.push("sDOGE");
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /keeper-gas：id 重複/);
  assert.match(p, /insurance-fund：severity/);
  assert.match(p, /未知的 state 檢查 noSuchCheck/);
  assert.match(p, /資產 sDOGE 不在 addresses\.ts 的 ASSET_IDS/);
});

test("SIGNAL_API_URL 預設值必須等於 SDK 常數", () => {
  const cfg = current();
  cfg.params.SIGNAL_API_URL.default = "https://example.vercel.app";
  assert.ok(problemsOf(cfg).some((x) => /SIGNAL_API_URL 預設值必須等於/.test(x)));
});

test("M2：MUTE_KEYS 不可靜音 monitor-self、不可整條靜音 SEV-1 規則、必須指向存在的規則", () => {
  const cfg = current();
  assert.deepEqual(checkMuteKeys("", cfg), []);
  assert.deepEqual(checkMuteKeys("x402-payto:unsafe, fee-withdrawals", cfg), []);
  const p = checkMuteKeys("monitor-self:errors,owner-transferred,no-such-rule:x,bad key", cfg).join("\n");
  assert.match(p, /monitor-self:errors：監控自身的告警不可靜音/);
  assert.match(p, /把 SEV-1 規則 owner-transferred 整條靜音/);
  assert.match(p, /no-such-rule:x 不是任何規則的 key/);
  assert.match(p, /格式不對的項目 "bad key"/);
  cfg.params.MUTE_KEYS.default = "monitor-self";
  assert.ok(problemsOf(cfg).some((x) => /params\.MUTE_KEYS\.default 含 monitor-self：監控自身的告警不可靜音/.test(x)));
});

test("rules.md 被手改或過期 → 錯", () => {
  assert.ok(problemsOf(current(), rulesMd.replace("SEV-1", "SEV-2")).some((x) => /rules\.md 與 monitors\.json 不一致/.test(x)));
  // CRLF 不算差異（Windows 工作目錄）。
  assert.equal(problemsOf(current(), rulesMd.replace(/\n/g, "\r\n")).length, 0);
});

test("產生欄位：資產 ID 等於 keccak256(symbol)、角色雜湊對得到名稱", () => {
  const cfg = current();
  assert.equal(cfg.assets.sBTC, "0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1");
  assert.equal(cfg.roleNames["0x" + "0".repeat(64)], "DEFAULT_ADMIN_ROLE");
  assert.ok(Object.values(cfg.roleNames).includes("MINTER_ROLE"));
  assert.ok(Object.values(cfg.roleNames).includes("GUARDIAN_ROLE"));
});

test("每個 active 合約位址都在前端設定裡（反向抽查）", () => {
  const known = ctx.chains["84532"].known;
  for (const r of current().rules.filter((x) => x.status === "active")) {
    for (const c of r.contracts) assert.ok(known.has(c.address.toLowerCase()), `${r.id} ${c.ref} ${c.address}`);
  }
});

test("秘密掃描：bot token、Discord webhook、私鑰都會被抓", () => {
  const p = scanSecrets([
    { name: "ops/monitoring/README.md", text: "TELEGRAM_BOT_TOKEN=123456789:AAH8f0abcdefghijklmnopqrstuvwxyz012345" },
    { name: "ops/monitoring/x.json", text: '"url": "https://discord.com/api/webhooks/123456/abcDEF_ghi"' },
    { name: "ops/monitoring/wrangler.toml", text: `KEY = "0x${"ab".repeat(32)}"` },
    { name: "ops/monitoring/ok.md", text: "npx wrangler secret put TELEGRAM_BOT_TOKEN  # https://discord.com/api/webhooks/…" },
  ]);
  assert.equal(p.length, 3, p.join("\n"));
});

test("wrangler.toml [vars]：秘密鍵名與未知鍵 → 錯；註解與其他 section 不管", () => {
  const params = { MIN_SEVERITY: {} };
  const p = checkWranglerVars(
    [
      "[vars]",
      'MIN_SEVERITY = "SEV-3"',
      'TELEGRAM_BOT_TOKEN = "x"',
      'TYPO_PARAM = "1"',
      '# DISCORD_WEBHOOK_URL = "commented"',
      'EXPECTED_PAY_TO = "0x0000000000000000000000000000000000000001"',
      "[[kv_namespaces]]",
      'binding = "MONITOR_STATE"',
    ].join("\n"),
    params,
  );
  assert.equal(p.length, 2, p.join("\n"));
  assert.match(p[0], /TELEGRAM_BOT_TOKEN 是秘密/);
  assert.match(p[1], /TYPO_PARAM 不是已知參數/);
});

test("Solidity 事件解析：enum→uint8、合約型別→address、註解略過", () => {
  const evs = parseSolEvents(`
    enum AssetMode { Active, ReduceOnly, Halted }
    contract X {
      // event Fake(uint256 a);
      /* event Fake2(uint256 b); */
      event AssetModeSet(bytes32 indexed asset, AssetMode mode, address indexed by);
      event TokenSet(IERC20 indexed token, uint amount);
      event Tier(CarbonTiers.Tier oldValue, CarbonTiers.Tier newValue);
    }`, { enums: new Set(["Tier"]) });
  assert.deepEqual(evs.map((e) => e.sig), ["AssetModeSet(bytes32,uint8,address)", "TokenSet(address,uint256)", "Tier(uint8,uint8)"]);
  assert.deepEqual(evs[0].inputs[2], { name: "by", type: "address", indexed: true });
});

test("GitHub 錨點與標題解析（code fence 內的不算）", () => {
  assert.equal(slug("3. 暫停與凍結：現行部署能做什麼"), "3-暫停與凍結現行部署能做什麼");
  assert.equal(slug("6. Vercel 回滾（前端與 signal-api）"), "6-vercel-回滾前端與-signal-api");
  const h = headingsOf("# A\n```markdown\n## 不算\n```\n## B");
  assert.deepEqual([...h], ["A", "B"]);
});

// ── 已部署 bytecode（審查 H2）────────────────────────────────────────────────

test("H2：active 事件的 topic0 不在已部署 bytecode → 錯；標 notDeployed（含說明）才放行", () => {
  const cfg = current();
  const ev = ruleOf(cfg, "mock-oracle-config").events.find((e) => e.sig.startsWith("StaleThresholdSet"));
  assert.equal(ev.notDeployed, true, "現況：部署版的 MockOracle 不發 StaleThresholdSet");
  delete ev.notDeployed;
  delete ev.note;
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /mock-oracle-config：StaleThresholdSet\(uint256,uint256\) 的 topic0 不在 MockOracle 已部署的 bytecode 裡/);

  const cfg2 = current();
  delete ruleOf(cfg2, "access-role-changed").events.find((e) => e.sig.startsWith("RoleAdminChanged")).note;
  assert.match(problemsOf(cfg2).join("\n"), /RoleAdminChanged.*標了 notDeployed，必須寫 note/);
});

test("H2：標了 notDeployed 但部署版其實會發 → 錯（標記過期）", () => {
  const cfg = current();
  const ev = ruleOf(cfg, "mock-oracle-config").events.find((e) => e.sig.startsWith("AssetAdded"));
  ev.notDeployed = true;
  ev.note = "x";
  assert.match(problemsOf(cfg).join("\n"), /AssetAdded\(bytes32,uint256\) 標了 notDeployed（MockOracle），但部署版其實會發/);
});

test("H2：審查發現的原狀（insurance／feerouter 接線事件規則是 active）→ 錯：部署版不發、規則永遠不會響", () => {
  const cfg = current();
  for (const [id, abi] of [["insurance-wiring-changed", "InsuranceVault"], ["feerouter-config-changed", "FeeRouter"]]) {
    const r = ruleOf(cfg, id);
    r.status = "active";
    for (const c of r.contracts) {
      delete c.source;
      c.abi = abi;
    }
  }
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /insurance-wiring-changed：ExchangeSet\(address\) 的 topic0 不在 InsuranceVault 已部署的 bytecode 裡/);
  assert.match(p, /insurance-wiring-changed：沒有任何一個事件出現在已部署的 bytecode 裡/);
  assert.match(p, /feerouter-config-changed：CopyTrackerSet\(address\) 的 topic0 不在 X402FeeRouter 已部署的 bytecode 裡/);
});

test("H2：pending-deploy 規則的事件其實已在部署版 → 錯（該改 active）", () => {
  const cfg = current();
  const r = ruleOf(cfg, "exchange-wiring-changed");
  r.status = "pending-deploy";
  for (const c of r.contracts) {
    delete c.abi;
    c.source = "contracts/src/PerpetualExchange.sol";
  }
  assert.match(problemsOf(cfg).join("\n"), /exchange-wiring-changed：FeeRouterSet\(address\) 已出現在 PerpetualExchange 已部署的 bytecode 裡/);
});

test("H2：state 規則呼叫部署版沒有的函式 → 錯（ABI 有、bytecode 沒有）", () => {
  const cfg = current();
  ruleOf(cfg, "oracle-stale").calls.push({ on: "oracle", fn: "staleThreshold()" });
  assert.match(problemsOf(cfg).join("\n"), /staleThreshold\(\) 的 selector 不在 MockOracle 已部署的 bytecode 裡/);
});

test("H2：接線預期值——必須等於鏈上快照；快照型要寫說明；產生欄位不可手改", () => {
  const cfg = current();
  const calls = ruleOf(cfg, "feerouter-wiring").calls;
  calls.find((c) => c.on === "feeRouter" && c.fn === "exchange()").expect = { ref: "InsuranceVault" };
  delete calls.find((c) => c.on === "feeRouter" && c.fn === "platformTreasury()").note;
  calls.find((c) => c.on === "x402" && c.fn === "exchange()").expect = { zero: true, ref: "PerpetualExchange" };
  ruleOf(cfg, "insurance-wiring").calls[0].expected = "0x00000000000000000000000000000000000000ee";
  ruleOf(cfg, "core-wiring").calls.push({ on: "exchange", fn: "maxPriceAge()", expect: { zero: true } });
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /FeeRouter\.exchange\(\) 的鏈上快照是 0x827ea0c6.*但預期 0xB364E2e3.*鏈上接線與前端設定不一致/);
  assert.match(p, /feeRouter\.platformTreasury\(\) 用鏈上快照當預期值，必須寫 note/);
  assert.match(p, /x402\.exchange\(\) 的 expect 必須恰好指定/);
  assert.match(p, /insurance-wiring\]\.calls\[0\]\.expected = "0x0000.*ee"，來源推得 "0x827eA0c6/);
  assert.match(p, /wiring 的 maxPriceAge\(\) 必須是零參數、回傳單一 address 的函式/);
});

test("H2：代幣標籤對照鏈上 usdc() 快照（x402 那顆是官方 USDC 6 位，不是 MockUSDC 18 位）", () => {
  const cfg = current();
  ruleOf(cfg, "x402-fee-withdrawals").amount.token = "MockUSDC";
  ruleOf(cfg, "fee-withdrawals").amount.token = "USDC";
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /x402-fee-withdrawals：token 標成 MockUSDC.*X402FeeRouter\.usdc\(\) 的鏈上快照是 0x036cbd53/);
  assert.match(p, /fee-withdrawals：token 標成 USDC.*FeeRouter\.usdc\(\) 的鏈上快照是 0x69fd695b/);
});

test("H2：deployed.json 完整性——內容被改（雜湊不符）、缺位址、多位址、缺快照都會被抓", () => {
  assert.deepEqual(checkDeployed(current(), ctx), []);
  const clone = () => {
    const data = structuredClone(ctx.deployed.data);
    return { data, ctx: { ...ctx, deployed: { ...ctx.deployed, data, codeOf: (a) => (data.contracts[a.toLowerCase()] ? "0x00" : null) } } };
  };
  {
    const { data, ctx: c } = clone();
    const h = Object.keys(data.codes)[0];
    data.codes[h] = data.codes[h].slice(0, -2) + (data.codes[h].endsWith("00") ? "01" : "00");
    assert.match(checkDeployed(current(), c).join("\n"), /內容與雜湊不符/);
  }
  {
    const { data, ctx: c } = clone();
    const ex = "0x827ea0c62a32e995927101259042f8a27d99124d";
    delete data.contracts[ex];
    data.contracts["0x00000000000000000000000000000000000000aa"] = { codeHash: Object.keys(data.codes)[0], impl: null, implCodeHash: null };
    delete data.reads[`${ex}|usdc()`];
    data.chainId = 1;
    const p = checkDeployed(current(), c).join("\n");
    assert.match(p, /沒有 PerpetualExchange（0x827ea0c6.*）的 bytecode：位址換了或 fixture 過期/);
    assert.match(p, /多了沒有規則在用的位址 0x0000.*aa/);
    assert.match(p, /沒有 PerpetualExchange\.usdc\(\) 的鏈上快照/);
    assert.match(p, /chainId 1 不等於/);
  }
});

test("H2：addresses.ts 換了位址但 deployed.json 沒重抓 → 錯（不會拿舊合約的 bytecode 當依據）", () => {
  const t = tempRepo();
  try {
    assert.deepEqual(t.check(), [], "未改動的副本必須通過");
    t.wr("frontend/src/contracts/addresses.ts", t.rd("frontend/src/contracts/addresses.ts").replaceAll("0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812", "0x1111111111111111111111111111111111111111"));
    t.check(true); // 即使先 --write 讓 monitors.json 跟上位址
    const p = t.check().join("\n");
    assert.match(p, /deployed\.json 沒有 InsuranceVault（0x1111111111111111111111111111111111111111）的 bytecode/);
  } finally {
    t.cleanup();
  }
});

test("H2：--refresh-deployed 只用唯讀方法、被限流會重試、結果可重現（以現有 fixture 當假鏈）", async () => {
  const t = tempRepo();
  try {
    const d = ctx.deployed.data;
    const codeAt = {};
    for (const [a, c] of Object.entries(d.contracts)) {
      codeAt[a] = d.codes[c.codeHash];
      if (c.impl) codeAt[c.impl] = d.codes[c.implCodeHash];
    }
    const methods = new Set();
    let limited = 0;
    const fetchImpl = async (url, init) => {
      assert.equal(url, "https://sepolia.base.org");
      const b = JSON.parse(init.body);
      methods.add(b.method);
      if (b.method === "eth_getCode" && limited++ === 0) return new Response("{}", { status: 429 });
      const reply = (x) => Response.json({ jsonrpc: "2.0", id: b.id, ...x });
      const [p0, p1, p2] = b.params;
      if (b.method === "eth_chainId") return reply({ result: "0x14a34" });
      if (b.method === "eth_blockNumber") return reply({ result: "0x" + d.block.toString(16) });
      const tag = b.method === "eth_getStorageAt" ? p2 : p1;
      assert.equal(Number(BigInt(tag)), d.block, "所有讀取釘在同一個區塊");
      if (b.method === "eth_getCode") return reply({ result: codeAt[p0.toLowerCase()] ?? "0x" });
      if (b.method === "eth_getStorageAt") {
        const impl = d.contracts[p0.toLowerCase()]?.impl;
        return reply({ result: "0x" + (impl ? impl.slice(2) : "").padStart(64, "0") });
      }
      if (b.method === "eth_call") {
        const hit = Object.entries(d.reads).find(([k]) => k.startsWith(p0.to.toLowerCase() + "|") && ctx.deployed.hasSelector !== undefined && selectorOf(k.split("|")[1]) === p0.data);
        return hit ? reply({ result: hit[1] }) : reply({ error: { code: 3, message: "execution reverted" } });
      }
      throw new Error("unexpected " + b.method);
    };
    t.wr("ops/monitoring/deployed.json", "{}");
    // 日期固定成 fixture 的日期：rules.md 會印出快照日期，用「今天」會讓這個測試隔天就壞。
    const out = await refreshDeployed({ root: t.dir, fetchImpl, log: () => {}, sleep: async () => {}, today: d.fetchedAt });
    assert.deepEqual([...methods].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode", "eth_getStorageAt"]);
    assert.ok(limited > 1, "429 之後有重試");
    assert.deepEqual(out, d, "重抓的結果與 repo 內的 fixture 相同");
    assert.deepEqual(t.check(), []);
  } finally {
    t.cleanup();
  }
});

// ── 涵蓋、下限與設定檔（審查 M4）──────────────────────────────────────────────

test("M4：審查的突變清單——每一項都要讓檢查器變紅", () => {
  const t = tempRepo();
  const addAbiEvent = (name) => {
    const f = "frontend/src/contracts/abi/PerpetualExchange.json";
    const j = JSON.parse(t.rd(f));
    (Array.isArray(j) ? j : j.abi).push({ type: "event", name, inputs: [{ name: "who", type: "address", indexed: true }], anonymous: false });
    t.wr(f, JSON.stringify(j));
  };
  const toml = "ops/monitoring/wrangler.toml";
  // [名稱, 突變, 預期訊息, 突變後是否先 --write（模擬「改了手寫欄位再重新產生」）]
  const cases = [
    ["monitors.json 的 exchange 位址改成舊位址", () => t.editJson((j) => { j.rules[0].contracts[0].address = "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072"; }), /owner-transferred\]\.contracts\[0\]\.address/],
    ["addresses.ts 換了 exchange 位址、monitors.json 沒跟", () => t.wr("frontend/src/contracts/addresses.ts", t.rd("frontend/src/contracts/addresses.ts").replaceAll("0x827eA0c62a32e995927101259042F8A27D99124D", "0x1111111111111111111111111111111111111111")), /來源推得 "0x1111111111111111111111111111111111111111"/],
    ["加一個 ABI 沒有的事件", () => t.editJson((j) => { j.rules.find((r) => r.id === "exchange-wiring-changed").events.push({ sig: "Paused(address)" }); }), /Paused\(address\) 不在 PerpetualExchange\.json 的 ABI 裡/],
    ["topic0 改錯一個字元", () => t.editJson((j) => { const e = j.rules[0].events[0]; e.topic0 = e.topic0.slice(0, -1) + (e.topic0.endsWith("0") ? "1" : "0"); }), /events\[0\]\.topic0/],
    ["selector 改錯", () => t.editJson((j) => { j.rules.find((r) => r.id === "vault-reserve").calls[0].selector = "0xdeadbeef"; }), /vault-reserve\]\.calls\[0\]\.selector/],
    ["rules.md 手改一行", () => t.wr("ops/monitoring/rules.md", t.rd("ops/monitoring/rules.md").replace("SEV-1", "SEV-4")), /rules\.md 與 monitors\.json 不一致/],
    ["門檻改了、rules.md 沒重產", () => t.editJson((j) => { j.params.GAS_MIN_ETH.default = "0.5"; }), /rules\.md 與 monitors\.json 不一致/],
    ["金額小數位 18 手改成 6", () => t.editJson((j) => { j.rules.find((r) => r.id === "large-margin-withdrawal").amount.decimals = 6; }), /amount\.decimals = 6，來源推得 18/],
    ["wrangler [vars] 寫入 bot token", () => t.wr(toml, t.rd(toml) + "\nTELEGRAM_BOT_TOKEN = \"" + ["123456789", "A".repeat(35)].join(":") + "\"\n"), /TELEGRAM_BOT_TOKEN 是秘密/],
    ["wrangler [vars] 寫入 RPC_URL", () => t.wr(toml, t.rd(toml) + '\nRPC_URL = "https://example-rpc.invalid/abc"\n'), /RPC_URL 是秘密/],
    // ── 以下是審查當時抓不到的 ──
    ["[env.production.vars] 裡放秘密", () => t.wr(toml, t.rd(toml) + '\n[env.production.vars]\nALERT_WEBHOOK_SECRET = "s3cr3t-value-not-matching-any-pattern"\nTELEGRAM_CHAT_ID = "-1001234567890"\n'), /ALERT_WEBHOOK_SECRET 是秘密.*\[env\.production\.vars\]/],
    ["inline table 裡放秘密", () => t.wr(toml, t.rd(toml).replace("[vars]", 'vars_backup = { ALERT_WEBHOOK_URL = "https://hooks.example.invalid/t/abc123secret" }\n[vars]')), /ALERT_WEBHOOK_URL 是秘密/],
    ["publicRpc 換成含 key 的 RPC URL（不認得的廠商樣式）", () => t.editJson((j) => { j.network.publicRpc = "https://example.base-sepolia.quiknode.invalid/0123456789abcdef0123456789abcdef01234567/"; }), /network\.publicRpc 必須是不需要金鑰的公開端點/],
    ["子目錄檔案含 Discord webhook", () => t.wr("ops/monitoring/notes/x.txt", ["https://discord.com/api/webhooks", "123456789012345678", "a".repeat(60)].join("/")), /ops\/monitoring\/notes\/x\.txt:1 疑似 Discord webhook/],
    ["整條 owner-transferred 規則刪除", () => t.editJson((j) => { j.rules = j.rules.filter((r) => r.id !== "owner-transferred"); }), /owner-transferred：必要規則不存在/, true],
    ["SEV-1 的 exchange-wiring-changed 改成 pending-deploy", () => t.editJson((j) => { const r = j.rules.find((x) => x.id === "exchange-wiring-changed"); r.status = "pending-deploy"; for (const c of r.contracts) { c.source = "contracts/src/PerpetualExchange.sol"; delete c.abi; } }), /exchange-wiring-changed：必要規則必須是 active/, true],
    ["X402FeeRouter 的 token 由 USDC 改標 MockUSDC", () => t.editJson((j) => { j.rules.find((r) => r.id === "x402-fee-withdrawals").amount.token = "MockUSDC"; }), /x402-fee-withdrawals：token 標成 MockUSDC/, true],
    ["MAX_BLOCK_RANGE 改成 50000", () => t.editJson((j) => { j.params.MAX_BLOCK_RANGE.default = "50000"; }), /MAX_BLOCK_RANGE\.default 必須在 1–1000 之間/, true],
    ["參數預設值不是數字", () => t.editJson((j) => { j.params.LARGE_WITHDRAWAL_USDC.default = "10k"; }), /LARGE_WITHDRAWAL_USDC\.default 必須是非負的十進位數字/, true],
    ["嚴重度降級 SEV-1 → SEV-4", () => t.editJson((j) => { j.rules[0].severity = "SEV-4"; }), /owner-transferred：嚴重度 SEV-4 低於下限 SEV-1/, true],
    ["前端 ABI 新增 admin 事件、沒有任何規則", () => addAbiEvent("TreasurySet"), /PerpetualExchange 的事件 TreasurySet\(address\).*沒有任何規則、也不在 ignoredEvents/],
    ["事件簽章對、但部署版 bytecode 沒有（審查當時的原狀）", () => t.editJson((j) => { const r = j.rules.find((x) => x.id === "insurance-wiring-changed"); r.status = "active"; for (const c of r.contracts) { delete c.source; c.abi = "InsuranceVault"; } }), /ExchangeSet\(address\) 的 topic0 不在 InsuranceVault 已部署的 bytecode 裡/, true],
    // ── 追加 ──
    [".gitignore 少了 .dev.vars", () => t.wr(".gitignore", t.rd(".gitignore").replace(/^\.dev\.vars$/m, "")), /\.gitignore 沒有 \.dev\.vars/],
    ["wrangler [vars] 把 MAX_BLOCK_RANGE 覆寫成 5000", () => t.wr(toml, t.rd(toml) + '\nMAX_BLOCK_RANGE = "5000"\n'), /\[vars\] 的 MAX_BLOCK_RANGE 必須在 1–1000 之間/],
    ["wrangler [vars] 靜音 monitor-self", () => t.wr(toml, t.rd(toml) + '\nMUTE_KEYS = "monitor-self:errors"\n'), /MUTE_KEYS 含 monitor-self:errors：監控自身的告警不可靜音/],
    ["忽略清單刪掉一項（事件變成沒人管）", () => t.editJson((j) => { j.ignoredEvents[0].events.pop(); }), /沒有任何規則、也不在 ignoredEvents/],
  ];
  try {
    assert.deepEqual(t.check(), [], "基準：未改動的副本必須通過");
    for (const [name, mutate, expect, writeFirst] of cases) {
      t.reset();
      mutate();
      if (writeFirst) t.check(true);
      const problems = t.check().join("\n");
      assert.match(problems, expect, `突變「${name}」沒有被抓到（或訊息不對）：\n${problems.slice(0, 600)}`);
    }
    // 審查者的原樣：ABI 新增 GuardianSet。這個事件已有 pending-deploy 規則（exchange-guardian-roles）在等，
    // 所以不算「沒人管」；它一旦出現在部署版 bytecode，pending 規則就會被要求改成 active（見 H2 測試）。
    t.reset();
    addAbiEvent("GuardianSet");
    assert.deepEqual(t.check(), []);
  } finally {
    t.cleanup();
  }
});

test("M4：必要規則表涵蓋現行每一條規則，且與現況一致", () => {
  const cfg = current();
  assert.deepEqual(Object.keys(REQUIRED_RULES).sort(), cfg.rules.map((r) => r.id).sort());
  for (const r of cfg.rules) {
    const [minSev, status] = REQUIRED_RULES[r.id];
    assert.equal(r.status, status, r.id);
    assert.equal(r.severity, minSev, `${r.id}：表裡的下限應該等於現行嚴重度`);
  }
  // 新規則沒登記 → 錯
  cfg.rules.push({ ...structuredClone(ruleOf(cfg, "keeper-gas")), id: "brand-new-rule" });
  assert.ok(problemsOf(cfg).some((x) => /brand-new-rule：新規則還沒登記到.*REQUIRED_RULES/.test(x)));
});

test("M4：參數型別與範圍", () => {
  const cfg = current();
  assert.deepEqual(Object.keys(PARAM_SPECS).sort(), Object.keys(cfg.params).sort(), "每個參數都要有型別定義");
  assert.ok(PARAM_SPECS.MAX_BLOCK_RANGE.max <= 1000, "公開 RPC 的 eth_getLogs 上限是 1,000 塊");
  assert.equal(checkParamValue("MAX_BLOCK_RANGE", "1000"), null);
  assert.match(checkParamValue("MAX_BLOCK_RANGE", "1001"), /1–1000/);
  assert.match(checkParamValue("MAX_BLOCK_RANGE", "1e3"), /非負整數/);
  assert.match(checkParamValue("CONFIRMATIONS", "-1"), /非負整數/);
  assert.equal(checkParamValue("GAS_MIN_ETH", "0.02"), null);
  assert.match(checkParamValue("GAS_MIN_ETH", "0,02"), /十進位/);
  assert.match(checkParamValue("MIN_SEVERITY", "SEV-5"), /SEV-1\/SEV-2/);
  assert.match(checkParamValue("SIGNAL_API_URL", "http://plain.example"), /https/);
  assert.match(checkParamValue("NO_SUCH", "1"), /沒有型別定義/);
  cfg.params.ORACLE_DEVIATION_CRIT_BPS.default = "100";
  cfg.params.NEW_PARAM = { default: "1", unit: "x", doc: "y" };
  delete cfg.params.REMIND_SEC.doc;
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /params\.ORACLE_DEVIATION_BPS（300）不可大於 params\.ORACLE_DEVIATION_CRIT_BPS（100）/);
  assert.match(p, /params\.NEW_PARAM\.default 沒有型別定義/);
  assert.match(p, /params\.REMIND_SEC 缺少 doc/);
});

test("M4：事件涵蓋——忽略清單過期、重複、理由、notDeployed 的真假", () => {
  assert.deepEqual(eventCoverage(current(), ctx), []);
  const cfg = current();
  cfg.ignoredEvents.push({ abi: "MockOracle", reason: "", events: ["AssetAdded(bytes32,uint256)", "NoSuchEvent(uint256)"] });
  cfg.ignoredEvents.push({ abi: "CopyTracker", reason: "x", events: ["TraderFollowed(address,address,uint256,uint256)"] });
  cfg.ignoredEvents.find((g) => g.abi === "MockOracle" && g.events[0].startsWith("PriceUpdated")).notDeployed = true;
  delete cfg.ignoredEvents.find((g) => g.abi === "PepeAMM" && g.notDeployed).notDeployed;
  const p = eventCoverage(cfg, ctx).join("\n");
  assert.match(p, /ignoredEvents\[\d+\]（MockOracle） 沒有寫 reason/);
  assert.match(p, /AssetAdded\(bytes32,uint256\)（MockOracle）同時在規則與 ignoredEvents 裡/);
  assert.match(p, /NoSuchEvent\(uint256\) 不在 MockOracle\.json 的 ABI 也不在原始碼裡/);
  assert.match(p, /（CopyTracker） 沒有任何 active 規則在監控這個合約/);
  assert.match(p, /ignoredEvents 說 PriceUpdated\(bytes32,uint256,uint256,uint256\) 不在 MockOracle 的部署版，但已部署的 bytecode 裡有/);
  assert.match(p, /MaxOracleAgeSet\(uint256,uint256\)（PepeAMM）不在任何部署版 bytecode 裡 —— 那一組要標 notDeployed/);
});

test("M4：wrangler.toml——任何位置的秘密鍵名、所有 vars 表、inline table、dotted key、值的驗證", () => {
  const cfg = current();
  const text = [
    'name = "x" # 註解裡的 RPC_URL = "不算"',
    "[vars]",
    'MIN_SEVERITY = "SEV-3"',
    'NOTE = "含 # 的字串不是註解"',
    "[env.staging.vars]",
    'HEARTBEAT_URL = "https://hc.example/abc"',
    'MAX_BLOCK_RANGE = "2000"',
    "[env.prod]",
    'vars = { GAS_MIN_ETH = "0.05", DISCORD_WEBHOOK_URL = "x", nested = { GITHUB_TOKEN = "y" } }',
    'vars.REMIND_SEC = "10"',
    "[[kv_namespaces]]",
    'binding = "MONITOR_STATE"',
    'extra = { TELEGRAM_CHAT_ID = "1" }',
  ].join("\n");
  assert.deepEqual(
    tomlLeaves(text).map((l) => l.path.join(".")),
    ["name", "vars.MIN_SEVERITY", "vars.NOTE", "env.staging.vars.HEARTBEAT_URL", "env.staging.vars.MAX_BLOCK_RANGE", "env.prod.vars.GAS_MIN_ETH", "env.prod.vars.DISCORD_WEBHOOK_URL", "env.prod.vars.nested.GITHUB_TOKEN", "env.prod.vars.REMIND_SEC", "kv_namespaces.binding", "kv_namespaces.extra.TELEGRAM_CHAT_ID"],
  );
  assert.equal(tomlLeaves(text).find((l) => l.path.at(-1) === "NOTE").value, "含 # 的字串不是註解");
  const p = checkWranglerVars(text, cfg.params, cfg);
  assert.deepEqual(p.map((x) => x.replace(/^wrangler\.toml:(\d+) /, "$1 ").replace(/ 是秘密.*/, " 是秘密")), [
    "4 [vars] 的 NOTE 不是已知參數",
    "6 HEARTBEAT_URL 是秘密",
    "7 [env.staging.vars] 的 MAX_BLOCK_RANGE 必須在 1–1000 之間，現在是 2000",
    "9 DISCORD_WEBHOOK_URL 是秘密",
    "9 GITHUB_TOKEN 是秘密",
    "10 [env.prod.vars] 的 REMIND_SEC 必須在 300–604800 之間，現在是 10",
    "13 TELEGRAM_CHAT_ID 是秘密",
  ]);
  // repo 裡的 wrangler.toml 本身乾淨
  assert.deepEqual(checkWranglerVars(readFileSync(join(root, "ops/monitoring/wrangler.toml"), "utf8"), cfg.params, cfg), []);
});

test("M4：含金鑰的 URL（不靠廠商樣式）、遞迴列檔、.gitignore", () => {
  assert.equal(keyedUrl("rpc = https://example.base-sepolia.quiknode.invalid/0123456789abcdef0123456789abcdef01234567/"), true);
  assert.equal(keyedUrl("https://rpc.example/v1?apikey=abcd1234efgh"), true);
  assert.equal(keyedUrl("https://sepolia.base.org"), false);
  assert.equal(keyedUrl(`https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}`), false, "tx hash 不是金鑰");
  assert.equal(keyedUrl(`https://sepolia.basescan.org/address/0x${"ab".repeat(20)}`), false);
  assert.equal(keyedUrl("https://github.com/zuemen/pepelab_onchain_cfd/blob/master/docs/INCIDENT_RESPONSE.md#3-暫停與凍結現行部署能做什麼"), false);
  assert.equal(scanSecrets([{ name: "ops/monitoring/sub/a.md", text: "x\nhttps://node.example/rpc/Zx9Kq2Lm8Pv4Rt6Yw1Bn3Cd5Ef7Gh0Jk" }]).length, 1);

  const files = listFiles(join(root, "ops/monitoring"));
  assert.ok(files.includes("monitors.json") && files.includes("deployed.json"));
  assert.ok(!files.some((f) => f.includes(".wrangler") || f.endsWith(".dev.vars")));

  assert.deepEqual(checkGitignore(readFileSync(join(root, ".gitignore"), "utf8")), []);
  assert.equal(checkGitignore("node_modules/\n.env\n").length, 2);
  assert.equal(checkGitignore("**/.dev.vars\n.wrangler/\n").length, 0);
});
