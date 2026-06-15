// x402 付費 Signal API — 本機 node 啟動外殼（路由在 app.ts，與 Vercel 共用）。
//   GET /signals/:trader  — trader 績效 + 開倉建議  (0.01 USDC)
//   GET /oracle/:asset    — 價格 + funding + OI 快照 (0.005 USDC)
// 全程 Base Sepolia + 官方 USDC；x402 收入經 routeExternalRevenue 70/20/10 上鏈。
import { serve } from "@hono/node-server";
import { loadEnv } from "@pepelab/shared";

loadEnv();

const { createApp, config } = await import("./app.ts");

const PORT = Number(process.env.SIGNAL_API_PORT ?? 4021);
const app = createApp();

if (!process.env.PAY_TO?.trim()) {
  console.warn(
    "⚠ 未設 PAY_TO，回退到 MockUSDC FeeRouter；官方 USDC 付款會卡死。請在 .env 設 PAY_TO=treasury EOA。",
  );
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`▶ Signal API listening on http://localhost:${info.port}`);
  console.log(`  payTo (x402 收款): ${config.PAY_TO}`);
  console.log(`  結算網路: ${config.NETWORK}  facilitator: ${config.FACILITATOR_URL}`);
  console.log(`  鏈上分潤結算: ${config.isSettlementEnabled() ? "ON ⛓" : "off (僅讀)"}`);
  console.log(`  /revenue 鏈上讀: ${config.isOnchainRevenueEnabled() ? "ON" : "off (X402_FEE_ROUTER 未設)"}`);
});
