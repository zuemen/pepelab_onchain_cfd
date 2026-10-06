// 參考價多源見證（RWA 透明度看板 /oracle 用）：每檔資產的鏈下參考價與來源。
//
// 為什麼放在 signal-api：瀏覽器直接打 Yahoo／Nasdaq 會被 CORS 擋、CoinGecko 有頻率限制，
// 而前端的 CSP connect-src 本來就放行 signal-api。這支端點**免費、唯讀**，不接 x402。
//
// 來源怎麼選（照實，不美化）：
//   - 「keeper 主來源」與 agent/keeper/feeds.ts 的 SOURCES 完全相同（測試釘住）——
//     鏈上 MockOracle 的價格就是 keeper 從這裡抓來寫進去的。
//   - 加密：CoinGecko（keeper 主來源）＋ Yahoo BTC-USD／ETH-USD（keeper 的第二來源）
//     ＋ Coinbase 現貨（獨立的第三來源）。
//   - 美股與 ETF：Yahoo（keeper 主來源）＋ Nasdaq 公開報價 API（不需金鑰，獨立來源）。
//     Nasdaq 的 lastTradeTimestamp 只有日期或「日期＋時間 ET」的文字，原樣回傳，不猜秒數。
//   - 黃金：Yahoo GC=F（COMEX 近月**期貨**，keeper 主來源）＋ gold-api.com XAU **現貨**。
//     期貨與現貨之間有基差，第二來源只能當寬鬆的合理性檢查，回應裡用 note 標明。
// 任何一個來源失敗只讓那一格帶 error，不影響其他來源，絕不落回假數字或 0。
//
// 授權：Yahoo／CoinGecko／Nasdaq／Coinbase／gold-api.com 的商業使用條款均**未查證**
// （docs/COMPLIANCE_BOUNDARY.md §2），這裡只做測試網研究原型的合理性比對。


// ── 來源定義 ─────────────────────────────────────────────────────────────────

export type Provider = "coingecko" | "yahoo" | "coinbase" | "nasdaq" | "goldapi";
export type SourceRole = "keeper-primary" | "keeper-secondary" | "independent";
export type RefAssetClass = "crypto" | "equity" | "etf" | "future";

export interface RefSource {
  provider: Provider;
  /** 上游的代號（CoinGecko id、Yahoo ticker、Coinbase 交易對、Nasdaq 代號、XAU）。 */
  ticker: string;
  role: SourceRole;
  /** Nasdaq 的 assetclass 參數。 */
  nasdaqClass?: "stocks" | "etf";
}

export interface RefAssetDef {
  symbol: string;
  assetClass: RefAssetClass;
  sources: RefSource[];
  /** 給畫面的固定說明（例如期貨 vs 現貨）。 */
  note?: string;
}

const yahoo = (ticker: string, role: SourceRole = "keeper-primary"): RefSource => ({ provider: "yahoo", ticker, role });
const nasdaq = (ticker: string, nasdaqClass: "stocks" | "etf"): RefSource => ({
  provider: "nasdaq",
  ticker,
  role: "independent",
  nasdaqClass,
});

