// scripts/lib/platform-addresses.mjs 的自我測試：平台位址全集的來源、排除清單與白名單。
//   node --test scripts/platform-addresses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANVIL_DEFAULT_ACCOUNTS,
  RETIRED_FILE,
  UNIVERSE_EXCLUDES,
  WELL_KNOWN_NON_PLATFORM,
  addressesInText,
  excludedReason,
  platformAddressUniverse,
  publicKeyAccountProblem,
  repoFiles,
  wellKnownEntry,
} from "./lib/platform-addresses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const universe = platformAddressUniverse(root);

test("排除清單：只排除租戶檔、測試、第三方 lib、lockfile、產生的 bundle，每一條都有理由", () => {
  assert.ok(UNIVERSE_EXCLUDES.length <= 12, "排除清單應該保持最小");
  for (const e of UNIVERSE_EXCLUDES) assert.ok(typeof e.why === "string" && e.why.length >= 4, String(e.re));
  for (const p of [
    "deploy/tenants/bank-a.json",
    "deploy/tenants/bank-a.deployed.json",
    "deploy/tenants/_template.json",
    "docs/tenants/bank-a/WALLETS.md",
    "contracts/broadcast/tenants/bank-a/DeployTenant.s.sol/84532/run-latest.json",
    "frontend/src/contracts/deployments/bank-a.json",
    "scripts/check-addresses.test.mjs",
    "frontend/src/contracts/__snapshots__/tenantDeployment.test.ts.snap",
    "agent/signal-api/src/testing/golden/x.json",
    "scripts/fixtures/check-addresses/bad/stale-keeper.yml",
    "contracts/test/TenantFixture.sol",
    "contracts/test/fork/DeployTenantFork.t.sol",
    "contracts/lib/forge-std/src/StdCheats.sol",
    "frontend/yarn.lock",
    "agent/package-lock.json",
    "contracts/foundry.lock",
    "agent/signal-api/api/index.js",
    "web/dist/app.js",
  ]) {
    assert.ok(excludedReason(p), `${p} 應該被排除`);
  }
  // 平台的來源一律納入（複審 A1／A2 指出的那幾類檔案都在這裡）。
  for (const p of [
    "frontend/src/contracts/deployments/default.json",
    "frontend/src/contracts/addresses.ts",
    "contracts/script/Verify130.s.sol",
    "contracts/broadcast/Redeploy102Exchange.s.sol/84532/run-latest.json",
    // 租戶廣播只有寫到 broadcast/tenants/<id>/ 才排除；寫到預設目錄的照樣算平台的。
    "contracts/broadcast/DeployTenant.s.sol/84532/run-latest.json",
    "docs/TENANT_DEPLOYMENT.md",
    "docs/tenantsX.md",
    "scripts/deploy-129.sh",
    "docs/ROLE_SEPARATION.md",
    "ops/monitoring/monitors.json",
    "ops/monitoring/deployed.json",
    "agent/shared/src/addresses.ts",
    ".github/workflows/base-sepolia-keeper.yml",
    "deploy-base-sepolia.sh",
    "README.md",
  ]) {
    assert.equal(excludedReason(p), null, `${p} 不應被排除`);
  }
});

test("檔案清單取自 git：repo 內被追蹤的檔案都在清單上", () => {
  const files = repoFiles(root);
  assert.ok(files.length > 500, `只有 ${files.length} 個檔案？`);
  for (const f of ["docs/ROLE_SEPARATION.md", "ops/monitoring/monitors.json", "contracts/script/Verify130.s.sol", RETIRED_FILE]) {
    assert.ok(files.includes(f), f);
  }
});

test("拿不到 git 檔案清單時丟錯（不會默默變成空集合）", () => {
  const dir = mkdtempSync(join(tmpdir(), "universe-nogit-"));
  assert.throws(() => repoFiles(join(dir, "nope")), /無法以 git ls-files 列出/);
});

