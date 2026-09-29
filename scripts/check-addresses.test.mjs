// check-addresses.mjs 的自我測試：repo 本身必須通過、錯誤 fixture 必須失敗。
//   node --test scripts/check-addresses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflow, parseFrontendConfig, scanWorkflow } from "./check-addresses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-addresses.mjs");
const fixtures = join(here, "fixtures/check-addresses/bad");
const chains = parseFrontendConfig(
  readFileSync(join(root, "frontend/src/contracts/addresses.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/sessionManager.ts"), "utf8"),
  readFileSync(join(root, "frontend/src/contracts/x402.ts"), "utf8"),
);

test("現行 repo 的 workflow 全部通過", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /一致 ✓/);
});

test("含錯誤位址的 fixture 必須以非零結束並列出每一個錯", () => {
  const r = spawnSync(process.execPath, [script, "--workflows", fixtures], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout;
  assert.match(out, /EXCHANGE=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 —— chain 84532 的 PerpetualExchange 應為 0x827eA0c6/);
  assert.match(out, /inputs\.target\.default=0xEf75/);
  assert.match(out, /KEEPER_ORACLE_ADDRESS=0x17CA20A3.*MockOracle 應為 0xeD90c4F3/);
  assert.match(out, /0x4E7cC1B79B72ab72531a6C790e14304370f70764（jobs\.keep\.steps\.run） —— 寫死在非 env 位置/);
  assert.match(out, /KEEPER_VAULT_ADDRESS=0x0{40} —— 零位址/);
  // 審查 Medium 4 的三種盲點：
  assert.match(out, /0x0c6459d38617E60017bDc4ed69ec26137DA5c32b（jobs\.keep\.steps\.run） —— .*chain 84532/,
    "run: 裡對 Sepolia exchange 的 cast send 要依鏈抓出來");
  assert.match(out, /0x32A19D04ef2ca5A7DA02Df39419729fA745749A1（jobs\.keep\.steps\.with\.address） —— .*chain 84532/,
    "with: 帶 Sepolia 位址要依鏈抓出來");
  assert.match(out, /X402_FEE_ROUTER=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 —— chain 84532 的 X402FeeRouter 應為 0x29e5732A/,
    "X402_FEE_ROUTER 填成 MockOracle 要抓出來");
  assert.match(out, /8 個位址與 frontend\/src\/contracts 不一致/);
  // 正確的兩個 GuardedOracle（含 Sepolia 專用那顆）不得誤報。
  assert.doesNotMatch(out, /KEEPER_GUARDED_ORACLE/);
});

test("註解裡的位址不檢查；run: 腳本裡的位址要檢查", () => {
  const { entries, raw } = scanWorkflow(
    [
      "# 0x1111111111111111111111111111111111111111",
      "jobs:",
      "  a:",
      "    env:",
      '      X: "0x2222222222222222222222222222222222222222" # trailing',
      "    steps:",
      "      - run: |",
      "          # 0x3333333333333333333333333333333333333333",
      "          cast call 0x4444444444444444444444444444444444444444",
    ].join("\n"),
  );
  assert.deepEqual(entries.map((e) => [e.path.join("."), e.value]), [
    ["jobs.a.env.X", "0x2222222222222222222222222222222222222222"],
  ]);
  assert.deepEqual(raw.map((r) => r.value), ["0x4444444444444444444444444444444444444444"]);
});

test("allowlist 可以放行前端設定裡沒有的位址", () => {
  const text = [
    "jobs:",
    "  a:",
    "    env:",
    "      KEEPER_CHAIN: base-sepolia",
    '      SOMETHING: "0x5555555555555555555555555555555555555555"',
  ].join("\n");
  assert.equal(checkWorkflow({ file: "x.yml", text, chains, allowlist: [] }).problems.length, 1);
  const allow = [{ address: "0x5555555555555555555555555555555555555555", reason: "test" }];
  assert.equal(checkWorkflow({ file: "x.yml", text, chains, allowlist: allow }).problems.length, 0);
});

test("前端設定解析：兩條鏈的核心角色與 session manager", () => {
  assert.equal(chains["84532"].roles.PerpetualExchange, "0x827eA0c62a32e995927101259042F8A27D99124D");
  assert.equal(chains["84532"].roles.MockOracle, "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3");
  assert.equal(chains["84532"].roles.GuardedOracle, "0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842");
  assert.equal(chains["84532"].roles.AssetVaultV2, "0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a");
  assert.equal(chains["84532"].roles.AgentSessionManager, "0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B");
  assert.equal(chains["11155111"].roles.GuardedOracle, "0x32A19D04ef2ca5A7DA02Df39419729fA745749A1");
  assert.equal(chains["84532"].roles.X402FeeRouter, "0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d");
  assert.notEqual(chains["84532"].roles.X402FeeRouter, chains["84532"].roles.FeeRouter, "x402 router ≠ V1 FeeRouter");
});

test("run: 與 with: 的位址依 job 的鏈檢查（單元）", () => {
  const text = [
    "jobs:",
    "  base:",
    "    env:",
    "      KEEPER_CHAIN: base-sepolia",
    "    steps:",
    "      - run: |",
    "          cast send 0x0c6459d38617E60017bDc4ed69ec26137DA5c32b 'x()'",
    "          cast call 0x827eA0c62a32e995927101259042F8A27D99124D 'y()'",
    "      - uses: some/action@0123456789012345678901234567890123456789",
    "        with:",
    '          address: "0x17CA20A37Cf04F2f589B2573EC95f1411D29d958"',
    "  sep:",
    "    env:",
    "      KEEPER_CHAIN: sepolia",
    "    steps:",
    "      - run: cast call 0x0c6459d38617E60017bDc4ed69ec26137DA5c32b 'z()'",
  ].join("\n");
  const { problems } = checkWorkflow({ file: "x.yml", text, chains, allowlist: [] });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("0x0c6459d3") && p.includes("chain 84532")));
  assert.ok(problems.some((p) => p.includes("0x17CA20A3") && p.includes("with.address")));
});

test("--print 給 workflow 做執行期斷言", () => {
  const ok = spawnSync(process.execPath, [script, "--print", "84532", "X402FeeRouter"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d");
  const bad = spawnSync(process.execPath, [script, "--print", "84532", "NoSuchRole"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});
