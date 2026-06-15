// Vercel serverless 進入點：用 hono/vercel 把共用的 createApp() 包成 handler。
// 路由邏輯完全沿用 src/app.ts（不重寫端點）。Vercel 專案 root = agent/signal-api，
// install 在 monorepo 根（解 @pepelab/shared workspace 依賴）；env 走 Vercel secrets。
import { handle } from "hono/vercel";
import { loadEnv } from "@pepelab/shared";
import { createApp } from "../src/app.ts";

loadEnv(); // Vercel 上環境變數已注入；本機 vercel dev 時讀 agent/.env

// ethers / secp256k1 需要 Node runtime（非 Edge）。
export const config = { runtime: "nodejs" };

const app = createApp();

export default handle(app);
