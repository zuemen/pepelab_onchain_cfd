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
//
// 2026-09-30：原始碼之外，也記錄 bundle 內聯的 npm 套件「名稱@版本」。以前
// dependabot 升級 hono／viem 後 CI 照樣綠燈（PR #185），但 commit 進 repo 的
// bundle 仍是舊版依賴——線上根本沒升級。只記名稱與版本、不記安裝路徑，
// 所以 hoist 位置不同不影響；esbuild 本身不在 bundle 內，也不影響。
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
 * build-vercel.mjs 與指紋共用的 esbuild 選項。兩邊各抄一份的話，任何一邊加了
 * external／alias／define 而另一邊沒加，指紋算的 import 圖就不再是真正 bundle 的
 * import 圖。只放會影響 import 圖或輸出的選項；entry、outfile、banner 由呼叫端給。
 *
 * external：ws 在 try/catch 裡 require 這兩個原生加速套件（ws 官方建議外部化）。
 * 內聯它們只會帶進找不到 .node 二進位的 loader，執行期照樣退回 JS 實作。
 */
export const BUILD_OPTIONS = Object.freeze({
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["bufferutil", "utf-8-validate"],
});

/**
 * 影響 bundle 輸出、但不在 import 圖裡的建置設定檔。以內容雜湊納入指紋，
 * 改了它們卻沒重打包時 check 會紅燈。（esbuild 本身的版本刻意不納入：那會讓
 * 每次 dependabot 升 esbuild 都強迫重打包，而輸出差異只是工具鏈雜訊。）
 * 同版本但 lockfile 的 integrity 改變也不偵測——npm 不允許同版本重新發布。
 */
// esbuild 對每個檔案就近取 tsconfig：內聯的 frontend/src/contracts/*.ts 套的是 frontend/tsconfig.json。
export const BUILD_CONFIG_FILES = [
  "agent/signal-api/build-vercel.mjs",
  "agent/tsconfig.json",
  "agent/tsconfig.base.json",
  "frontend/tsconfig.json",
];

/**
 * 跑一次 esbuild（write:false、metafile），回傳 entry 內聯的所有輸入檔（絕對路徑，
 * 含 node_modules）。只看 import 圖，不看輸出位元組。
 *
 * @param {string} entry 入口檔（絕對或相對 cwd）
 * @param {string} cwd   esbuild 的工作目錄
 */
async function metafileInputs(entry, cwd) {
  const { build } = await import("esbuild");
  const r = await build({
    ...BUILD_OPTIONS,
    entryPoints: [entry],
    absWorkingDir: resolve(cwd),
    write: false,
    metafile: true,
    outfile: "__fingerprint__.js",
    logLevel: "silent",
  });
  return Object.keys(r.metafile.inputs).map((k) => resolve(cwd, k));
}

const inNodeModules = (p) => p.split(/[\\/]/).includes("node_modules");

/**
 * 用 esbuild metafile 取得 entry 實際打包進去的**非 node_modules** 來源檔（絕對路徑）。
 *
 * @param {string} entry 入口檔（絕對或相對 cwd）
 * @param {string} cwd   esbuild 的工作目錄
 */
export async function bundleInputs(entry, cwd) {
  return (await metafileInputs(entry, cwd)).filter((p) => !inNodeModules(p)).sort();
}

/**
 * 從 node_modules 內的檔案路徑找出它所屬套件的根目錄與名稱（取最後一個
 * node_modules 之後的一或兩段，後者是 @scope/name）。
 *
 * @param {string} absPath
 * @returns {{ name: string, dir: string } | null}
 */
export function packageOf(absPath) {
  const segs = absPath.split(/[\\/]/);
  const i = segs.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= segs.length) return null;
  const scoped = segs[i + 1].startsWith("@");
  const end = i + (scoped ? 3 : 2);
  if (end > segs.length) return null;
  return { name: segs.slice(i + 1, end).join("/"), dir: segs.slice(0, end).join(sep) };
}

/**
 * bundle 內聯的 npm 套件，去重、排序後的 `name@version` 清單。
 *
 * @param {string[]} absPaths metafileInputs 的結果
 */
export async function packagesOf(absPaths) {
  const dirs = new Map();
  for (const p of absPaths) {
    const pkg = packageOf(p);
    if (pkg) dirs.set(pkg.dir, pkg.name);
  }
  const out = new Set();
  for (const [dir, name] of dirs) {
    const { version } = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (!version) throw new Error(`${dir}/package.json 沒有 version`);
    out.add(`${name}@${version}`);
  }
  return [...out].sort();
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** signal-api 目錄（本檔在 signal-api/src/）。 */
export const SIGNAL_API_DIR = resolve(HERE, "..");
/** repo 根目錄：manifest 的鍵以它為基準（例如 `agent/shared/src/env.ts`）。 */
export const REPO_ROOT = resolve(SIGNAL_API_DIR, "../..");
export const VERCEL_ENTRY = "src/vercel-entry.ts";

/**
 * Vercel bundle 的來源指紋：entry 內聯的所有非 node_modules 檔案（內容雜湊），
 * 加上內聯的 npm 套件（鍵 `npm:name@version`，值固定為 "pkg"——版本變了就是
 * 一個鍵新增、一個鍵刪除，check 的錯誤訊息會直接列出是哪個套件）。
 *
 * @param {{ entry?: string, cwd?: string, root?: string }} [opts]
 */
export async function fingerprintBundle(opts = {}) {
  const cwd = opts.cwd ?? SIGNAL_API_DIR;
  const root = opts.root ?? REPO_ROOT;
  const all = await metafileInputs(opts.entry ?? VERCEL_ENTRY, cwd);
  const { files } = await fingerprintFiles(root, all.filter((p) => !inNodeModules(p)).sort());
  if (!opts.entry) {
    // 只對真實的 signal-api bundle 納入建置設定檔；測試 fixture 沒有這些檔案。
    Object.assign(files, (await fingerprintFiles(root, BUILD_CONFIG_FILES.map((f) => resolve(root, f)))).files);
  }
  for (const pkg of await packagesOf(all)) files[`npm:${pkg}`] = "pkg";
  return { files, digest: digestOf(files) };
}