export const REFERENCE_ASSETS: Record<string, RefAssetDef> = {
  sBTC: {
    symbol: "sBTC",
    assetClass: "crypto",
    sources: [
      { provider: "coingecko", ticker: "bitcoin", role: "keeper-primary" },
      yahoo("BTC-USD", "keeper-secondary"),
      { provider: "coinbase", ticker: "BTC-USD", role: "independent" },
    ],
  },
  sETH: {
    symbol: "sETH",
    assetClass: "crypto",
    sources: [
      { provider: "coingecko", ticker: "ethereum", role: "keeper-primary" },
      yahoo("ETH-USD", "keeper-secondary"),
      { provider: "coinbase", ticker: "ETH-USD", role: "independent" },
    ],
  },
  sAAPL: { symbol: "sAAPL", assetClass: "equity", sources: [yahoo("AAPL"), nasdaq("AAPL", "stocks")] },
  sTSLA: { symbol: "sTSLA", assetClass: "equity", sources: [yahoo("TSLA"), nasdaq("TSLA", "stocks")] },
  sNVDA: { symbol: "sNVDA", assetClass: "equity", sources: [yahoo("NVDA"), nasdaq("NVDA", "stocks")] },
  sMSFT: { symbol: "sMSFT", assetClass: "equity", sources: [yahoo("MSFT"), nasdaq("MSFT", "stocks")] },
  sGOOGL: { symbol: "sGOOGL", assetClass: "equity", sources: [yahoo("GOOGL"), nasdaq("GOOGL", "stocks")] },
  sBOND: { symbol: "sBOND", assetClass: "etf", sources: [yahoo("BGRN"), nasdaq("BGRN", "etf")] },
  sICLN: { symbol: "sICLN", assetClass: "etf", sources: [yahoo("ICLN"), nasdaq("ICLN", "etf")] },
  sESGU: { symbol: "sESGU", assetClass: "etf", sources: [yahoo("ESGU"), nasdaq("ESGU", "etf")] },
  sGOLD: {
    symbol: "sGOLD",
    assetClass: "future",
    sources: [yahoo("GC=F"), { provider: "goldapi", ticker: "XAU", role: "independent" }],
    note: "keeper 讀 COMEX 近月期貨（GC=F）；第二來源是 XAU 現貨，兩者有基差，只作合理性檢查。",
  },
};

export const REFERENCE_SYMBOLS = Object.keys(REFERENCE_ASSETS);

// ── 回應型別 ─────────────────────────────────────────────────────────────────

export interface SourceQuote {
  provider: Provider;
  ticker: string;
  role: SourceRole;
  /** USD；拿不到就是 null（不是 0）。 */
  price: number | null;
  /** 上游自己標的報價時間（unix 秒）；上游沒有給就是 null。 */
  quoteTime: number | null;
  /** 上游只給文字時間（Nasdaq）時原樣放這裡。 */
  quoteTimeText?: string;
  /** 本服務向上游取值的時間（unix 秒）。與 quoteTime 是兩件事。 */
  fetchedAt: number;
  error?: string;
}

export interface AssetReference {
  symbol: string;
  assetClass: RefAssetClass;
  sources: SourceQuote[];
  /** 設定上就只有一個來源（目前沒有這種資產；保留欄位讓畫面照實標示）。 */
  singleSource: boolean;
  /** 這次實際拿到價格的來源數。 */
  okCount: number;
  /** 成功來源之間的最大價差（bps，相對於中位數）；少於兩個成功來源就是 null。 */
  spreadBps: number | null;
  note?: string;
}

export interface ReferencePricesReport {
  ok: boolean;
  /** 產生這份報表的時間（unix 秒）。 */
  generatedAt: number;
  assets: Record<string, AssetReference>;
  disclaimer: string;
}

// ── 純函式：萃取 ────────────────────────────────────────────────────────────

type Extracted = { price: number | null; quoteTime: number | null; quoteTimeText?: string; error?: string };

const positive = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function extractCoinGeckoQuote(json: unknown, id: string): Extracted {
  const entry = isObj(json) ? json[id] : undefined;
  if (!isObj(entry)) return { price: null, quoteTime: null, error: `no entry for ${id}` };
  const price = positive(entry.usd);
  const t = entry.last_updated_at;
  const quoteTime = typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
  return price === null ? { price, quoteTime, error: "invalid price" } : { price, quoteTime };
}

/** Yahoo chart：幣別必須是 USD（與 keeper 的 extractYahoo 同一條規則）。 */
export function extractYahooQuote(json: unknown): Extracted {
  const result = isObj(json) && isObj(json.chart) ? json.chart.result : undefined;
  const meta = Array.isArray(result) && isObj(result[0]) ? result[0].meta : undefined;
  if (!isObj(meta)) return { price: null, quoteTime: null, error: "no meta" };
  const currency = typeof meta.currency === "string" ? meta.currency.toUpperCase() : undefined;
  if (currency !== "USD") return { price: null, quoteTime: null, error: `currency ${currency ?? "missing"} is not USD` };
  const t = meta.regularMarketTime;
  const quoteTime = typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
  const price = positive(meta.regularMarketPrice);
  return price === null ? { price, quoteTime, error: "invalid price" } : { price, quoteTime };
}

