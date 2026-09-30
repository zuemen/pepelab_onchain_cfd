// 指紋函式的行為測試。用 node:test 跑，不引入測試框架——這個檔案的存在理由是
// 讓 bundle:check 可以跨平台成立，它自己不該再帶進一個跨平台的依賴。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { fingerprintSources } from "./bundleFingerprint.mjs";

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "fp-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

test("同樣的內容給同樣的 digest", async () => {
  const a = await fixture({ "a.ts": "export const x = 1\n" });
  const b = await fixture({ "a.ts": "export const x = 1\n" });
  assert.equal((await fingerprintSources(a)).digest, (await fingerprintSources(b)).digest);
});

test("改一個字元 digest 就變", async () => {
  const a = await fixture({ "a.ts": "export const x = 1\n" });
  const b = await fixture({ "a.ts": "export const x = 2\n" });
  assert.notEqual((await fingerprintSources(a)).digest, (await fingerprintSources(b)).digest);
});

test("CRLF 與 LF 視為相同 —— 跨平台 checkout 不該讓 CI 說謊", async () => {
  const lf = await fixture({ "a.ts": "export const x = 1\nexport const y = 2\n" });
  const crlf = await fixture({ "a.ts": "export const x = 1\r\nexport const y = 2\r\n" });
  assert.equal((await fingerprintSources(lf)).digest, (await fingerprintSources(crlf)).digest);
});

test("digest 不隨檔案系統回傳順序改變", async () => {
  const one = await fixture({ "a.ts": "1\n", "b.ts": "2\n" });
  const two = await fixture({ "b.ts": "2\n", "a.ts": "1\n" });
  assert.equal((await fingerprintSources(one)).digest, (await fingerprintSources(two)).digest);
});

test("只看 .ts,其他檔案不影響 digest", async () => {
  const withNoise = await fixture({ "a.ts": "1\n", "notes.md": "hello\n" });
  const without = await fixture({ "a.ts": "1\n" });
  assert.equal((await fingerprintSources(withNoise)).digest, (await fingerprintSources(without)).digest);
});

test("子目錄的檔案也算進去", async () => {
  const flat = await fixture({ "a.ts": "1\n" });
  const nested = await fixture({ "a.ts": "1\n", "sub/b.ts": "2\n" });
  assert.notEqual((await fingerprintSources(flat)).digest, (await fingerprintSources(nested)).digest);
});

test("files 用 / 當路徑分隔,鍵是相對路徑", async () => {
  const dir = await fixture({ "a.ts": "1\n", "sub/b.ts": "2\n" });
  const { files } = await fingerprintSources(dir);
  assert.deepEqual(Object.keys(files).sort(), ["a.ts", "sub/b.ts"]);
});

test("改動只會反映在被改的那個檔案上,方便 CI 指出是誰變了", async () => {
  const before = await fixture({ "a.ts": "1\n", "b.ts": "2\n" });
  const after = await fixture({ "a.ts": "1\n", "b.ts": "CHANGED\n" });
  const f1 = (await fingerprintSources(before)).files;
  const f2 = (await fingerprintSources(after)).files;
  assert.equal(f1["a.ts"], f2["a.ts"]);
  assert.notEqual(f1["b.ts"], f2["b.ts"]);
});

// ── 2026-09-29：bundle 指紋涵蓋 esbuild 實際內聯的所有來源 ─────────────────────
import { fingerprintBundle, bundleInputs, SIGNAL_API_DIR, REPO_ROOT } from "./bundleFingerprint.mjs";

async function bundleFixture(sharedBody) {
  return fixture({
    "app/entry.ts": 'import { x } from "../shared/lib.ts";\nexport default x;\n',
    "shared/lib.ts": sharedBody,
    "shared/unused.ts": "export const y = 1\n",
  });
}

test("改動被內聯的 shared 檔案 → 指紋改變", async () => {
  const a = await bundleFixture("export const x = 1\n");
  const b = await bundleFixture("export const x = 2\n");
  const fa = await fingerprintBundle({ entry: "entry.ts", cwd: join(a, "app"), root: a });
  const fb = await fingerprintBundle({ entry: "entry.ts", cwd: join(b, "app"), root: b });
  assert.deepEqual(Object.keys(fa.files).sort(), ["app/entry.ts", "shared/lib.ts"]);
  assert.notEqual(fa.digest, fb.digest);
  assert.equal(fa.files["app/entry.ts"], fb.files["app/entry.ts"]);
  assert.notEqual(fa.files["shared/lib.ts"], fb.files["shared/lib.ts"]);
});

test("沒被 import 的檔案不影響指紋", async () => {
  const a = await bundleFixture("export const x = 1\n");
  const before = await fingerprintBundle({ entry: "entry.ts", cwd: join(a, "app"), root: a });
  await writeFile(join(a, "shared/unused.ts"), "export const y = 999\n");
  const after = await fingerprintBundle({ entry: "entry.ts", cwd: join(a, "app"), root: a });
  assert.equal(before.digest, after.digest);
});

