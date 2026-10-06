// GET /reference-prices 測試：假上游（JsonFetcher），不打網路、不送交易。
//   cd agent && npx tsx signal-api/src/referencePrices.test.ts
import assert from "node:assert";

process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.FREE_RATE_MAX = "3";
process.env.FREE_RATE_WINDOW_MS = "60000";

const rp = await import("./referencePrices.ts");
const { SOURCES, SECONDARY_SOURCES } = await import("../../keeper/feeds.ts");
const { createApp } = await import("./app.ts");

let n = 0;
const ok = (msg: string) => {
  n += 1;
  console.log(`  ✓ ${msg}`);
};

const T = 1_791_258_460;

// 假上游：依 host 回固定內容；`fail` 裡的 host 一律丟錯。
function fakeFetcher(fail: Record<string, Error> = {}, calls: string[] = []) {
  return async (url: string): Promise<unknown> => {
    calls.push(url);
    const host = new URL(url).host;
    if (fail[host]) throw fail[host];
    if (host === "api.coingecko.com") {
      const id = new URL(url).searchParams.get("ids")!;
      return { [id]: { usd: id === "bitcoin" ? 85_491 : 2_700, last_updated_at: T - 20 } };
    }
    if (host === "query1.finance.yahoo.com") {
      const sym = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      const price = sym === "BTC-USD" ? 85_500 : sym === "ETH-USD" ? 2_699 : sym === "GC=F" ? 4_160 : 332.89;
      return { chart: { result: [{ meta: { currency: "USD", regularMarketPrice: price, regularMarketTime: T - 3600 } }] } };
    }
    if (host === "api.coinbase.com") {
      return { data: { amount: url.includes("BTC") ? "85510.04" : "2698.5", base: "X", currency: "USD" } };
    }
    if (host === "api.nasdaq.com") {
      return { data: { primaryData: { lastSalePrice: "$332.89", lastTradeTimestamp: "Oct 5, 2026" } } };
    }
    if (host === "api.gold-api.com") {
      return { currency: "USD", price: 4130.8, updatedAt: "2026-10-06T03:49:09Z" };
    }
    throw new Error(`unexpected host ${host}`);
  };
}

// 1) keeper 主來源與 feeds.ts 完全一致——看板上「keeper 實際使用的來源」不能是另一份清單。
{
  for (const [sym, src] of Object.entries(SOURCES)) {
    const def = rp.REFERENCE_ASSETS[sym];
    assert.ok(def, `${sym} 必須出現在參考價清單`);
    const primary = def.sources.find((s) => s.role === "keeper-primary");
    assert.ok(primary, `${sym} 必須有 keeper 主來源`);
    const ticker = src.kind === "coingecko" ? src.id : src.symbol;
    assert.equal(primary!.provider, src.kind, `${sym} 主來源 provider`);
    assert.equal(primary!.ticker, ticker, `${sym} 主來源 ticker`);
  }
  for (const [sym, src] of Object.entries(SECONDARY_SOURCES)) {
    const sec = rp.REFERENCE_ASSETS[sym].sources.find((s) => s.role === "keeper-secondary");
    assert.ok(sec, `${sym} 必須列出 keeper 第二來源`);
    assert.equal(sec!.ticker, src.kind === "coingecko" ? src.id : src.symbol);
  }
  assert.deepEqual(new Set(rp.REFERENCE_SYMBOLS), new Set(Object.keys(SOURCES)), "資產集合與 keeper 相同");
  ok("keeper 主來源／第二來源與 agent/keeper/feeds.ts 一致");
}

