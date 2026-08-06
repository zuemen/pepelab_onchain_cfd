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

async function main() {
  const app = createApp();
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

  // ── 合法輸入仍然要撞到付費牆（別把付費牆改掉了）─────────────────────────
  {
    const res = await get("/signals/0xE80A81360608C1342e66743F70a00f75d792Eb93");
    assert.equal(res.status, 402, `合法 trader 應回 402，實得 ${res.status}`);
    console.log("✓ /signals/<合法地址> → 402（付費牆仍在）");
  }
  {
    // sBTC 合法。stale 閘門在讀不到鏈上價格時會放行（RPC 連不上 → 交給下游），
    // 因此這裡預期的是付費牆的 402。
    const res = await get("/oracle/sBTC");
    assert.equal(res.status, 402, `合法資產應回 402，實得 ${res.status}`);
    console.log("✓ /oracle/sBTC → 402（付費牆仍在）");
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
