// check-monitoring.mjs 的自我測試：repo 本身必須通過；每一種「看起來在監控、其實不會響」
// 的錯誤都必須被抓出來。
//   node --test scripts/check-monitoring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkConfig,
  checkWranglerVars,
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
