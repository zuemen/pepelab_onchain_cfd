// Vercel serverless 進入點（原始碼）。由 build-vercel.mjs 用 esbuild 預打包成
// **自包 ESM** 的 api/index.js——把 app.ts、settlement、onchainRevenue 與
// @pepelab/shared 全部內聯，徹底避開 @vercel/node 的 TS 編譯／.ts 副檔名解析／
// workspace symlink／CJS-vs-ESM 不一致問題。
import { handle } from "hono/vercel";
import { loadEnv } from "@pepelab/shared";
import { createApp } from "./app.ts";

loadEnv(); // Vercel 上 env 已注入；本機 vercel dev 時讀 agent/.env

const app = createApp();

export default handle(app);
