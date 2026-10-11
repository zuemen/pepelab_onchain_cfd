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
  ADMIN_FN,
  MUTABLE_KEYS,
  PARAM_SPECS,
  REQUIRED_RULES,
  adminFunctionCoverage,
  proxyCoverage,
  ruleHash,
  verifyDeployed,
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

test("M2／M-A：MUTE_KEYS 只接受 mutableKeys 白名單；白名單本身釘在檢查器裡", () => {
  const cfg = current();
  assert.deepEqual(cfg.mutableKeys.map((m) => m.key), MUTABLE_KEYS);
  assert.deepEqual(checkMuteKeys("", cfg), []);
  assert.deepEqual(checkMuteKeys("x402-payto:unsafe", cfg), []);
  const p = checkMuteKeys("monitor-self:errors,owner-transferred,x402-payto:changed,insurance-wiring:InsuranceVault.exchange(),fee-withdrawals,bad key", cfg).join("\n");
  assert.match(p, /monitor-self:errors：監控自身的告警不可靜音/);
  for (const k of ["owner-transferred", "x402-payto:changed", "insurance-wiring:InsuranceVault.exchange()", "fee-withdrawals"]) {
    assert.ok(p.includes(`的 ${k} 不在 mutableKeys 白名單`), `${k}：\n${p}`);
  }
  assert.match(p, /格式不對的項目 "bad key"/);
  cfg.params.MUTE_KEYS.default = "monitor-self";
  assert.ok(problemsOf(cfg).some((x) => /params\.MUTE_KEYS\.default 含 monitor-self：監控自身的告警不可靜音/.test(x)));
  // 把 SEV-1 的子 key 加進白名單：monitors.json 與檢查器不一致 → 紅。
  const c2 = current();
  c2.mutableKeys.push({ key: "x402-payto:changed", reason: "吵" });
  assert.ok(problemsOf(c2).some((x) => /mutableKeys（x402-payto:unsafe, x402-payto:changed）與 scripts\/check-monitoring\.mjs 的 MUTABLE_KEYS/.test(x)));
  const c3 = current();
  c3.mutableKeys[0].reason = "";
  assert.ok(problemsOf(c3).some((x) => /mutableKeys 的 x402-payto:unsafe 沒有寫 reason/.test(x)));
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
    // feerouter-config-changed 已是 active（x402 FeeRouter 2026-10-10 重新部署後會發）；拿掉平台
    // V1 FeeRouter 的 notDeployed 標記，就回到「舊部署不發、規則對它永遠不會響」的原狀。
    for (const ev of r.events ?? []) delete ev.notDeployed;
  }
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /insurance-wiring-changed：ExchangeSet\(address\) 的 topic0 不在 InsuranceVault 已部署的 bytecode 裡/);
  assert.match(p, /insurance-wiring-changed：沒有任何一個事件出現在已部署的 bytecode 裡/);
  assert.match(p, /feerouter-config-changed：CopyTrackerSet\(address\) 的 topic0 不在 FeeRouter 已部署的 bytecode 裡/);
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
    ["MAX_BLOCK_RANGE 改成 50000", () => t.editJson((j) => { j.params.MAX_BLOCK_RANGE.default = "50000"; }), /MAX_BLOCK_RANGE\.default 必須在 300–1000 之間/, true],
    ["參數預設值不是數字", () => t.editJson((j) => { j.params.LARGE_WITHDRAWAL_USDC.default = "10k"; }), /LARGE_WITHDRAWAL_USDC\.default 必須是非負的十進位數字/, true],
    ["嚴重度降級 SEV-1 → SEV-4", () => t.editJson((j) => { j.rules[0].severity = "SEV-4"; }), /owner-transferred：嚴重度 SEV-4 低於下限 SEV-1/, true],
    ["前端 ABI 新增 admin 事件、沒有任何規則", () => addAbiEvent("TreasurySet"), /PerpetualExchange 的事件 TreasurySet\(address\).*沒有任何規則、也不在 ignoredEvents/],
    ["事件簽章對、但部署版 bytecode 沒有（審查當時的原狀）", () => t.editJson((j) => { const r = j.rules.find((x) => x.id === "insurance-wiring-changed"); r.status = "active"; for (const c of r.contracts) { delete c.source; c.abi = "InsuranceVault"; } }), /ExchangeSet\(address\) 的 topic0 不在 InsuranceVault 已部署的 bytecode 裡/, true],
    // ── 追加 ──
    [".gitignore 少了 .dev.vars", () => t.wr(".gitignore", t.rd(".gitignore").replace(/^\.dev\.vars$/m, "")), /\.gitignore 沒有 \.dev\.vars/],
    ["wrangler [vars] 把 MAX_BLOCK_RANGE 覆寫成 5000", () => t.wr(toml, t.rd(toml) + '\nMAX_BLOCK_RANGE = "5000"\n'), /\[vars\] 的 MAX_BLOCK_RANGE 必須在 300–1000 之間/],
    ["wrangler [vars] 靜音 monitor-self", () => t.wr(toml, t.rd(toml) + '\nMUTE_KEYS = "monitor-self:errors"\n'), /MUTE_KEYS 含 monitor-self:errors：監控自身的告警不可靜音/],
    ["忽略清單刪掉一項（事件變成沒人管）", () => t.editJson((j) => { j.ignoredEvents[0].events.pop(); }), /沒有任何規則、也不在 ignoredEvents/],
    // ── 複審（w17r2/mut3.mjs）──
    ["N1c large-margin-withdrawal 的 token 改標 MockUSDT 樣式（改手寫欄位）", () => t.editJson((j) => { j.rules.find((r) => r.id === "large-margin-withdrawal").amount.token = "USDC"; }), /large-margin-withdrawal：(規則定義與|token 標成 USDC)/, true],
    ["N1d exchange-balance-drop 的 holder 換成 InsuranceVault", () => t.editJson((j) => { const c = j.rules.find((r) => r.id === "exchange-balance-drop").contracts.find((x) => x.as === "holder"); c.ref = "InsuranceVault"; c.abi = "InsuranceVault"; }), /exchange-balance-drop：規則定義與 scripts\/check-monitoring\.mjs 的 REQUIRED_RULES 釘住的 sha256 不同/, true],
    ["N2d insurance-wiring 刪掉 exchange() 讀取", () => t.editJson((j) => { j.rules.find((r) => r.id === "insurance-wiring").calls.splice(0, 1); }), /insurance-wiring：規則定義與.*sha256 不同/, true],
    ["N2c core-wiring oracle() 由 ref 改 snapshot", () => t.editJson((j) => { const c = j.rules.find((r) => r.id === "core-wiring").calls[0]; c.expect = { snapshot: true }; c.note = "x"; }), /core-wiring：規則定義與.*sha256 不同/, true],
    ["N5f exchange-balance-drop 的 dropBps 改指 INSURANCE_DROP_BPS", () => t.editJson((j) => { j.rules.find((r) => r.id === "exchange-balance-drop").dropBps = "INSURANCE_DROP_BPS"; }), /exchange-balance-drop：規則定義與.*sha256 不同/, true],
    ["N5g large-margin-withdrawal 拿掉相對門檻", () => t.editJson((j) => { delete j.rules.find((r) => r.id === "large-margin-withdrawal").amount.relativeBps; }), /large-margin-withdrawal：規則定義與.*sha256 不同/, true],
    ["N5h large-margin-withdrawal 拿掉累計視窗", () => t.editJson((j) => { const a = j.rules.find((r) => r.id === "large-margin-withdrawal").amount; delete a.windowThreshold; delete a.windowSec; }), /large-margin-withdrawal：規則定義與.*sha256 不同/, true],
    ["N4b [vars] MUTE_KEYS = x402-payto:changed", () => t.wr(toml, t.rd(toml) + '\nMUTE_KEYS = "x402-payto:changed"\n'), /MUTE_KEYS 的 x402-payto:changed 不在 mutableKeys 白名單/],
    ["N4c [vars] MUTE_KEYS = insurance-wiring:InsuranceVault.exchange()", () => t.wr(toml, t.rd(toml) + '\nMUTE_KEYS = "insurance-wiring:InsuranceVault.exchange()"\n'), /insurance-wiring:InsuranceVault\.exchange\(\) 不在 mutableKeys 白名單/],
    ["N4h [vars] MUTE_KEYS = insurance-wiring:（尾冒號）", () => t.wr(toml, t.rd(toml) + '\nMUTE_KEYS = "insurance-wiring:"\n'), /MUTE_KEYS 含格式不對的項目|不在 mutableKeys 白名單/],
    ["N4i [vars] MIN_SEVERITY = SEV-1", () => t.wr(toml, t.rd(toml).replace('MIN_SEVERITY = "SEV-4"', 'MIN_SEVERITY = "SEV-1"')), /MIN_SEVERITY 必須是 SEV-2\/SEV-3\/SEV-4/],
    ["N3b [vars] SELF_ERRORS_BEFORE_ALERT = 12", () => t.wr(toml, t.rd(toml) + '\nSELF_ERRORS_BEFORE_ALERT = "12"\n'), /SELF_ERRORS_BEFORE_ALERT 必須在 1–6 之間/],
    ["N3d [vars] LAG_ALERT_BLOCKS = 1000000", () => t.wr(toml, t.rd(toml) + '\nLAG_ALERT_BLOCKS = "1000000"\n'), /LAG_ALERT_BLOCKS 必須在 150–1800 之間/],
    ["N3e [vars] LARGE_WITHDRAWAL_BPS = 10000", () => t.wr(toml, t.rd(toml) + '\nLARGE_WITHDRAWAL_BPS = "10000"\n'), /LARGE_WITHDRAWAL_BPS 必須在 1–5000 之間/],
    ["N3g [vars] HTTP 6＋SELF 2（合計 7 輪 > 6）", () => t.wr(toml, t.rd(toml) + '\nHTTP_FAILS_BEFORE_ALERT = "6"\nSELF_ERRORS_BEFORE_ALERT = "2"\n'), /wrangler\.toml \[vars\]：HTTP_FAILS_BEFORE_ALERT（6）＋SELF_ERRORS_BEFORE_ALERT（2）−1 = 7 輪/],
    ["L-d adminFunctions 少分類一個不發事件的 setter", () => t.editJson((j) => { delete j.adminFunctions.PepeIncentives["withdraw(uint256)"]; }), /PepeIncentives\.withdraw\(uint256\) 在部署版 bytecode 裡，但 adminFunctions 沒有分類/],
    // ── 第三輪複審（w17r3/mut4.mjs，L-3）：全域參數預設值、explorer、repoBlobBase ──
    ["P1 ORACLE_DEVIATION_BPS＝CRIT＝10000", () => t.editJson((j) => { j.params.ORACLE_DEVIATION_BPS.default = "10000"; j.params.ORACLE_DEVIATION_CRIT_BPS.default = "10000"; }), /ORACLE_DEVIATION_CRIT_BPS\.default 必須在 1–3000 之間[\s\S]*GLOBAL_CONFIG_HASH 不同/, true],
    ["P2 GAS_MIN_ETH＝GAS_CRIT_ETH＝0", () => t.editJson((j) => { j.params.GAS_MIN_ETH.default = "0"; j.params.GAS_CRIT_ETH.default = "0"; }), /GAS_MIN_ETH\.default 必須在 0\.001–10 之間/, true],
    ["P3 INSURANCE_MIN_USDC 0、金額門檻 1e12", () => t.editJson((j) => { j.params.INSURANCE_MIN_USDC.default = "0"; j.params.LARGE_WITHDRAWAL_USDC.default = "1000000000000"; }), /LARGE_WITHDRAWAL_USDC\.default 必須在 0–1000000 之間[\s\S]*INSURANCE_MIN_USDC\.default 必須在 1–1000000 之間/, true],
    ["P4 INSURANCE_DROP_BPS 10000、RESERVE_WARN_MARGIN_BPS 0", () => t.editJson((j) => { j.params.INSURANCE_DROP_BPS.default = "10000"; j.params.RESERVE_WARN_MARGIN_BPS.default = "0"; }), /INSURANCE_DROP_BPS\.default 必須在 1–5000 之間[\s\S]*RESERVE_WARN_MARGIN_BPS\.default 必須在 100–5000 之間/, true],
    ["P5 REMIND_SEC 7 天", () => t.editJson((j) => { j.params.REMIND_SEC.default = "604800"; }), /REMIND_SEC\.default 必須在 300–86400 之間/, true],
    ["P5b 範圍內的預設值變更也要人工審（全域雜湊）", () => t.editJson((j) => { j.params.ORACLE_DEVIATION_CRIT_BPS.default = "3000"; }), /GLOBAL_CONFIG_HASH 不同/, true],
    ["P6 [vars] ORACLE_DEVIATION_CRIT_BPS = 10000", () => t.wr(toml, t.rd(toml) + '\nORACLE_DEVIATION_CRIT_BPS = "10000"\n'), /\[vars\] 的 ORACLE_DEVIATION_CRIT_BPS 必須在 1–3000 之間/],
    ["P7 network.explorer 換成他人網域", () => t.editJson((j) => { j.network.explorer = "https://sepolia.basescan.org.evil.example"; }), /network\.explorer 必須是 https:\/\/sepolia\.basescan\.org/, true],
    ["P8 repoBlobBase 換成他人網域", () => t.editJson((j) => { j.repoBlobBase = "https://evil.example/blob/master"; }), /repoBlobBase 必須以 https:\/\/github\.com\/zuemen\/pepelab_onchain_cfd\/blob\/ 開頭/, true],
    ["P9 network.blockTimeSec 改 0", () => t.editJson((j) => { j.network.blockTimeSec = 0; }), /network\.blockTimeSec 必須是 1–12 的整數/, true],
    ["L-d 不發事件的 setter 指向「部署版不發」的事件規則", () => t.editJson((j) => { j.adminFunctions.InsuranceVault["setExchange(address)"] = { rule: "insurance-wiring-changed" }; }), /InsuranceVault\.setExchange\(address\) 指向 insurance-wiring-changed，但它不是 active 規則/],
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
  assert.match(checkParamValue("MAX_BLOCK_RANGE", "1001"), /300–1000/);
  assert.match(checkParamValue("MAX_BLOCK_RANGE", "1e3"), /非負整數/);
  assert.match(checkParamValue("CONFIRMATIONS", "-1"), /非負整數/);
  assert.equal(checkParamValue("GAS_MIN_ETH", "0.02"), null);
  assert.match(checkParamValue("GAS_MIN_ETH", "0,02"), /十進位/);
  assert.match(checkParamValue("MIN_SEVERITY", "SEV-5"), /SEV-2\/SEV-3\/SEV-4/);
  assert.match(checkParamValue("MIN_SEVERITY", "SEV-1"), /SEV-2\/SEV-3\/SEV-4/, "L-f：不可只剩 SEV-1");
  assert.match(checkParamValue("LAG_ALERT_BLOCKS", "1000000"), /150–1800/, "L-f");
  assert.match(checkParamValue("LARGE_WITHDRAWAL_BPS", "10000"), /1–5000/, "L-f：100% 等於關掉相對門檻");
  assert.match(checkParamValue("SELF_ERRORS_BEFORE_ALERT", "12"), /1–6/, "L-f");
  assert.match(checkParamValue("HTTP_FAILS_BEFORE_ALERT", "12"), /1–6/, "L-f");
  assert.match(checkParamValue("SIGNAL_API_URL", "http://plain.example"), /https/);
  assert.match(checkParamValue("NO_SUCH", "1"), /沒有型別定義/);
  cfg.params.ORACLE_DEVIATION_CRIT_BPS.default = "100";
  cfg.params.NEW_PARAM = { default: "1", unit: "x", doc: "y" };
  delete cfg.params.REMIND_SEC.doc;
  const p = problemsOf(cfg).join("\n");
  assert.match(p, /params 預設值 ORACLE_DEVIATION_BPS（300）不可大於 ORACLE_DEVIATION_CRIT_BPS（100）/);
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
    "7 [env.staging.vars] 的 MAX_BLOCK_RANGE 必須在 300–1000 之間，現在是 2000",
    "9 DISCORD_WEBHOOK_URL 是秘密",
    "9 GITHUB_TOKEN 是秘密",
    "10 [env.prod.vars] 的 REMIND_SEC 必須在 300–86400 之間，現在是 10",
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

