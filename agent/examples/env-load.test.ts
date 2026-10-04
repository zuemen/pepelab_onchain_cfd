// dotenv 載入行為的回歸測試（dotenv 16 → 18 升級，2026-10-04）。
//   cd agent && npx tsx examples/env-load.test.ts
//
// 守住三件事：
//   1. 載入 .env 不在 stdout／stderr 印任何東西（keeper／CI／Vercel log）。
//   2. 已存在的環境變數不被 .env 覆寫——即使環境或 .env 裡有 DOTENV_OVERRIDE=true。
//   3. 解析結果與 dotenv 16 的預設 parser 相同（不被 DOTENV_FAST 換掉）。
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { dotenvLoadOptions, loadEnv } from "@pepelab/shared";

/** 執行 fn 期間攔下所有 stdout／stderr 輸出（console.log／error 也走這裡）。 */
function captureOutput(fn: () => void): string[] {
  const out: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(`stdout:${String(s)}`), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => (out.push(`stderr:${String(s)}`), true)) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
  return out;
}

const KEYS = [
  "PEPE_ENVTEST_SECRET",
  "PEPE_ENVTEST_EXISTING",
  "PEPE_ENVTEST_QUOTED",
  "PEPE_ENVTEST_EXPORTED",
  "DOTENV_QUIET",
  "DOTENV_DEBUG",
  "DOTENV_OVERRIDE",
  "DOTENV_FAST",
  "DOTENV_CONFIG_QUIET",
  "DOTENV_CONFIG_DEBUG",
  "DOTENV_CONFIG_OVERRIDE",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

const dir = mkdtempSync(join(tmpdir(), "pepe-envtest-"));
try {
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "PEPE_ENVTEST_SECRET=supersecret-value",
      "PEPE_ENVTEST_EXISTING=from-file",
      'PEPE_ENVTEST_QUOTED="a\\nb"',
      "export PEPE_ENVTEST_EXPORTED=1 # 註解",
      "",
    ].join("\n"),
  );

  // ── 1＋2＋3：環境裡把 dotenv 的每個開關都往「會印、會覆寫、換 parser」的方向撥 ──
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    DOTENV_QUIET: "false",
    DOTENV_DEBUG: "true",
    DOTENV_OVERRIDE: "true",
    DOTENV_FAST: "true",
    DOTENV_CONFIG_QUIET: "false",
    DOTENV_CONFIG_DEBUG: "true",
    DOTENV_CONFIG_OVERRIDE: "true",
    PEPE_ENVTEST_EXISTING: "from-env",
  });
  let parsed: Record<string, string> | undefined;
  const logs = captureOutput(() => {
    parsed = config(dotenvLoadOptions(envFile)).parsed;
    config(dotenvLoadOptions(envFile)); // 進入點會重複呼叫（autoload-env ＋ loadEnv），要冪等
  });
  assert.deepEqual(logs, [], `載入 .env 不可輸出任何東西，實際：${JSON.stringify(logs)}`);
  assert.equal(process.env.PEPE_ENVTEST_EXISTING, "from-env", "DOTENV_OVERRIDE=true 不可讓 .env 覆寫既有變數");
  assert.equal(process.env.PEPE_ENVTEST_SECRET, "supersecret-value");
  assert.equal(process.env.PEPE_ENVTEST_QUOTED, "a\nb", "雙引號內的 \\n 照舊展開");
  assert.equal(process.env.PEPE_ENVTEST_EXPORTED, "1", "export 前綴與行尾註解照舊處理");
  assert.deepEqual(Object.keys(parsed ?? {}), [
    "PEPE_ENVTEST_SECRET",
    "PEPE_ENVTEST_EXISTING",
    "PEPE_ENVTEST_QUOTED",
    "PEPE_ENVTEST_EXPORTED",
  ]);
  console.log("✓ 環境裡 DOTENV_QUIET/DEBUG/OVERRIDE/FAST 全開：不輸出、不覆寫、parser 不變");

  // ── .env 檔自己寫 DOTENV_QUIET=false／DOTENV_OVERRIDE=true 也一樣 ───────────
  restoreEnv();
  for (const k of KEYS) delete process.env[k];
  process.env.PEPE_ENVTEST_EXISTING = "from-env";
  const envFile2 = join(dir, "self.env");
  writeFileSync(envFile2, "DOTENV_QUIET=false\nDOTENV_CONFIG_QUIET=false\nDOTENV_OVERRIDE=true\nPEPE_ENVTEST_EXISTING=from-file\n");
  const logs2 = captureOutput(() => {
    config(dotenvLoadOptions(envFile2));
    config(dotenvLoadOptions(envFile2));
  });
  assert.deepEqual(logs2, [], `.env 內的 DOTENV_* 不可打開 log，實際：${JSON.stringify(logs2)}`);
  assert.equal(process.env.PEPE_ENVTEST_EXISTING, "from-env");
  console.log("✓ .env 檔內寫 DOTENV_QUIET=false／DOTENV_OVERRIDE=true：仍不輸出、不覆寫");

  // ── 檔案不存在（CI 沒有 agent/.env）：不輸出、不丟例外 ───────────────────────
  restoreEnv();
  process.env.DOTENV_DEBUG = "true";
  process.env.DOTENV_QUIET = "false";
  let missingErr: unknown;
  const logs3 = captureOutput(() => {
    missingErr = config(dotenvLoadOptions(join(dir, "nope.env"))).error;
  });
  assert.deepEqual(logs3, [], `缺檔不可輸出，實際：${JSON.stringify(logs3)}`);
  assert.equal((missingErr as NodeJS.ErrnoException | undefined)?.code, "ENOENT", "缺檔只回傳 error，不丟例外");
  console.log("✓ .env 不存在：不輸出、不丟例外");

  // ── 實際的 loadEnv()（讀 agent/.env，不論它存不存在）也不輸出 ────────────────
  const logs4 = captureOutput(() => {
    loadEnv();
    loadEnv();
  });
  assert.deepEqual(logs4, [], `loadEnv() 不可輸出，實際：${JSON.stringify(logs4)}`);
  console.log("✓ loadEnv() 在 DOTENV_DEBUG=true／DOTENV_QUIET=false 下仍不輸出");
} finally {
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
}

console.log("env-load.test.ts ✓ all assertions passed");
