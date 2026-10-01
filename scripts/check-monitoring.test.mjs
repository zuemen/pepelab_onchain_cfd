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
  checkConfig,
  checkDeployed,
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
  return { dir, rd, wr, editJson, check, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    const out = await refreshDeployed({ root: t.dir, fetchImpl, log: () => {}, sleep: async () => {} });
    assert.deepEqual([...methods].sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode", "eth_getStorageAt"]);
    assert.ok(limited > 1, "429 之後有重試");
    assert.deepEqual({ ...out, fetchedAt: d.fetchedAt }, d, "重抓的結果與 repo 內的 fixture 相同");
    assert.deepEqual(t.check(), []);
  } finally {
    t.cleanup();
  }
});