// ── 複審修正 ─────────────────────────────────────────────────────────────────

test("M-B：每條規則的定義都釘了 sha256；改任何內容都要同時更新檢查器（錯誤訊息印出新雜湊）", () => {
  const cfg = current();
  for (const r of cfg.rules) assert.equal(REQUIRED_RULES[r.id][2], ruleHash(r), r.id);
  // 雜湊不受鍵的順序與產生欄位影響
  const r0 = structuredClone(ruleOf(cfg, "insurance-wiring"));
  const reordered = Object.fromEntries(Object.entries(r0).reverse());
  delete reordered.runbookUrl;
  for (const c of reordered.calls) delete c.expected;
  assert.equal(ruleHash(reordered), ruleHash(r0));
  // 只改說明文字也要人工審過
  const c1 = current();
  ruleOf(c1, "insurance-wiring").description += "。";
  const p = problemsOf(c1).join("\n");
  assert.match(p, /insurance-wiring：規則定義與 scripts\/check-monitoring\.mjs 的 REQUIRED_RULES 釘住的 sha256 不同（現在 [0-9a-f]{64}，釘的是 [0-9a-f]{64}）—— .*人工審過/);
});

test("L-d：管理函式的涵蓋——從部署版 selector 出發，不發事件的 setter 也要分類", () => {
  assert.deepEqual(adminFunctionCoverage(current(), ctx), []);
  const cfg = current();
  delete cfg.adminFunctions.PepeIncentives["setEsgRegistry(address)"];
  cfg.adminFunctions.PepeIncentives["noSuchFn()"] = { reason: "x" };
  cfg.adminFunctions.FeeRouter["setExchange(address)"] = { rule: "fee-withdrawals", reason: "x" };
  cfg.adminFunctions.MockOracle["addAsset(bytes32,uint256)"] = { rule: "keeper-gas" };
  cfg.adminFunctions.NoSuchAbi = {};
  const p = adminFunctionCoverage(cfg, ctx).join("\n");
  assert.match(p, /PepeIncentives\.setEsgRegistry\(address\) 在部署版 bytecode 裡，但 adminFunctions 沒有分類/);
  assert.match(p, /PepeIncentives\.noSuchFn\(\) 不在 ABI 或不在部署版 bytecode 裡/);
  assert.match(p, /FeeRouter\.setExchange\(address\) 必須恰好有 rule 或 reason/);
  assert.match(p, /adminFunctions 的 NoSuchAbi 沒有任何 active 規則在監控/);
  assert.ok(!/MockOracle\.addAsset/.test(p), "keeper-gas 是監控 MockOracle 的狀態規則，算涵蓋");
});

