// 預設的前端網域白名單（/demo/* 與 /reference-prices 共用）。
//
// 2026-11-06：正式前端有兩個網址（-djot 與 pepelab-onchain-cfd），白名單只列了 -djot，
// 從另一個網址打開時「免費試看」與參考價都被 403，一直沒有測試發現。這裡釘住兩個網址，
// 並用 CORS preflight 確認中介層真的放行（不打網路、不需要任何金鑰）。
import assert from "node:assert";

delete process.env.CORS_ALLOWED_ORIGINS; // 測的是程式裡的預設值
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";

const { createApp, DEFAULT_CORS_ALLOWED_ORIGINS } = await import("./app.ts");
const { freshOracleReader } = await import("./testing/freshOracle.ts");

const PRODUCTION_FRONTENDS = [
  "https://pepelab-onchain-cfd-djot.vercel.app",
  "https://pepelab-onchain-cfd.vercel.app",
];

for (const origin of PRODUCTION_FRONTENDS) {
  assert.ok(DEFAULT_CORS_ALLOWED_ORIGINS.includes(origin), `預設白名單少了正式前端 ${origin}`);
}
console.log("✓ 預設白名單包含兩個正式前端網址");

const app = createApp({
  payTo: "0x4444444444444444444444444444444444444444",
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => false,
  oracleFreshnessReader: freshOracleReader,
});

const preflight = (origin: string) =>
  app.fetch(
    new Request("http://localhost/reference-prices", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    }),
  );

for (const origin of PRODUCTION_FRONTENDS) {
  const res = await preflight(origin);
  assert.equal(res.headers.get("access-control-allow-origin"), origin, `${origin} 的 preflight 沒被放行`);
}
console.log("✓ 兩個正式前端的 /reference-prices preflight 都被放行");

const foreign = await preflight("https://evil.example");
assert.notEqual(foreign.headers.get("access-control-allow-origin"), "https://evil.example", "白名單外的 origin 不該被放行");
console.log("✓ 白名單外的 origin 不被放行");

console.log("\n✅ corsDefaults.test.ts 全過");
