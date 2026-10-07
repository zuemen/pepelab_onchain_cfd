// signal-api 的閘門測試（稽核 四·Medium / 四·Low）。離線、不打鏈、不付費：
// 直接對 Hono app 送 Request，檢查 402 之前的那幾道閘門。
//
//   • 未知 symbol / 非法 address / 零地址 → **400，而且必須在 x402 付費牆之前**
//     （x402 沒有退費機制；舊行為是先收 $0.005 再回 400）。
//   • 合法輸入 → 402（付費牆確實還在，沒有被驗證邏輯誤擋）。
//   • /demo/* 的 origin 白名單。
//   • 免費端點的 per-IP 節流。
//
//   npx tsx examples/api-gate.test.ts
import assert from "node:assert";

// 指向連不上的 RPC：本測試不應該需要任何鏈上互動。
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.FREE_RATE_MAX = "5";
process.env.FREE_RATE_WINDOW_MS = "60000";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";

const { createApp } = await import("../signal-api/src/app.ts");
const { freshOracleReader } = await import("../signal-api/src/testing/freshOracle.ts");

async function main() {
  // P0：payTo 守門在 402 前檢查收款地址；這裡給安全 EOA + 假 getCode（無 code），不打 RPC。
  const app = createApp({
    trustProxyHeaders: true, // 模擬 Vercel：平台覆寫 x-forwarded-for，每個值代表一個用戶端
    payTo: "0x4444444444444444444444444444444444444444",
    payoutCodeReader: { getCode: async () => "0x" },
    // 只有 0x5555… 是「已註冊 trader」；0x6666… 讓 registry 查詢失敗。
    isRegisteredTrader: async (t) => {
      if (t.toLowerCase() === "0x" + "66".repeat(20)) throw new Error("rpc down (fake)");
      return t.toLowerCase() === "0x" + "55".repeat(20);
    },
    oracleFreshnessReader: freshOracleReader,
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request("http://localhost" + path, { headers }));

  // ── 付費前的輸入驗證 ─────────────────────────────────────────────────────
  {
    const res = await get("/oracle/sDOGE");
    assert.equal(res.status, 400, `未知資產應在付費前回 400，實得 ${res.status}`);
    const j = (await res.json()) as any;
    assert.ok(j.error.includes("sDOGE"), JSON.stringify(j));
    assert.ok(Array.isArray(j.known) && j.known.includes("sBTC"));
    console.log("✓ /oracle/sDOGE → 400（未付款）");
  }
  {
    const res = await get("/signals/not-an-address");
    assert.equal(res.status, 400);
    console.log("✓ /signals/not-an-address → 400（未付款）");
  }
  {
    const res = await get("/signals/0x0000000000000000000000000000000000000000");
    assert.equal(res.status, 400, "零地址會讓 70% 分潤進黑洞，必須擋");
    console.log("✓ /signals/<零地址> → 400（未付款）");
  }

  {
    // 外洩地址當 trader：70% 分潤會落到攻擊者手上 → 付費前 400。
    const res = await get("/signals/0xE80A81360608C1342e66743F70a00f75d792Eb93");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "trader_compromised");
    console.log("✓ /signals/<外洩地址> → 400 trader_compromised（未付款）");
  }

  {
    // 未註冊的 trader：付款前 400，不發 402（以前是先收 $0.01 才發現沒有訊號可賣）。
    const res = await get("/signals/0x7777777777777777777777777777777777777777");
    assert.equal(res.status, 400, `未註冊 trader 應在付費前回 400，實得 ${res.status}`);
    const j = (await res.json()) as any;
    assert.equal(j.error, "trader_not_registered");
    assert.equal(j.accepts, undefined, "不可帶任何付款要求");
    console.log("✓ /signals/<未註冊 trader> → 400 trader_not_registered（未付款）");
  }
  {
    // 讀不到 registry：無法確認就不賣 → 503（未付款）。
    const res = await get("/signals/0x6666666666666666666666666666666666666666");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).error, "registry_unavailable");
    console.log("✓ /signals/<registry 查詢失敗> → 503（未付款）");
  }

  // ── 合法輸入仍然要撞到付費牆（別把付費牆改掉了）─────────────────────────
  {
    const res = await get("/signals/0x5555555555555555555555555555555555555555");
    assert.equal(res.status, 402, `合法 trader 應回 402，實得 ${res.status}`);
    console.log("✓ /signals/<合法地址> → 402（付費牆仍在）");
  }
  {
    // sBTC 合法、鏈上價格新鮮 → 付費牆的 402。
    const res = await get("/oracle/sBTC");
    assert.equal(res.status, 402, `合法資產應回 402，實得 ${res.status}`);
    console.log("✓ /oracle/sBTC → 402（付費牆仍在）");
  }
  {
    // 新鮮度讀不到（RPC 失敗）→ 503、不發 402（fail-closed）。以前這裡放行，照樣收費賣出
    // 一份沒檢查過新鮮度的價格。
    const down = createApp({
      payTo: "0x4444444444444444444444444444444444444444",
      payoutCodeReader: { getCode: async () => "0x" },
      oracleFreshnessReader: async () => {
        throw new Error("rpc down (fake)");
      },
    });
    const res = await down.fetch(new Request("http://localhost/oracle/sBTC"));
    assert.equal(res.status, 503, `新鮮度讀不到應回 503，實得 ${res.status}`);
    const body = (await res.json()) as { error?: string; accepts?: unknown };
    assert.equal(body.error, "price_unverified");
    assert.equal(body.accepts, undefined, "不可附上付款要求");
    console.log("✓ /oracle/sBTC 新鮮度讀不到 → 503 price_unverified（未發出 402）");
  }
  {
    // 讀得到、但超過交易所 maxPriceAge → 503 price_stale（既有行為，補上測試）。
    const stale = createApp({
      payTo: "0x4444444444444444444444444444444444444444",
      payoutCodeReader: { getCode: async () => "0x" },
      oracleFreshnessReader: async () => ({ updatedAtSec: Math.floor(Date.now() / 1000) - 7 * 3600, maxPriceAgeSec: 21_600 }),
    });
    const res = await stale.fetch(new Request("http://localhost/oracle/sBTC"));
    assert.equal(res.status, 503, `過期價格應回 503，實得 ${res.status}`);
    assert.equal(((await res.json()) as { error?: string }).error, "price_stale");
    console.log("✓ /oracle/sBTC 價格超過 maxPriceAge → 503 price_stale");
  }

  // ── liveness 不受節流影響 ────────────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    const r = await get("/healthz", { "x-forwarded-for": "1.1.1.1" });
    assert.equal(r.status, 200);
  }
  console.log("✓ /healthz 不被節流（liveness 必須永遠即時）");

  // ── 免費端點的 per-IP 節流 ───────────────────────────────────────────────
  {
    const ip = { "x-forwarded-for": "9.9.9.9" };
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await get("/candles/sBTC", ip);
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "超過 FREE_RATE_MAX 後必須開始回 429");
    // 另一個 IP 不受影響。
    const other = await get("/candles/sBTC", { "x-forwarded-for": "8.8.8.8" });
    assert.notEqual(other.status, 429);
    console.log(`✓ 免費端點 per-IP 節流生效（8 次中 ${limited} 次 429，其他 IP 不受影響）`);
  }

  // ── 不在 Vercel 後面（本機／PoC 直接對外）：客戶端自填的 x-forwarded-for 不能拿來換 IP ──────
  {
    const { trustProxyFromEnv } = await import("../signal-api/src/app.ts");
    assert.equal(trustProxyFromEnv({}), false, "預設不信任");
    assert.equal(trustProxyFromEnv({ VERCEL: "1" }), true, "Vercel 會覆寫 header");
    assert.equal(trustProxyFromEnv({ SIGNAL_API_TRUST_PROXY: "1" }), true);
    assert.equal(trustProxyFromEnv({ SIGNAL_API_TRUST_PROXY: "true" }), false, "只接受 1");
    const direct = createApp({
      trustProxyHeaders: false,
      payTo: "0x4444444444444444444444444444444444444444",
      payoutCodeReader: { getCode: async () => "0x" },
    });
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await direct.fetch(
        new Request("http://localhost/candles/sBTC", { headers: { "x-forwarded-for": `203.0.113.${i}` } }),
      );
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "每個請求偽造不同的 x-forwarded-for，仍然算同一個用戶端、照樣被節流");
    console.log(`✓ 不信任代理時，偽造的 x-forwarded-for 繞不過節流（8 次中 ${limited} 次 429）`);
  }

  // ── /demo/* 的 origin 白名單 ────────────────────────────────────────────
  {
    const bad = await app.fetch(
      new Request("http://localhost/demo/buy-signal", {
        method: "POST",
        headers: { origin: "https://evil.example", "x-forwarded-for": "7.7.7.7" },
        body: "{}",
      }),
    );
    assert.equal(bad.status, 403, `非白名單 origin 應 403，實得 ${bad.status}`);
    console.log("✓ /demo/buy-signal 非白名單 origin → 403");
  }

  console.log("\n✅ api-gate.test.ts 全過（付費前驗證 / 節流 / origin 白名單）");
}

main().catch((e) => { console.error("\n❌ api-gate 測試失敗：", e); process.exit(1); });