test("L-c：每個受監控的 EIP-1967 proxy 都要有 implementation 規則；預期實作來自 deployed.json", () => {
  const cfg = current();
  assert.deepEqual(proxyCoverage(cfg, ctx), []);
  const r = ruleOf(cfg, "proxy-implementation");
  assert.equal(r.contracts[0].impl, ctx.deployed.implOf(r.contracts[0].address));
  const c2 = current();
  c2.rules = c2.rules.filter((x) => x.id !== "proxy-implementation");
  assert.match(proxyCoverage(c2, ctx).join("\n"), /AssetVaultV2（0x[0-9a-fA-F]{40}）是 EIP-1967 proxy，但沒有 implementation 規則/);
  // impl 是產生欄位：手改會被抓
  const c3 = current();
  ruleOf(c3, "proxy-implementation").contracts[0].impl = "0x0000000000000000000000000000000000000001";
  assert.ok(problemsOf(c3).some((x) => /proxy-implementation\]\.contracts\[0\]\.impl/.test(x)));
});

test("L-c：--verify-deployed（每週排程）只讀、不寫檔；鏈上實作換了 → 回報差異", async () => {
  const d = ctx.deployed.data;
  const chain = (implOverride = null) => {
    const codeAt = {};
    for (const [a, c] of Object.entries(d.contracts)) {
      codeAt[a] = d.codes[c.codeHash];
      if (c.impl) codeAt[c.impl] = d.codes[c.implCodeHash];
    }
    return async (url, init) => {
      const b = JSON.parse(init.body);
      const reply = (x) => Response.json({ jsonrpc: "2.0", id: b.id, ...x });
      const [p0] = b.params;
      if (!["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"].includes(b.method)) throw new Error("不允許 " + b.method);
      if (b.method === "eth_chainId") return reply({ result: "0x14a34" });
      if (b.method === "eth_blockNumber") return reply({ result: "0x" + (d.block + 1000).toString(16) });
      if (b.method === "eth_getCode") return reply({ result: codeAt[p0.toLowerCase()] ?? "0x" });
      if (b.method === "eth_getStorageAt") {
        let impl = d.contracts[p0.toLowerCase()]?.impl;
        if (impl && implOverride) impl = implOverride;
        return reply({ result: "0x" + (impl ? impl.slice(2) : "").padStart(64, "0") });
      }
      const hit = Object.entries(d.reads).find(([k]) => k.startsWith(p0.to.toLowerCase() + "|") && selectorOf(k.split("|")[1]) === p0.data);
      return hit ? reply({ result: hit[1] }) : reply({ error: { code: 3, message: "execution reverted" } });
    };
  };
  const before = readFileSync(join(root, "ops/monitoring/deployed.json"), "utf8");
  assert.deepEqual(await verifyDeployed({ root, fetchImpl: chain(), log: () => {}, sleep: async () => {} }), [], "區塊號不同但內容相同 → 一致");
  // 實作被換成另一份 bytecode（借用 PerpetualExchange 的位址當新實作）
  const other = Object.keys(d.contracts).find((a) => !d.contracts[a].impl);
  const diffs = await verifyDeployed({ root, fetchImpl: chain(other), log: () => {}, sleep: async () => {} });
  assert.ok(diffs.some((x) => /EIP-1967 實作 0x[0-9a-f]{40} → 0x[0-9a-f]{40}（升級了）/.test(x)), diffs.join("\n"));
  assert.equal(readFileSync(join(root, "ops/monitoring/deployed.json"), "utf8"), before, "不寫檔");
});

