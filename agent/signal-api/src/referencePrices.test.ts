// GET /reference-prices 測試：假上游（JsonFetcher），不打網路、不送交易。
//   cd agent && npx tsx signal-api/src/referencePrices.test.ts
import assert from "node:assert";

process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.FREE_RATE_MAX = "3";
process.env.FREE_RATE_WINDOW_MS = "60000";
process.env.CORS_ALLOWED_ORIGINS = "https://front.example";

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
      const ids = new URL(url).searchParams.get("ids")!.split(",");
      return Object.fromEntries(ids.map((id) => [id, { usd: id === "bitcoin" ? 85_491 : 2_700, last_updated_at: T - 20 }]));
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
  const report = await rp.buildReferenceReport(
    rp.directFetcher(fakeFetcher({ "api.coinbase.com": timeout, "api.nasdaq.com": http })),
    { now: () => T },
  );
  const btc = report.assets.sBTC;
  assert.equal(btc.okCount, 2);
  const cb = btc.sources.find((s) => s.provider === "coinbase")!;
  assert.equal(cb.price, null);
  assert.equal(cb.error, "timeout");
  assert.equal(btc.spreadBps, rp.spreadBps([85_491, 85_500]));
  assert.equal(report.assets.sETH.sources[0].price, 2_700, "合併請求後每個 id 仍各自萃取");
  const aapl = report.assets.sAAPL;
  assert.equal(aapl.okCount, 1);
  assert.equal(aapl.spreadBps, null, "只剩一個成功來源時不給價差");
  const nq = aapl.sources.find((s) => s.provider === "nasdaq")!;
  assert.equal(nq.error, "http 403");
  assert.ok(!JSON.stringify(report).includes("secret.example"), "不回上游錯誤原文");
  assert.equal(aapl.sources[0].quoteTime, T - 3600);
  assert.equal(aapl.sources[0].fetchedAt, T);
  assert.equal(report.ok, true, "每檔至少有一個來源成功");
  assert.match(report.disclaimer, /不保存歷史/);
  const all = await rp.buildReferenceReport(
    rp.directFetcher(fakeFetcher({ "query1.finance.yahoo.com": http, "api.nasdaq.com": http })),
    { now: () => T },
  );
  assert.equal(all.assets.sAAPL.okCount, 0);
  assert.equal(all.ok, false);
  ok("單一上游失敗隔離、錯誤只回短原因、報價時間與取值時間分開");
}

// 6) CoinGecko 合併為一次請求；每個 URL 在一份報表內只打一次
{
  assert.deepEqual(rp.COINGECKO_IDS, ["bitcoin", "ethereum"]);
  const calls: string[] = [];
  await rp.buildReferenceReport(rp.directFetcher(fakeFetcher({}, calls)), { now: () => T });
  assert.equal(calls.filter((u) => u.includes("coingecko")).length, 1, "CoinGecko 只打一次");
  assert.equal(new Set(calls).size, calls.length, "沒有重複 URL");
  assert.equal(calls.length, rp.upstreamUrls().length);
  ok("CoinGecko 多個 id 合併為一次請求；每個上游 URL 只打一次");
}

// 7) 快取：每個來源各自快取（成功 60 秒、失敗 15 秒）；一個來源失敗不讓其他來源重抓
{
  let clock = 0;
  const calls: string[] = [];
  const svc = rp.createReferencePriceService(fakeFetcher({ "api.gold-api.com": new Error("x returned 500") }, calls), {
    nowMs: () => clock,
  });
  const [a, b] = await Promise.all([svc.get(), svc.get()]);
  assert.equal(a.cacheHit, false);
  assert.equal(b.report.assets.sGOLD.sources[1].error, "http 500");
  const first = calls.length;
  assert.equal(first, rp.upstreamUrls().length, "single-flight：並發兩次只打一輪");
  assert.equal(a.remainingSec, 15, "最先過期的是失敗的那個來源");

  clock = 16_000; // 失敗來源過期，其他來源仍在 60 秒內
  const c = await svc.get();
  const refetched = calls.slice(first);
  assert.deepEqual(refetched, ["https://api.gold-api.com/price/XAU"], "只有失敗的來源被重抓");
  assert.equal(c.cacheHit, false);
  assert.equal(c.report.assets.sAAPL.sources[0].price, 332.89, "其他來源沿用快取");

  clock = 20_000;
  assert.equal((await svc.get()).cacheHit, true);
  clock = 40_000; // 失敗來源（16 秒時重抓、又失敗）再次過期；成功來源仍在 60 秒內
  let before = calls.length;
  await svc.get();
  assert.deepEqual(calls.slice(before), ["https://api.gold-api.com/price/XAU"], "成功的來源 60 秒內都不重抓");
  clock = 61_000;
  before = calls.length;
  await svc.get();
  assert.ok(calls.slice(before).includes("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d"), "成功的來源 60 秒後重抓");
  ok("每個來源各自快取：成功 60 秒、失敗 15 秒；單一來源失敗時其他來源不重抓");
}

// 8) Cache-Control：CDN 共用（s-maxage）＋ stale-while-revalidate
{
  assert.equal(rp.referencePricesCacheControl(60), "public, max-age=60, s-maxage=60, stale-while-revalidate=120");
  assert.equal(rp.referencePricesCacheControl(9), "public, max-age=9, s-maxage=9, stale-while-revalidate=120");
  assert.equal(rp.referencePricesCacheControl(-3), "public, max-age=0, s-maxage=0, stale-while-revalidate=120");
  ok("Cache-Control 帶 s-maxage 與 stale-while-revalidate");
}

// 9) 路由：免費（不經 x402）、CORS 只放行前端網域、外來 Origin 403、per-IP 節流
{
  const svc = rp.createReferencePriceService(fakeFetcher(), { nowMs: () => 0 });
  const app = createApp({
    payTo: "0x4444444444444444444444444444444444444444",
    payoutCodeReader: { getCode: async () => "0x" },
    referencePriceService: svc,
  });
  const get = (headers: Record<string, string> = {}) =>
    app.fetch(new Request("http://localhost/reference-prices", { headers: { "x-forwarded-for": "8.8.4.4", ...headers } }));
  const res = await get({ origin: "https://front.example" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://front.example", "前端網域可讀");
  const j = (await res.json()) as any;
  assert.equal(j.ok, true);
  assert.equal(Object.keys(j.assets).length, rp.REFERENCE_SYMBOLS.length);
  assert.equal(res.headers.get("cache-control"), rp.referencePricesCacheControl(j.cache.remainingSec));
  const foreign = await get({ origin: "https://evil.example" });
  assert.equal(foreign.status, 403, "其他網站的頁面不能拿來當行情來源");
  assert.notEqual(foreign.headers.get("access-control-allow-origin"), "*");
  const noOrigin = await get();
  assert.equal(noOrigin.status, 200, "沒有 Origin（curl／agent）照常可用");
  assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  // 外來 Origin 在節流之前就被 403 擋下，不佔額度：到這裡用了 2 次，第 3 次放行、第 4 次 429。
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429, "比照既有免費端點的 per-IP 節流");
  // 其他免費端點的 CORS 維持 *。
  const health = await app.fetch(new Request("http://localhost/healthz", { headers: { origin: "https://evil.example" } }));
  assert.equal(health.headers.get("access-control-allow-origin"), "*");

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
  ok("GET /reference-prices → 200（不需付款）、CORS 只放行前端網域、外來 Origin 403、Cache-Control、節流 429；失敗 503 不帶原文");
}

console.log(`
✅ referencePrices.test.ts 全過（${n} 組）`);
