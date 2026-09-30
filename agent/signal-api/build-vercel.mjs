// 把 Vercel serverless 進入點 esbuild 打包成自包 ESM：api/index.js。
// 內聯 app.ts / settlement / onchainRevenue / @pepelab/shared 與所有 npm 依賴，
// 故執行期不需解析 .ts 副檔名或 workspace symlink，且格式與 package.json
// "type":"module" 一致（不會再噴 "exports is not defined"）。
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

import { BUILD_OPTIONS, fingerprintBundle } from "./src/bundleFingerprint.mjs";

await build({
  // 與指紋共用同一份選項（bundle/platform/format/target/external），見 BUILD_OPTIONS。
  ...BUILD_OPTIONS,
  entryPoints: ["src/vercel-entry.ts"],
  outfile: "api/index.js",
  // ESM 下補 require/__dirname/__filename，避免某些被內聯的 CJS 依賴在執行期缺這些。
  banner: {
    js:
      "import{createRequire as __cr}from'module';" +
      "import{fileURLToPath as __ftp}from'url';" +
      "import{dirname as __dn}from'path';" +
      "const require=__cr(import.meta.url);" +
      "const __filename=__ftp(import.meta.url);" +
      "const __dirname=__dn(__filename);",
  },
});

console.log("✓ bundled api/index.js (self-contained ESM)");

// 把「這份 bundle 是從哪些來源打出來的」一起寫下來。bundle:check 比對的是這個，
// 不是重新 esbuild 一次的輸出——見 src/bundleFingerprint.mjs 開頭的說明。
// 來源清單 = esbuild metafile 裡所有非 node_modules 的輸入（signal-api/src、
// agent/shared/src、frontend/src/contracts/*…），鍵以 repo 根目錄為基準。
const fp = await fingerprintBundle();
await writeFile(
  "api/.bundle-sources.json",
  `${JSON.stringify({ digest: fp.digest, files: fp.files }, null, 2)}\n`,
);
console.log(`✓ wrote api/.bundle-sources.json (${fp.digest}, ${Object.keys(fp.files).length} files)`);