export function extractCoinbaseQuote(json: unknown): Extracted {
  const data = isObj(json) ? json.data : undefined;
  if (!isObj(data)) return { price: null, quoteTime: null, error: "no data" };
  if (typeof data.currency === "string" && data.currency.toUpperCase() !== "USD") {
    return { price: null, quoteTime: null, error: `currency ${data.currency} is not USD` };
  }
  const price = positive(data.amount);
  // Coinbase 的 spot 端點不給報價時間——照實回 null，畫面顯示「來源未提供」。
  return price === null ? { price, quoteTime: null, error: "invalid price" } : { price, quoteTime: null };
}

export function extractNasdaqQuote(json: unknown): Extracted {
  const data = isObj(json) ? json.data : undefined;
  const primary = isObj(data) ? data.primaryData : undefined;
  if (!isObj(primary)) return { price: null, quoteTime: null, error: "no primaryData" };
  const price = positive(primary.lastSalePrice);
  const text = typeof primary.lastTradeTimestamp === "string" ? primary.lastTradeTimestamp.trim() : undefined;
  const base = { price, quoteTime: null, ...(text ? { quoteTimeText: text } : {}) };
  return price === null ? { ...base, error: "invalid price" } : base;
}

export function extractGoldApiQuote(json: unknown): Extracted {
  if (!isObj(json)) return { price: null, quoteTime: null, error: "non-object response" };
  if (typeof json.currency === "string" && json.currency.toUpperCase() !== "USD") {
    return { price: null, quoteTime: null, error: `currency ${json.currency} is not USD` };
  }
  const price = positive(json.price);
  const ms = typeof json.updatedAt === "string" ? Date.parse(json.updatedAt) : NaN;
  const quoteTime = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  return price === null ? { price, quoteTime, error: "invalid price" } : { price, quoteTime };
}

/** 成功來源之間的最大偏離（相對中位數，bps）。少於兩個值回 null。 */
export function spreadBps(prices: readonly number[]): number | null {
  const xs = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (xs.length < 2) return null;
  const mid = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const worst = Math.max(...xs.map((x) => Math.abs(x - mid)));
  return Math.round((worst / mid) * 10_000);
}

// ── 網路 ─────────────────────────────────────────────────────────────────────

export type JsonFetcher = (url: string, timeoutMs: number) => Promise<unknown>;

export const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * 上游用的 User-Agent。刻意與 candles.ts 的 UA 不同：2026-10-06 實測 Nasdaq 對帶
 * 「/1.0; +https://…」的 UA 不回應（連線掛到逾時），對這個較短的 UA 正常回 200。
 */
export const REF_UA = "Mozilla/5.0 (compatible; pepelab-signal-api)";

export async function fetchJsonDefault(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": REF_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

export function urlFor(src: RefSource): string {
  switch (src.provider) {
    case "coingecko":
      return `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(src.ticker)}&vs_currencies=usd&include_last_updated_at=true`;
    case "yahoo":
      return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(src.ticker)}?interval=1d&range=1d`;
    case "coinbase":
      return `https://api.coinbase.com/v2/prices/${encodeURIComponent(src.ticker)}/spot`;
    case "nasdaq":
      return `https://api.nasdaq.com/api/quote/${encodeURIComponent(src.ticker)}/info?assetclass=${src.nasdaqClass ?? "stocks"}`;
    case "goldapi":
      return `https://api.gold-api.com/price/${encodeURIComponent(src.ticker)}`;
  }
}

function extract(src: RefSource, json: unknown): Extracted {
  switch (src.provider) {
    case "coingecko":
      return extractCoinGeckoQuote(json, src.ticker);
    case "yahoo":
      return extractYahooQuote(json);
    case "coinbase":
      return extractCoinbaseQuote(json);
    case "nasdaq":
      return extractNasdaqQuote(json);
    case "goldapi":
      return extractGoldApiQuote(json);
  }
}