// 2) 每檔至少兩個來源；加密至少兩個公開來源（不含 keeper 第二來源也有獨立來源）。
{
  for (const def of Object.values(rp.REFERENCE_ASSETS)) {
    assert.ok(def.sources.length >= 2, `${def.symbol} 至少兩個來源`);
    assert.ok(def.sources.some((s) => s.role === "independent"), `${def.symbol} 有獨立來源`);
  }
  assert.ok(rp.REFERENCE_ASSETS.sBTC.sources.length >= 3);
  assert.match(rp.REFERENCE_ASSETS.sGOLD.note ?? "", /基差/);
  ok("每檔至少兩個來源；黃金標明期貨／現貨基差");
}

// 3) 萃取：壞資料一律 null（不是 0），幣別不是 USD 就拒絕。
{
  assert.deepEqual(rp.extractCoinGeckoQuote({ bitcoin: { usd: 1, last_updated_at: 5 } }, "bitcoin"), { price: 1, quoteTime: 5 });
  assert.equal(rp.extractCoinGeckoQuote({}, "bitcoin").price, null);
  assert.equal(rp.extractCoinGeckoQuote({ bitcoin: { usd: 0 } }, "bitcoin").price, null);
  const yEur = rp.extractYahooQuote({ chart: { result: [{ meta: { currency: "EUR", regularMarketPrice: 1, regularMarketTime: 1 } }] } });
  assert.equal(yEur.price, null);
  assert.match(yEur.error!, /not USD/);
  assert.equal(rp.extractYahooQuote({ chart: { result: [] } }).price, null);
  const y = rp.extractYahooQuote({ chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 10.5, regularMarketTime: 99 } }] } });
  assert.deepEqual(y, { price: 10.5, quoteTime: 99 });
  assert.deepEqual(rp.extractCoinbaseQuote({ data: { amount: "100.5", currency: "USD" } }), { price: 100.5, quoteTime: null });
  assert.equal(rp.extractCoinbaseQuote({ data: { amount: "100.5", currency: "EUR" } }).price, null);
  const nq = rp.extractNasdaqQuote({ data: { primaryData: { lastSalePrice: "$1,332.89", lastTradeTimestamp: "Oct 5, 2026" } } });
  assert.deepEqual(nq, { price: 1332.89, quoteTime: null, quoteTimeText: "Oct 5, 2026" });
  assert.equal(rp.extractNasdaqQuote({ data: null }).price, null);
  assert.equal(rp.extractNasdaqQuote({ data: { primaryData: { lastSalePrice: "N/A" } } }).price, null);
  const g = rp.extractGoldApiQuote({ currency: "USD", price: 4130.8, updatedAt: "2026-10-06T03:49:09Z" });
  assert.equal(g.price, 4130.8);
  assert.equal(g.quoteTime, Math.floor(Date.parse("2026-10-06T03:49:09Z") / 1000));
  ok("萃取：壞資料為 null、非 USD 拒絕、Nasdaq 文字時間原樣保留");
}

// 4) spreadBps
{
  assert.equal(rp.spreadBps([100]), null);
  assert.equal(rp.spreadBps([]), null);
  assert.equal(rp.spreadBps([100, 100]), 0);
  assert.equal(rp.spreadBps([99, 101]), 100); // 中位數 100，最大偏離 1 → 100 bps
  assert.equal(rp.spreadBps([100, 100, 110]), 1000);
  ok("spreadBps：少於兩個值為 null，相對中位數計算");
}