test("白名單：逐筆具名、有理由、沒有重複；白名單的位址不在全集", () => {
  const seen = new Set();
  for (const e of WELL_KNOWN_NON_PLATFORM) {
    assert.match(e.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(e.name && e.why, e.address);
    assert.ok(!seen.has(e.address.toLowerCase()), `重複 ${e.address}`);
    seen.add(e.address.toLowerCase());
    assert.ok(!universe.has(e.address.toLowerCase()), `${e.name} 不該在全集`);
  }
  assert.equal(wellKnownEntry("0x036cbd53842c5426634e7929541ec2318f3dcf7e").name, "Circle USDC（Base Sepolia）");
  assert.equal(ANVIL_DEFAULT_ACCOUNTS.length, 10);
});

test("Anvil 預設帳號不在全集，但另外被擋（私鑰公開）", () => {
  for (const a of ANVIL_DEFAULT_ACCOUNTS) {
    assert.match(publicKeyAccountProblem("roles.admin", a.toLowerCase()), /Anvil 預設帳號/);
  }
  assert.equal(publicKeyAccountProblem("roles.admin", "0x" + "ab".repeat(20)), null);
});

test("文字裡的位址：20 位元組原樣、32 位元組補零的位址也抽出；補零的小整數不算", () => {
  const got = addressesInText(
    [
      "a 0xc7AfE2064106A608E0E21bfBF9AFf89b0EAD7b9f b",
      `"value": "0x000000000000000000000000c7afe2064106a608e0e21bfbf9aff89b0ead7b9f"`,
      `"value": "0x0000000000000000000000000000000000000000000000000000000000005460"`,
      `"value": "0x00000000000000000000000000000000000000000000000000000004a817c800"`,
      "tx 0x" + "ab".repeat(32),
    ].join("\n"),
  ).map((x) => [x.address.toLowerCase(), x.line]);
  assert.deepEqual(got, [
    ["0xc7afe2064106a608e0e21bfbf9aff89b0ead7b9f", 1],
    ["0xc7afe2064106a608e0e21bfbf9aff89b0ead7b9f", 2],
  ]);
});

test("排除清單在實際掃描時生效（以臨時目錄＋檔案清單驗證）", () => {
  const dir = mkdtempSync(join(tmpdir(), "universe-"));
  const P = (n) => `0x${n.toString(16).padStart(40, "c")}`;
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put(RETIRED_FILE, readFileSync(join(root, RETIRED_FILE), "utf8"));
  put("docs/roles.md", `owner ${P(1)}`);
  put("contracts/script/X.s.sol", `address constant A = ${P(2)};`);
  put("deploy/tenants/bank-a.json", `{"roles":{"admin":"${P(3)}"}}`);
  put("scripts/x.test.mjs", `const a = "${P(4)}";`);
  put("contracts/lib/forge-std/src/x.sol", `${P(5)}`);
  put(".github/workflows/keeper-bank-a.yml", `env:\n  KEEPER_TENANT: bank-a\n  X: ${P(6)}\n`);
  put(".github/workflows/platform.yml", `env:\n  X: ${P(7)}\n`);
  put("frontend/yarn.lock", `${P(8)}`);
  put("img.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(P(9))]));
  const files = [
    RETIRED_FILE,
    "docs/roles.md",
    "contracts/script/X.s.sol",
    "deploy/tenants/bank-a.json",
    "scripts/x.test.mjs",
    "contracts/lib/forge-std/src/x.sol",
    ".github/workflows/keeper-bank-a.yml",
    ".github/workflows/platform.yml",
    "frontend/yarn.lock",
    "img.bin",
    "contracts/lib/openzeppelin-contracts", // submodule 的 gitlink：不是一般檔案
  ];
  const u = platformAddressUniverse(dir, { files });
  for (const n of [1, 2, 7]) assert.ok(u.has(P(n)), `P(${n}) 應該在全集`);
  for (const n of [3, 4, 5, 6, 8, 9]) assert.ok(!u.has(P(n)), `P(${n}) 不應在全集`);
});

test("平台的角色 EOA 與合約都在全集：Verify130、ROLE_SEPARATION、部署腳本、監控設定裡的每一個位址", () => {
  for (const rel of [
    "contracts/script/Verify130.s.sol",
    "docs/ROLE_SEPARATION.md",
    "scripts/deploy-129.sh",
    "ops/monitoring/monitors.json",
    "ops/monitoring/deployed.json",
  ]) {
    const text = readFileSync(join(root, rel), "utf8");
    let n = 0;
    for (const { address } of addressesInText(text)) {
      if (wellKnownEntry(address)) continue;
      assert.ok(universe.has(address.toLowerCase()), `${rel} 的 ${address} 不在全集`);
      n += 1;
    }
    assert.ok(n > 0, `${rel} 沒有任何位址？`);
  }
  // 監控設定裡補零成 32 位元組的現行 x402 保險金、廣播紀錄裡的舊 AgentSessionManager、金庫實作、
  // 早期的 SustainabilityBadge（複審 A1）。
  for (const a of [
    "0xc7afe2064106a608e0e21bfbf9aff89b0ead7b9f",
    "0x3e9196a84f89dc688834a62d51fd7e7ddaeb11e7",
    "0xa2d967221da278b26e0432f4a6bd231d7e0a3733",
    "0xa156b658f291f27aa6db5258e72d9dfe8bf4cf5a",
  ]) {
    assert.ok(universe.has(a), a);
  }
  assert.ok(![...universe.keys()].some((a) => !/^0x[0-9a-f]{40}$/.test(a)));
});
