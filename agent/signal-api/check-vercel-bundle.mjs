// 檢查 commit 進 repo 的 api/index.js 是否從目前的來源打包而來。
// 2026-09-29：「來源」= bundle 實際內聯的所有非 node_modules 檔案（esbuild metafile），
// 包含 agent/shared/src/**、frontend/src/contracts/addresses.ts、agentAuth.ts，
// 不再只看 signal-api/src。
//
// 稽核 2026-08-06（四·Medium）：Vercel 服務的是 commit 進 repo 的 4.8MB bundle，
// **沒有 build step** —— 改了 src/*.ts 忘記重打包，線上跑的就是舊碼，而且沒有任何
// 東西會告訴你。這支讓 CI 能把「忘記 bundle」變成一個紅燈。
//
// 2026-08-29：原本的作法是在 CI 上重新 esbuild 一次、比對輸出的 sha256。那等於
// 要求每台機器的 esbuild 產生位元組相同的輸出，實測不成立（同一個 commit 在三個
// 環境得到三個 hash，見 src/bundleFingerprint.mjs）。於是紅燈講的是「你的 esbuild
// 跟我的不一樣」，而不是「你忘了重新打包」——後者才是這個檢查存在的理由。
// 現在改成比對來源指紋。
//
// 2026-09-30：指紋也涵蓋 bundle 內聯的 npm 套件「名稱@版本」——dependabot 升級依賴
// 卻沒重打包時，這裡會列出是哪個套件（例如 `npm:hono@4.13.9`）。
//
//   npm run bundle:check -w signal-api     # 不一致 → exit 1
import { readFile, access } from "node:fs/promises";

import { fingerprintBundle } from "./src/bundleFingerprint.mjs";

const OUT = "api/index.js";
const MANIFEST = "api/.bundle-sources.json";

const REBUILD_HINT =
  "請跑 `npm run bundle:vercel -w signal-api`，" +
  `並把 ${OUT} 與 ${MANIFEST} 一起 commit。`;

try {
  await access(OUT);
} catch {
  console.error(`::error::${OUT} 不存在 —— ${REBUILD_HINT}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
} catch {
  console.error(`::error::${MANIFEST} 不存在或不是合法 JSON —— ${REBUILD_HINT}`);
  process.exit(1);
}

let fresh;
try {
  fresh = await fingerprintBundle();
} catch (err) {
  // 例如某個被內聯套件的 package.json 讀不到。仍然紅燈，但給可讀的訊息而不是 stack trace。
  console.error(`::error::指紋計算失敗：${err?.message ?? err} —— 先確認 \`npm ci\` 成功，再${REBUILD_HINT}`);
  process.exit(1);
}

if (fresh.digest !== manifest.digest) {
  // 指出「哪幾個檔案變了」，而不是只丟兩個對不起來的 hash——後者只能告訴你
  // 「有東西不對」，不能告訴你要去看哪裡。
  const known = manifest.files ?? {};
  const changed = Object.keys(fresh.files).filter((f) => fresh.files[f] !== known[f]);
  const removed = Object.keys(known).filter((f) => !(f in fresh.files));
  console.error(
    `::error::${OUT} 不是從目前的來源打包出來的` +
      `（manifest ${manifest.digest} ≠ 現在 ${fresh.digest}）。\n` +
      (changed.length ? `新增或修改：${changed.join(", ")}\n` : "") +
      (removed.length ? `已刪除：${removed.join(", ")}\n` : "") +
      "Vercel 服務的是這個 commit 進 repo 的 bundle，沒有 build step —— " +
      REBUILD_HINT,
  );
  process.exit(1);
}

const pkgCount = Object.keys(fresh.files).filter((k) => k.startsWith("npm:")).length;
const srcCount = Object.keys(fresh.files).length - pkgCount;
console.log(`✓ ${OUT} 與 ${srcCount} 個來源檔、${pkgCount} 個 npm 套件同步（${fresh.digest}）`);
