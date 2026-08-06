// 檢查 commit 進 repo 的 api/index.js 是否與目前的 src/*.ts 同步。
//
// 稽核 2026-08-06（四·Medium）：Vercel 服務的是 commit 進 repo 的 4.8MB bundle，
// **沒有 build step** —— 改了 src/*.ts 忘記重打包，線上跑的就是舊碼，而且沒有任何
// 東西會告訴你。這支讓 CI 能把「忘記 bundle」變成一個紅燈。
//
//   npm run bundle:check -w signal-api     # 不一致 → exit 1
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const OUT = "api/index.js";

const banner = {
  js:
    "import{createRequire as __cr}from'module';" +
    "import{fileURLToPath as __ftp}from'url';" +
    "import{dirname as __dn}from'path';" +
    "const require=__cr(import.meta.url);" +
    "const __filename=__ftp(import.meta.url);" +
    "const __dirname=__dn(__filename);",
};

const result = await build({
  entryPoints: ["src/vercel-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  outfile: OUT,
  banner,
});

const fresh = result.outputFiles[0].text;
let committed;
try {
  committed = await readFile(OUT, "utf8");
} catch {
  console.error(`::error::${OUT} 不存在 —— 請跑 npm run bundle:vercel 並 commit。`);
  process.exit(1);
}

const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
if (h(fresh) !== h(committed)) {
  console.error(
    `::error::${OUT} 與目前的 src/*.ts 不同步（committed ${h(committed)} ≠ rebuilt ${h(fresh)}）。\n` +
      "Vercel 服務的是這個 commit 進 repo 的 bundle，沒有 build step —— " +
      "請跑 `npm run bundle:vercel -w signal-api` 後把 api/index.js 一起 commit。",
  );
  process.exit(1);
}
console.log(`✓ ${OUT} 與 src/ 同步（${h(fresh)}）`);
