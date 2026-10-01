// Cloudflare Worker：每 5 分鐘對 Base Sepolia 做一輪唯讀監控並送告警。
//
// 權限面：沒有 GitHub token、沒有鏈上私鑰；只有告警通道的憑證（Worker secret）與一個
// KV namespace。對 HTTP 請求一律 404（workers_dev/preview_urls 關閉，不產生公開網址）。
// 規則見 monitors.json／rules.md；決策見 docs/ADR-009-monitoring.md；部署見 README.md。
import config from "./monitors.json";
import { tick } from "./tick.mjs";

export default {
  // 直接 await：tick 丟錯（通道全掛、沒有通道、規則讀取失敗）時，Cloudflare 會把這次 cron
  // 記成失敗，Workers Logs 看得到。
  async scheduled(event, env) {
    await tick({ config, env, now: Math.floor((event?.scheduledTime ?? Date.now()) / 1000) });
  },
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
