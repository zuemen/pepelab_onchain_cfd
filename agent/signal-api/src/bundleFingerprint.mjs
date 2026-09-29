// Bundle 來源指紋。build-vercel.mjs 與 check-vercel-bundle.mjs 共用這一份——
// 兩邊各自算一次就等於沒有檢查。
//
// 為什麼不是「重建後比對輸出位元組」（2026-08-29 之前的作法）：那要求兩台機器的
// esbuild 產生完全相同的輸出。實測不成立——同一個 commit：
//
//   本機 signal-api/node_modules 的 esbuild 0.24.2 → 71fde29ee445c7cf
//   本機 hoist 到 agent/node_modules 的 0.28.1     → 0f40bd349edc2f2a
//   GitHub Actions                                  → 945cfee402b45c74
//
// 於是 CI 紅燈講的是「你的 esbuild 跟我的不一樣」，而不是這個檢查真正要防的
// 「你改了 src 卻忘記重新打包」。改成記錄「這份 bundle 是從哪些來源打出來的」。
//
// 2026-09-29（P0）：以前只 hash `signal-api/src/*.ts`，但 bundle 實際內聯的還有
// `agent/shared/src/**`、`frontend/src/contracts/addresses.ts`、`agentAuth.ts`……
// 改了 shared（例如收款守門、ABI）卻忘記重打包，檢查照樣綠燈。現在來源清單取自
// esbuild 的 metafile（`write: false`，只要 import 圖、不看輸出位元組）——bundle 內聯
// 了哪些非 node_modules 檔案，指紋就涵蓋哪些，新增的 import 也會自動納入。
// 輸入清單只取決於 import 圖，與 esbuild 版本無關。
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 換行正規化。Windows checkout 是 CRLF、Linux 是 LF，同一份原始碼不該有兩個指紋。
 */
const normalize = (s) => s.replace(/\r\n/g, "\n");

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const toPosix = (p) => p.split(sep).join("/");

function digestOf(files) {
  // 排序後才組合：順序不保證，不排序 digest 會隨檔案系統而變。
  return sha(
    Object.keys(files)
      .sort()
      .map((k) => `${k}:${files[k]}`)
      .join("\n"),
  );
}

async function collect(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, base, out);
    } else if (entry.name.endsWith(".ts")) {
      out[toPosix(relative(base, full))] = sha(normalize(await readFile(full, "utf8")));
    }
  }
  return out;
}

/**
 * 掃描一個來源目錄，回傳每個 .ts 檔的內容雜湊與整體指紋。（目錄版，保留給測試與
 * 舊呼叫端；bundle 檢查改用 fingerprintBundle。）
 *
 * @param {string} dir
 * @returns {Promise<{ files: Record<string, string>, digest: string }>}
 */
export async function fingerprintSources(dir) {
  const files = await collect(dir, dir, {});
  return { files, digest: digestOf(files) };
}

/**
 * 對一組檔案算指紋。鍵是相對 `root` 的 "/" 路徑。
 *
 * @param {string} root
 * @param {string[]} absPaths
 */
export async function fingerprintFiles(root, absPaths) {
  const files = {};
  for (const p of absPaths) {
    files[toPosix(relative(root, p))] = sha(normalize(await readFile(p, "utf8")));
  }
  return { files, digest: digestOf(files) };
}

/**
 * 用 esbuild metafile 取得 entry 實際打包進去的**非 node_modules** 來源檔（絕對路徑）。
 * 不寫檔（write:false），只看 import 圖。
 *
 * @param {string} entry 入口檔（絕對或相對 cwd）
 * @param {string} cwd   esbuild 的工作目錄
 */
export async function bundleInputs(entry, cwd) {
  const { build } = await import("esbuild");
  const r = await build({
    entryPoints: [entry],
    absWorkingDir: resolve(cwd),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    outfile: "__fingerprint__.js",
    logLevel: "silent",
  });
  return Object.keys(r.metafile.inputs)
    .filter((k) => !k.split(/[\\/]/).includes("node_modules"))
    .map((k) => resolve(cwd, k))
    .sort();
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** signal-api 目錄（本檔在 signal-api/src/）。 */
export const SIGNAL_API_DIR = resolve(HERE, "..");
/** repo 根目錄：manifest 的鍵以它為基準（例如 `agent/shared/src/env.ts`）。 */
export const REPO_ROOT = resolve(SIGNAL_API_DIR, "../..");
export const VERCEL_ENTRY = "src/vercel-entry.ts";

/**
 * Vercel bundle 的來源指紋：entry 內聯的所有非 node_modules 檔案。
 *
 * @param {{ entry?: string, cwd?: string, root?: string }} [opts]
 */
export async function fingerprintBundle(opts = {}) {
  const cwd = opts.cwd ?? SIGNAL_API_DIR;
  const root = opts.root ?? REPO_ROOT;
  const inputs = await bundleInputs(opts.entry ?? VERCEL_ENTRY, cwd);
  return fingerprintFiles(root, inputs);
}
