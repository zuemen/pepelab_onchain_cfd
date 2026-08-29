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
