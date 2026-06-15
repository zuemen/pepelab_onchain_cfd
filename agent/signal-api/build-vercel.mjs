// 把 Vercel serverless 進入點 esbuild 打包成自包 ESM：api/index.js。
// 內聯 app.ts / settlement / onchainRevenue / @pepelab/shared 與所有 npm 依賴，
// 故執行期不需解析 .ts 副檔名或 workspace symlink，且格式與 package.json
// "type":"module" 一致（不會再噴 "exports is not defined"）。
import { build } from "esbuild";

await build({
  entryPoints: ["src/vercel-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
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
