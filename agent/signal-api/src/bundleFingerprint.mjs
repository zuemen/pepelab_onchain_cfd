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
// 「你改了 src 卻忘記重新打包」。後者才是它存在的理由（稽核 2026-08-06 四·Medium：
// Vercel 直接服務 commit 進 repo 的 bundle，**沒有 build step**）。
//
// 改成記錄「這份 bundle 是從哪些來源打出來的」，就與工具鏈版本無關了。
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

/**
 * 換行正規化。Windows checkout 是 CRLF、Linux 是 LF，同一份原始碼不該有兩個指紋。
 * .gitattributes 另外把 *.ts 釘成 LF 當第一層保險，這裡是第二層——只靠 git 設定的話，
 * 一個 core.autocrlf 設錯的開發環境就會讓 CI 對著一份無害的差異亮紅燈。
 */
const normalize = (s) => s.replace(/\r\n/g, "\n");

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function collect(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, base, out);
    } else if (entry.name.endsWith(".ts")) {
      // 路徑一律用 "/"：Windows 的 "\" 會讓同一份原始碼在兩個平台得到不同 digest。
      const key = relative(base, full).split(sep).join("/");
      out[key] = sha(normalize(await readFile(full, "utf8")));
    }
  }
  return out;
}

/**
 * 掃描一個來源目錄，回傳每個 .ts 檔的內容雜湊與整體指紋。
 *
 * @param {string} dir 要掃描的來源目錄（signal-api 用 "src"）
 * @returns {Promise<{ files: Record<string, string>, digest: string }>}
 *   `files` 是「相對路徑 → 內容 sha256 前 16 碼」，`digest` 是整體指紋。
 *   保留 `files` 而不只給一個 digest，是為了讓 check 失敗時能指出**是哪幾個檔案變了**——
 *   只丟兩個對不起來的 hash 只能說「有東西不對」，不能說要去看哪裡。
 */
export async function fingerprintSources(dir) {
  const files = await collect(dir, dir, {});
  // 排序後才組合：readdir 的順序不保證，不排序 digest 會隨檔案系統而變。
  const canonical = Object.keys(files)
    .sort()
    .map((k) => `${k}:${files[k]}`)
    .join("\n");
  return { files, digest: sha(canonical) };
}