test("#219：新版 GuardedOracle／PepeIncentives 的事件都有分類；admin 接手函式算管理函式", () => {
  const cfg = current();
  const ids = new Map(cfg.rules.map((r) => [r.id, r]));
  const sigs = (id) => ids.get(id).events.map((e) => e.sig);
  assert.deepEqual(sigs("guarded-oracle-halt-window").sort(), ["AssetFreezeLifted(bytes32,address)", "AssetFreezeStarted(bytes32,address,uint256)", "PauseLifted(address)", "PauseStarted(address,uint256)"]);
  assert.deepEqual(sigs("guarded-oracle-halt-takeover").sort(), ["AssetFreezeTakenOver(bytes32,address)", "PauseTakenOver(address)"]);
  assert.equal(ids.get("guarded-oracle-halt-takeover").severity, "SEV-1");
  assert.deepEqual(sigs("pepe-incentives-daily-params"), ["DailyParamsSet(uint256,uint256,uint8)"]);
  for (const id of ["guarded-oracle-halt-window", "guarded-oracle-halt-takeover", "pepe-incentives-daily-params"]) assert.equal(ids.get(id).status, "pending-deploy", id);
  const ignored = cfg.ignoredEvents.flatMap((g) => g.events);
  assert.ok(!ignored.some((e) => e.startsWith("DailyCheckIn(")), "舊版簽到事件已不在原始碼／ABI");
  assert.ok(cfg.ignoredEvents.some((g) => g.abi === "PepeIncentives" && g.notDeployed && g.events.includes("CheckInPointsCredited(address,uint256,uint8,uint256)")));
  // 部署後這兩個函式會出現在部署版 bytecode，adminFunctions 就必須分類它們。
  for (const fn of ["takeOverAssetFreeze", "takeOverPause"]) assert.ok(ADMIN_FN.test(fn), fn);
  assert.match(cfg.adminFunctions.PepeIncentives["setDailyParams(uint256,uint256,uint8)"].reason, /pepe-incentives-daily-params/);
});