// 5) 報表：一個上游失敗只影響那一格；逾時回 "timeout"、HTTP 錯誤回 "http 4xx"，不帶原文。
{
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const http = new Error("api.nasdaq.com returned 403 https://secret.example/?key=abc");
  const report = await rp.buildReferenceReport(fakeFetcher({ "api.coinbase.com": timeout, "api.nasdaq.com": http }), {
    now: () => T,
  });
  const btc = report.assets.sBTC;
  assert.equal(btc.okCount, 2);
  const cb = btc.sources.find((s) => s.provider === "coinbase")!;
  assert.equal(cb.price, null);
  assert.equal(cb.error, "timeout");
  assert.equal(btc.spreadBps, rp.spreadBps([85_491, 85_500]));
  const aapl = report.assets.sAAPL;
  assert.equal(aapl.okCount, 1);
  assert.equal(aapl.spreadBps, null, "只剩一個成功來源時不給價差");
  const nq = aapl.sources.find((s) => s.provider === "nasdaq")!;
  assert.equal(nq.error, "http 403");
  assert.ok(!JSON.stringify(report).includes("secret.example"), "不回上游錯誤原文");
  assert.equal(aapl.sources[0].quoteTime, T - 3600);
  assert.equal(aapl.sources[0].fetchedAt, T);
  assert.equal(report.ok, true, "每檔至少有一個來源成功");
  const all = await rp.buildReferenceReport(fakeFetcher({ "query1.finance.yahoo.com": http, "api.nasdaq.com": http }), { now: () => T });
  assert.equal(all.assets.sAAPL.okCount, 0);
  assert.equal(all.ok, false);
  ok("單一上游失敗隔離、錯誤只回短原因、報價時間與取值時間分開");
}

// 6) 快取：60 秒、single-flight；有來源失敗時只快取 15 秒
{
  let clock = 0;
  const calls: string[] = [];
  const svc = rp.createReferencePriceService(fakeFetcher({}, calls), { nowMs: () => clock });
  const [a, b] = await Promise.all([svc.get(), svc.get()]);
  assert.equal(a.cacheHit, false);
  assert.equal(b.cacheHit, false);
  const first = calls.length;
  assert.ok(first > 0);
  clock = 59_000;
  assert.equal((await svc.get()).cacheHit, true);
  assert.equal(calls.length, first, "single-flight + 快取：沒有重打上游");
  clock = 61_000;
  assert.equal((await svc.get()).cacheHit, false);

  let c2 = 0;
  const degraded = rp.createReferencePriceService(fakeFetcher({ "api.gold-api.com": new Error("x returned 500") }), {
    nowMs: () => c2,
  });
  const d = await degraded.get();
  assert.equal(d.ttlSec, 15);
  c2 = 16_000;
  assert.equal((await degraded.get()).cacheHit, false);
  ok("快取 60 秒、single-flight；降級時 15 秒");
}

// 7) 路由：GET /reference-prices 免費（不經 x402）、Cache-Control、per-IP 節流
{
  const svc = rp.createReferencePriceService(fakeFetcher(), { nowMs: () => 0 });
  const app = createApp({
    payTo: "0x4444444444444444444444444444444444444444",
    payoutCodeReader: { getCode: async () => "0x" },
    referencePriceService: svc,
  });
  const get = () => app.fetch(new Request("http://localhost/reference-prices", { headers: { "x-forwarded-for": "8.8.4.4" } }));
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const j = (await res.json()) as any;
  assert.equal(j.ok, true);
  assert.equal(Object.keys(j.assets).length, rp.REFERENCE_SYMBOLS.length);
  assert.equal(res.headers.get("cache-control"), `public, max-age=${j.cache.remainingSec}`);
  await get();
  await get();
  assert.equal((await get()).status, 429, "比照既有免費端點的 per-IP 節流");

  const broken = createApp({
    payTo: "0x4444444444444444444444444444444444444444",
    payoutCodeReader: { getCode: async () => "0x" },
    referencePriceService: { get: async () => { throw new Error("boom https://rpc.example/SECRET"); } },
  });
  const r2 = await broken.fetch(new Request("http://localhost/reference-prices", { headers: { "x-forwarded-for": "8.8.8.8" } }));
  assert.equal(r2.status, 503);
  const j2 = (await r2.json()) as any;
  assert.equal(j2.ok, false);
  assert.ok(!JSON.stringify(j2).includes("SECRET"));
  ok("GET /reference-prices → 200（不需付款）、CORS *、Cache-Control、節流 429；服務失敗 503 不帶原文");
}

console.log(`\n✅ referencePrices.test.ts 全過（${n} 組）`);