test("真實 signal-api bundle 的來源涵蓋 shared 與 frontend 合約檔", async () => {
  const inputs = (await bundleInputs("src/vercel-entry.ts", SIGNAL_API_DIR)).map((p) =>
    p.slice(REPO_ROOT.length + 1).split("\\").join("/"),
  );
  for (const must of [
    "agent/signal-api/src/app.ts",
    "agent/shared/src/index.ts",
    "agent/shared/src/payoutSafety.ts",
    "frontend/src/contracts/addresses.ts",
    "frontend/src/contracts/agentAuth.ts",
  ]) {
    assert.ok(inputs.includes(must), `bundle 來源應包含 ${must}；實得 ${inputs.join(", ")}`);
  }
  assert.ok(!inputs.some((p) => p.includes("node_modules")), "node_modules 不列入");
  assert.ok(!inputs.some((p) => p.endsWith(".test.ts")), "測試檔不在 bundle 內");
});

// ── 2026-09-30：bundle 指紋涵蓋內聯的 npm 套件版本 ─────────────────────────────
import { packageOf, packagesOf } from "./bundleFingerprint.mjs";

test("packageOf：一般、scoped、巢狀 node_modules、Windows 路徑", () => {
  assert.deepEqual(packageOf("/r/node_modules/hono/dist/index.js")?.name, "hono");
  assert.deepEqual(packageOf("/r/node_modules/@noble/curves/esm/secp256k1.js")?.name, "@noble/curves");
  assert.deepEqual(
    packageOf("/r/node_modules/a/node_modules/@x/y/lib/z.js")?.name,
    "@x/y",
    "取最後一個 node_modules",
  );
  assert.equal(packageOf(String.raw`C:\r\node_modules\viem\_esm\index.js`)?.name, "viem");
  assert.equal(packageOf("/r/src/app.ts"), null);
});

async function pkgFixture(version) {
  return fixture({
    "app/entry.ts": 'import { v } from "dep";\nexport default v;\n',
    "app/node_modules/dep/package.json": JSON.stringify({ name: "dep", version, main: "index.js" }),
    "app/node_modules/dep/index.js": "exports.v = 1;\n",
  });
}

test("只改內聯套件的版本（程式碼不變）→ 指紋改變，且錯誤訊息點得出套件", async () => {
  const a = await pkgFixture("1.0.0");
  const b = await pkgFixture("1.0.1");
  const fa = await fingerprintBundle({ entry: "entry.ts", cwd: join(a, "app"), root: a });
  const fb = await fingerprintBundle({ entry: "entry.ts", cwd: join(b, "app"), root: b });
  assert.notEqual(fa.digest, fb.digest);
  assert.ok("npm:dep@1.0.0" in fa.files);
  assert.ok("npm:dep@1.0.1" in fb.files);
  assert.ok(!Object.keys(fa.files).some((k) => k.includes("node_modules")), "不記安裝路徑");
});

test("同一版本裝在不同位置（hoist 差異）→ 指紋相同", async () => {
  const hoisted = await fixture({
    "app/entry.ts": 'import { v } from "dep";\nexport default v;\n',
    "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "2.0.0", main: "index.js" }),
    "node_modules/dep/index.js": "exports.v = 1;\n",
  });
  const local = await fixture({
    "app/entry.ts": 'import { v } from "dep";\nexport default v;\n',
    "app/node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "2.0.0", main: "index.js" }),
    "app/node_modules/dep/index.js": "exports.v = 1;\n",
  });
  const fh = await fingerprintBundle({ entry: "entry.ts", cwd: join(hoisted, "app"), root: hoisted });
  const fl = await fingerprintBundle({ entry: "entry.ts", cwd: join(local, "app"), root: local });
  assert.equal(fh.digest, fl.digest);
});

test("真實 signal-api bundle 的套件清單包含 hono 與 viem", async () => {
  const { files } = await fingerprintBundle();
  const pkgs = Object.keys(files).filter((k) => k.startsWith("npm:"));
  assert.ok(pkgs.some((k) => k.startsWith("npm:hono@")), pkgs.join(", "));
  assert.ok(pkgs.some((k) => k.startsWith("npm:viem@")), pkgs.join(", "));
});

test("packagesOf 去重：同套件多個檔案只算一次", async () => {
  const dir = await fixture({
    "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "3.1.4" }),
    "node_modules/dep/a.js": "",
    "node_modules/dep/b.js": "",
  });
  const list = await packagesOf([join(dir, "node_modules/dep/a.js"), join(dir, "node_modules/dep/b.js")]);
  assert.deepEqual(list, ["dep@3.1.4"]);
});
