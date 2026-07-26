// Vercel serverless 進入點（原始碼）。由 build-vercel.mjs 用 esbuild 預打包成
// **自包 ESM** 的 api/index.js——把 app.ts、settlement、onchainRevenue 與
// @pepelab/shared 全部內聯，徹底避開 @vercel/node 的 TS 編譯／.ts 副檔名解析／
// workspace symlink／CJS-vs-ESM 不一致問題。
// 用 @hono/node-server/vercel 的 handle（**Node** runtime 適配器，回 (req,res)）。
// 不可用 hono/vercel 的 handle——那是 Edge/Web 版（app.fetch(req)），與 Vercel 的
// Node serverless 簽名不符會 hang → 504。本進入點只 export default handle(app)，
// 絕不 import 到會呼叫 serve()/listen() 的本機啟動碼（src/index.ts）。
import { handle } from "@hono/node-server/vercel";
import { loadEnv } from "@pepelab/shared";
import { createApp } from "./app.ts";

loadEnv(); // Vercel 上 env 已注入；本機 vercel dev 時讀 agent/.env

const app = createApp();

export default handle(app);