/** 錯誤只回短原因，不回上游原文（避免把 URL 參數或 header 帶出去）。 */
function shortError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  const m = /returned (\d{3})/.exec(msg);
  return m ? `http ${m[1]}` : "fetch failed";
}

export async function buildReferenceReport(
  fetchJson: JsonFetcher,
  opts: { now?: () => number; timeoutMs?: number; symbols?: readonly string[] } = {},
): Promise<ReferencePricesReport> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const symbols = opts.symbols ?? REFERENCE_SYMBOLS;

  // 同一個 URL 只打一次（例如 CoinGecko 未來若合併多個 id）。
  const pending = new Map<string, Promise<{ json?: unknown; error?: string }>>();
  const fetchOnce = (url: string) => {
    let p = pending.get(url);
    if (!p) {
      p = fetchJson(url, timeoutMs).then(
        (json) => ({ json }),
        (err) => ({ error: shortError(err) }),
      );
      pending.set(url, p);
    }
    return p;
  };

  const assets: Record<string, AssetReference> = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      const def = REFERENCE_ASSETS[symbol];
      if (!def) return;
      const sources = await Promise.all(
        def.sources.map(async (src): Promise<SourceQuote> => {
          const r = await fetchOnce(urlFor(src));
          const fetchedAt = now();
          const base = { provider: src.provider, ticker: src.ticker, role: src.role, fetchedAt };
          if (r.error !== undefined) return { ...base, price: null, quoteTime: null, error: r.error };
          const e = extract(src, r.json);
          return { ...base, ...e };
        }),
      );
      const okPrices = sources.map((s) => s.price).filter((p): p is number => p !== null);
      assets[symbol] = {
        symbol,
        assetClass: def.assetClass,
        sources,
        singleSource: def.sources.length < 2,
        okCount: okPrices.length,
        spreadBps: spreadBps(okPrices),
        ...(def.note ? { note: def.note } : {}),
      };
    }),
  );

  const ok = Object.values(assets).every((a) => a.okCount > 0);
  return {
    ok,
    generatedAt: now(),
    assets,
    disclaimer:
      "鏈下參考價僅供比對；鏈上 oracle 由 keeper 寫入 MockOracle。各上游的商業授權未查證。",
  };
}

// ── 快取（single-flight）─────────────────────────────────────────────────────

export function createReferencePriceService(
  fetchJson: JsonFetcher = fetchJsonDefault,
  opts: { ttlMs?: number; degradedTtlMs?: number; nowMs?: () => number; timeoutMs?: number } = {},
) {
  const ttl = opts.ttlMs ?? 60_000;
  const degradedTtl = opts.degradedTtlMs ?? 15_000;
  const nowMs = opts.nowMs ?? Date.now;
  let cached: { at: number; ttl: number; report: ReferencePricesReport } | null = null;
  let inflight: Promise<{ at: number; ttl: number; report: ReferencePricesReport }> | null = null;

  const view = (c: { at: number; ttl: number; report: ReferencePricesReport }, hit: boolean) => {
    const ageMs = Math.max(0, nowMs() - c.at);
    return {
      report: c.report,
      cacheHit: hit,
      ageSec: Math.floor(ageMs / 1000),
      ttlSec: Math.round(c.ttl / 1000),
      remainingSec: Math.max(0, Math.floor((c.ttl - ageMs) / 1000)),
    };
  };

  return {
    async get() {
      if (cached && nowMs() - cached.at < cached.ttl) return view(cached, true);
      if (!inflight) {
        inflight = buildReferenceReport(fetchJson, {
          now: () => Math.floor(nowMs() / 1000),
          timeoutMs: opts.timeoutMs,
        })
          .then((report) => {
            const degraded = Object.values(report.assets).some((a) => a.sources.some((s) => s.price === null));
            cached = { at: nowMs(), ttl: degraded ? degradedTtl : ttl, report };
            return cached;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return view(await inflight, false);
    },
  };
}
