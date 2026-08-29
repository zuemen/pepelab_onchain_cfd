// K 線（OHLCV）資料層：外部行情來源 → 統一格式 → 快取。
//
// 這是 demo 平台，鏈上沒有真實成交量可以聚合成 K 線，所以圖表資料一律取自
// 外部公開來源，並在回應裡「自報家門」——每一筆回應都帶 source metadata，
// 前端據此顯示出處徽章。設計上刻意讓「不知道這條線哪來的」變成不可能。
//
// 分級退場（ladder）：
//   加密貨幣 → Bybit 永續（首選：單次 1000 根、六個時間框全原生、與本平台同為永續）
//           → Coinbase 現貨（備援：需分頁且 4h 要自行聚合，參考標的也變成現貨）
//   股票/ETF/商品/債券 → Yahoo Finance（非官方端點，延遲報價）
//   全掛 → 模擬資料，標記 kind:"simulated" + degraded:true
//
// 尚未實作：鏈上 oracle 的 PriceUpdated 事件聚合。keeper 每 15 分鐘才寫一次，
// 1h K 線每根只有 4 個點、1m/5m 根本畫不出蠟燭，而 queryFilter 掃 block 在
// serverless 上是好幾秒的阻塞。當成自動 fallback 只會讓圖表又慢又醜，之後要做
// 應該做成使用者明確選擇的 source，不是靜默退場。adapter 介面已留好位置。

import {
  resolveMarket,
  assetIdFor,
  MARKET_SYMBOLS,
  type MarketMeta,
} from "./symbols.ts";

// ── 型別 ─────────────────────────────────────────────────────────────────────

/** 時間一律用「秒」：lightweight-charts 的 UTCTimestamp 就是秒。 */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type SourceKind = "exchange" | "delayed" | "simulated" | "none";

export interface SourceInfo {
  kind: SourceKind;
  /** 顯示在徽章上的來源名稱。 */
  name: string;
  /** 來源首頁，徽章可點。 */
  url: string;
  /** 完整的出處字串，前端可以直接印。 */
  attribution: string;
  /** 這是什麼價：現貨、延遲報價、模擬。 */
  reference: string;
  fetchedAt: number;
}

export interface CandleResponse {
  ok: true;
  symbol: string;
  assetId?: string;
  underlying: string;
  interval: Interval;
  candles: Candle[];
  source: SourceInfo;
  /** true = 沒拿到第一順位來源，已退到下一級（不一定是模擬）。 */
  degraded?: boolean;
  /**
   * true = 這個 end 之前已經沒有更早的資料了。前端據此停止往回翻頁，
   * 不然它會對著一個永遠回空陣列的端點無限重試。
   */
  exhausted?: boolean;
  /** 退場原因，讓線上問題可以直接從回應看出來，不必翻 log。 */
  sourceError?: string;
  disclaimer: string;
}

// ── 時間框 ───────────────────────────────────────────────────────────────────

export const INTERVALS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
} as const;

export type Interval = keyof typeof INTERVALS;

export const INTERVAL_KEYS = Object.keys(INTERVALS) as Interval[];

export function isInterval(v: string): v is Interval {
  return v in INTERVALS;
}

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 300;

// ── 聚合 ─────────────────────────────────────────────────────────────────────

/**
 * 把細粒度 K 線併成粗粒度。
 *
 * Coinbase 只提供 60/300/900/3600/21600/86400 六種 granularity，Yahoo 盤中最粗
 * 到 60m——兩邊都沒有 4h。交易員預期看得到 4h，所以用 1h 併四根補上。
 *
 * 分桶用 floor(t / seconds) * seconds，對齊 Unix epoch。14400 整除 86400，
 * 所以 4h 桶會落在 UTC 00:00 / 04:00 / 08:00…，跟其他交易所看到的一致。
 */
export function aggregate(candles: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  // 輸入必須是舊→新，桶內的 open / close 才會取對。
  for (const k of candles) {
    const bt = Math.floor(k.t / seconds) * seconds;
    const cur = buckets.get(bt);
    if (!cur) {
      buckets.set(bt, { t: bt, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    } else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/** 丟掉數值不合法的蠟燭。壞資料寧可少一根，也不要在圖上畫出假的價位。 */
function sane(k: Candle): boolean {
  return (
    Number.isFinite(k.t) &&
    Number.isFinite(k.o) &&
    Number.isFinite(k.h) &&
    Number.isFinite(k.l) &&
    Number.isFinite(k.c) &&
    k.o > 0 &&
    k.h > 0 &&
    k.l > 0 &&
    k.c > 0 &&
    k.h >= k.l
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const UA =
  "Mozilla/5.0 (compatible; pepelab-signal-api/1.0; +https://github.com/pepelab)";

export async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${new URL(url).host} returned ${res.status}`);
  }
  return res.json();
}

// ── Bybit（加密貨幣首選）─────────────────────────────────────────────────────

// Bybit 會用 HTTP 403 擋掉美國 IP，而 Vercel 的 function 預設跑在美東（iad1）——
// 部署上去之後這一級會直接失敗、每次都退到 Coinbase 現貨（回應裡看得到
// sourceError: "Bybit: api.bybit.com returned 403"）。vercel.json 因此把 regions 釘在
// sin1（新加坡）。那個設定看起來與行情無關，很容易在日後被當成多餘的東西刪掉，
// 所以把理由寫在這裡——真正依賴它的是這一行 host。
//
// 瀏覽器端直連 Bybit 的訂單簿不受影響，那是從使用者自己的 IP 出去的。
const BYBIT_HOST = "https://api.bybit.com";
/** Bybit 六個時間框全部原生支援，不需要聚合。 */
const BYBIT_INTERVAL: Record<Interval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};
/** 單次上限，比 Coinbase 的 300 寬鬆得多，實務上一次就夠。 */
const BYBIT_LIMIT = 1000;

/**
 * 抓 Bybit 永續 K 線。回傳舊→新。
 *
 * 相對 Coinbase 的三個好處：單次 1000 根（不必分頁）、六個時間框全原生（4h 不用
 * 自己併）、而且是永續而非現貨（跟我們的產品同類）。
 *
 * 兩個要小心的地方：
 *   1. HTTP 200 不代表成功。symbol 打錯照樣回 200，錯誤在 body 的 retCode。
 *   2. 數值全部是字串，時間是毫秒。
 */
async function fetchBybit(
  symbol: string,
  interval: Interval,
  need: number,
  end?: number,
): Promise<Candle[]> {
  const url =
    `${BYBIT_HOST}/v5/market/kline` +
    `?category=linear&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${BYBIT_INTERVAL[interval]}` +
    `&limit=${Math.min(need, BYBIT_LIMIT)}` +
    // Bybit 的 end 是毫秒，而且是「回傳早於它的」。沒有更早的資料時回空陣列
    // 且 retCode 仍是 0——那是正常的「到底了」，不是錯誤。
    (end ? `&end=${end * 1000}` : "");

  const json = (await getJson(url)) as {
    retCode?: number;
    retMsg?: string;
    result?: { list?: string[][] };
  };

  // retCode 0 才是成功；其餘情況 result.list 根本不存在。
  if (json.retCode !== 0) {
    throw new Error(`retCode ${json.retCode}: ${json.retMsg ?? "unknown error"}`);
  }
  const list = json.result?.list;
  // 往回翻頁時，空陣列代表「沒有更早的了」，是正常結果；只有查最新時空陣列才
  // 算異常（那代表這個交易對有問題）。丟錯會讓退場機制誤以為 Bybit 掛了。
  if (!list?.length) {
    if (end) return [];
    throw new Error("Response has no candle data");
  }

  const out: Candle[] = [];
  for (const row of list) {
    // [ startTime(ms), open, high, low, close, volume, turnover ]
    if (row.length < 6) continue;
    const k = {
      t: Math.floor(Number(row[0]) / 1000),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
    };
    if (sane(k)) out.push(k);
  }
  // 回應是新→舊。
  return out.sort((a, b) => a.t - b.t);
}

// ── Coinbase Exchange ────────────────────────────────────────────────────────

const COINBASE_HOST = "https://api.exchange.coinbase.com";
/** 官方支援的 granularity（秒）；其他值一律被拒。 */
const COINBASE_GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];
/** 單次請求上限。要更多資料只能分頁。 */
const COINBASE_PAGE = 300;

/**
 * 抓 Coinbase K 線。回傳舊→新。
 *
 * Coinbase 單次最多 300 根，且回的是新→舊。需要更多就用 start/end 分頁——
 * 時間窗事前就算得出來，所以全部平行發，不要串成瀑布。上限 5 頁（1500 根），
 * 免得一個 limit 參數就打爆對方的 rate limit。
 */
async function fetchCoinbase(
  product: string,
  granularity: number,
  need: number,
  endAt?: number,
): Promise<Candle[]> {
  const pages = Math.min(Math.ceil(need / COINBASE_PAGE), 5);
  // 沒給 endAt 就從現在往回抓；給了就從那個時間點往回，也就是往回翻頁。
  const anchor = endAt ?? Math.floor(Date.now() / 1000);
  const span = COINBASE_PAGE * granularity;

  const reqs = Array.from({ length: pages }, (_, i) => {
    const end = anchor - i * span;
    const start = end - span;
    const url =
      `${COINBASE_HOST}/products/${encodeURIComponent(product)}/candles` +
      `?granularity=${granularity}` +
      `&start=${new Date(start * 1000).toISOString()}` +
      `&end=${new Date(end * 1000).toISOString()}`;
    return getJson(url);
  });

  const pagesData = await Promise.all(reqs);
  const out: Candle[] = [];
  for (const raw of pagesData) {
    if (!Array.isArray(raw)) continue;
    for (const row of raw as unknown[]) {
      // [ time, low, high, open, close, volume ]
      if (!Array.isArray(row) || row.length < 6) continue;
      const [t, l, h, o, c, v] = row as number[];
      const k = { t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) };
      if (sane(k)) out.push(k);
    }
  }
  // 分頁之間可能重疊，去重後轉成舊→新。
  const byTime = new Map(out.map((k) => [k.t, k]));
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

// ── Yahoo Finance ────────────────────────────────────────────────────────────

const YAHOO_HOST = "https://query1.finance.yahoo.com";

/**
 * Yahoo 的 interval 與 range 有綁定上限：1m 只能回溯 7 天、5m/15m 是 60 天、
 * 60m 是 730 天。超過就整個請求回錯，所以要挑一個「夠用又不超限」的 range。
 */
const YAHOO_INTERVAL: Record<
  Interval,
  { interval: string; baseSeconds: number; maxSpan: number; intraday: boolean }
> = {
  "1m": { interval: "1m", baseSeconds: 60, maxSpan: 7 * 86400, intraday: true },
  "5m": { interval: "5m", baseSeconds: 300, maxSpan: 60 * 86400, intraday: true },
  "15m": { interval: "15m", baseSeconds: 900, maxSpan: 60 * 86400, intraday: true },
  "1h": { interval: "60m", baseSeconds: 3600, maxSpan: 730 * 86400, intraday: true },
  // 4h 由 60m 併出來：baseSeconds 是 3600 而不是 14400，吃的也是 60m 的上限。
  "4h": { interval: "60m", baseSeconds: 3600, maxSpan: 730 * 86400, intraday: true },
  "1d": { interval: "1d", baseSeconds: 86400, maxSpan: 10 * 365 * 86400, intraday: false },
};

/**
 * 交易時段補償係數。
 *
 * 「300 根 1h K 線」對加密貨幣就是 300 小時，因為它 24/7 交易。股票不是：一天
 * 只開 6.5 小時、一週只開 5 天，所以 300 根盤中 K 線對應的日曆時間大約是
 * (24/6.5) × (7/5) ≈ 5.2 倍。不補償就等於跟 Yahoo 要「300 小時的範圍」，
 * 拿回來只有六十幾根，圖表會短得莫名其妙。
 *
 * 日線用 7/5：一週只有五根。
 *
 * 寧可高估：range 超出上限會被 pickYahooRange 夾回來，多要的資料最後也會被
 * slice(-limit) 切掉；要少了就是直接少一截圖，那個沒有補救。
 */
const INTRADAY_FACTOR = 5.2;
const DAILY_FACTOR = 1.4;

const YAHOO_RANGES: { label: string; seconds: number }[] = [
  { label: "1d", seconds: 86400 },
  { label: "5d", seconds: 5 * 86400 },
  { label: "1mo", seconds: 30 * 86400 },
  { label: "3mo", seconds: 91 * 86400 },
  { label: "6mo", seconds: 182 * 86400 },
  { label: "1y", seconds: 365 * 86400 },
  { label: "2y", seconds: 730 * 86400 },
  { label: "5y", seconds: 5 * 365 * 86400 },
  { label: "10y", seconds: 10 * 365 * 86400 },
];

function pickYahooRange(needSeconds: number, maxSpan: number): string {
  const want = Math.min(needSeconds, maxSpan);
  for (const r of YAHOO_RANGES) {
    if (r.seconds >= want && r.seconds <= maxSpan) return r.label;
  }
  // 沒有更大的合法 range 就用上限內最大的那個。
  const legal = YAHOO_RANGES.filter((r) => r.seconds <= maxSpan);
  return legal.length ? legal[legal.length - 1].label : "1mo";
}

/**
 * 抓 Yahoo K 線。回傳舊→新。
 *
 * 兩個已知的坑（keeper 都踩過，見 .github/workflows/price-keeper.yml）：
 *   1. 沒帶瀏覽器 User-Agent 會回 401。
 *   2. 這是非官方端點，隨時可能改格式或關掉——所以呼叫端要有 fallback。
 * 第三個坑是這裡才有的：休市時段 quote 陣列裡是 null，不是缺項，
 * 直接 Number(null) 會變成 0，圖上就會出現一根跌到 0 的假蠟燭。
 */
async function fetchYahoo(
  ticker: string,
  interval: Interval,
  need: number,
  end?: number,
): Promise<Candle[]> {
  const cfg = YAHOO_INTERVAL[interval];
  // need 的單位是「cfg.interval 這個粒度的根數」，換算日曆時間必須乘 baseSeconds。
  // 乘目標粒度是錯的：4h 的 need 已經是 60m 的根數，再乘 14400 會多要四倍。
  const factor = cfg.intraday ? INTRADAY_FACTOR : DAILY_FACTOR;
  const span = Math.min(need * cfg.baseSeconds * factor, cfg.maxSpan);

  // Yahoo 沒有「從某個時間往回 N 根」的參數，只有 range（相對現在）與
  // period1/period2（絕對區間）。往回翻頁時只能用後者。
  const url = end
    ? `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=${cfg.interval}&period1=${Math.max(0, Math.floor(end - span))}&period2=${Math.floor(end)}`
    : `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=${cfg.interval}&range=${pickYahooRange(span, cfg.maxSpan)}`;

  type YahooChart = {
    chart?: {
      error?: { description?: string } | null;
      result?: {
        timestamp?: number[];
        indicators?: {
          quote?: {
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }[];
        };
      }[];
    };
  };

  let json: YahooChart;
  try {
    json = (await getJson(url)) as YahooChart;
  } catch (err) {
    // Yahoo 對超出保留期的盤中資料回 422（1m 只留約 7 天）。往回翻頁翻到那條線
    // 就是「沒有更早的了」，回空陣列讓呼叫端標成 exhausted；當成錯誤丟出去會讓
    // 分級退場誤判 Yahoo 掛掉而跳去模擬資料。
    if (end && /\b422\b/.test((err as Error).message)) return [];
    throw err;
  }

  if (json.chart?.error) {
    throw new Error(json.chart.error.description ?? "Yahoo reported an error");
  }
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  // 休市時段的區間會回 200 但沒有 timestamp——同樣是「這段沒有資料」而非失敗。
  if (!ts?.length || !q) {
    if (end) return [];
    throw new Error("Yahoo response has no candle data");
  }

  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    // null = 該時段沒有成交（休市 / 停牌）。跳過，讓圖上留成缺口。
    if (o == null || h == null || l == null || c == null) continue;
    const k = { t: Number(ts[i]), o, h, l, c, v: Number(q.volume?.[i] ?? 0) };
    if (sane(k)) out.push(k);
  }
  return out.sort((a, b) => a.t - b.t);
}

// ── 模擬（保底） ─────────────────────────────────────────────────────────────

/** 32-bit 整數雜湊，給 PRNG 當種子用。 */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 保底價格曲線：只由 (symbol, 絕對時間) 決定的封閉式函式。
 *
 * 這裡刻意不用「前一根推下一根」的隨機漫步或 OU 遞迴。那種寫法的值取決於迭代
 * 從哪一根開始，而視窗每次輪詢都會往前滑一格——結果就是每次刷新整段歷史的價格
 * 全部變一次，圖表看起來像壞掉。實測（limit 100 vs 101）重疊區 100 根沒有一根
 * 對得上，就是這個原因。
 *
 * 改成幾個不同週期的正弦波疊加：給定 t 算出來永遠是同一個值，跟視窗大小、從哪
 * 根開始迭代都無關，而且天然錨在 seed 附近不會漂移。週期用絕對時間（月/週/日/
 * 4 小時）而非「幾根」，所以切換時間框看到的是同一條曲線的不同解析度，符合直覺。
 */
function simPrice(meta: MarketMeta, t: number): number {
  const waves: [number, number][] = [
    [30 * 86400, 0.06],
    [7 * 86400, 0.03],
    [86400, 0.015],
    [4 * 3600, 0.008],
  ];
  let x = 0;
  for (let k = 0; k < waves.length; k += 1) {
    const [period, amp] = waves[k];
    // 相位由 symbol 決定，讓每個標的的曲線長得不一樣。
    const phase = mulberry32(hash32(`${meta.symbol}:w${k}`))() * Math.PI * 2;
    x += amp * Math.sin((2 * Math.PI * t) / period + phase);
  }
  return meta.seed * Math.exp(x);
}

/**
 * 所有外部來源都掛掉時的保底資料。只是為了讓圖不要開天窗，不是要模擬市場微結構。
 *
 * open 取該根起點的價、close 取下一根起點的價，所以相鄰蠟燭首尾相接，不會出現
 * 真實行情不會有的鋸齒。
 */
function simulate(
  meta: MarketMeta,
  interval: Interval,
  need: number,
  end?: number,
): Candle[] {
  const step = INTERVALS[interval];
  // 往回翻頁時以 end 為錨點。simPrice 是 (symbol, t) 的純函式，所以同一根蠟燭
  // 無論從哪個窗口算出來都一樣，翻頁接縫不會對不上。
  const anchor = end ?? Math.floor(Date.now() / 1000);
  const lastBucket = Math.floor(anchor / step) * step;
  const out: Candle[] = [];

  for (let i = need - 1; i >= 0; i -= 1) {
    const t = lastBucket - i * step;
    const rnd = mulberry32(hash32(`${meta.symbol}:${t}`));
    const o = simPrice(meta, t);
    const c = simPrice(meta, t + step);
    // 影線長度也要決定性：同一根 K 線任何時候畫出來都一樣。
    const h = Math.max(o, c) * (1 + rnd() * 0.0018);
    const l = Math.min(o, c) * (1 - rnd() * 0.0018);
    out.push({ t, o, h, l, c, v: Math.round(rnd() * 1000) });
  }
  return out;
}

// ── 快取 ─────────────────────────────────────────────────────────────────────

// serverless 上這個 Map 只在同一個暖實例內有效，冷啟就空了——這正是它存在的
// 理由之一：一個暖實例服務多個瀏覽器分頁時，不該每次都去打 Coinbase。
// 大小天然有界（資產數 × 時間框 = 66 筆），不需要淘汰邏輯。
const cache = new Map<string, { at: number; payload: CandleResponse }>();

/** TTL 跟著時間框走：1m 線每分鐘就變，1d 線五分鐘內重複抓沒有意義。 */
/**
 * 快取存活時間。
 *
 * 設定原則：大約是前端輪詢間隔的一半（見 useCandles 的 POLL_MS）。比輪詢長的話
 * 每次輪詢都可能打到還沒過期的舊快取，等於白輪詢；比一半再短則只是多打上游，
 * 使用者感受不到差別。
 *
 * 注意這裡影響的是「當前那根還沒收盤的蠟燭」有多新——已收盤的歷史蠟燭不會再變，
 * 快取久一點也無所謂。
 */
const TTL_MS: Record<Interval, number> = {
  "1m": 3_000,
  "5m": 5_000,
  "15m": 10_000,
  "1h": 15_000,
  "4h": 30_000,
  "1d": 60_000,
};

/**
 * 帶 end 的查詢（往回翻頁）用的快取時間。
 *
 * 那些區間全部已經收盤，內容永遠不會再變，所以可以放很久。使用者來回捲動時會
 * 一直命中同一批 key，這個值直接決定「往回捲第二次還順不順」。
 */
const HISTORY_TTL_MS = 10 * 60_000;

// ── 對外 ─────────────────────────────────────────────────────────────────────

const DISCLAIMER =
  "Demo data. The chart shows reference pricing from external public sources, not this platform's own trade records; " +
  "opening, closing, and liquidation always settle at the on-chain oracle index price.";

export class UnknownMarketError extends Error {}
export class BadIntervalError extends Error {}

/**
 * 取得 K 線。
 *
 * @param rawSymbol sBTC / btc / bytes32 assetId 都收
 * @param rawInterval 1m 5m 15m 1h 4h 1d
 * @param rawLimit 蠟燭根數，上限 MAX_LIMIT
 * @param rawEnd 只回傳早於這個 unix 秒數的蠟燭。給了就是「往回翻頁」，前端圖表
 *   捲到最左邊時帶上目前最舊那根的時間，就能接續拿到更早的歷史。省略 = 最新。
 */
export async function getCandles(
  rawSymbol: string,
  rawInterval = "1h",
  rawLimit?: string | number,
  rawEnd?: string | number,
): Promise<CandleResponse> {
  const meta = resolveMarket(rawSymbol);
  if (!meta) {
    throw new UnknownMarketError(
      `未知標的 "${rawSymbol}"，可用：${MARKET_SYMBOLS.join(", ")}`,
    );
  }
  if (!isInterval(rawInterval)) {
    throw new BadIntervalError(
      `未知時間框 "${rawInterval}"，可用：${INTERVAL_KEYS.join(", ")}`,
    );
  }
  const interval = rawInterval;

  // 下限是 1 而不是某個「圖表至少要幾根才好看」的值：前端輪詢時只會要最後一兩根
  // 來更新當前蠟燭，硬把它撐到 10 只是白抓資料。上限才是真正要防的。
  const parsed = Number(rawLimit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(parsed)
    ? Math.max(1, Math.min(Math.floor(parsed), MAX_LIMIT))
    : DEFAULT_LIMIT;

  // end 只接受正的 unix 秒數。0 / 負數 / 非數字一律當成「沒給」，不要讓一個
  // 打錯的參數靜默地變成「查詢 1970 年」然後回一片空白。
  const parsedEnd = Number(rawEnd);
  const end =
    rawEnd !== undefined && Number.isFinite(parsedEnd) && parsedEnd > 0
      ? Math.floor(parsedEnd)
      : undefined;

  const key = `${meta.symbol}:${interval}:${limit}:${end ?? "now"}`;
  const hit = cache.get(key);
  // 已經收盤的歷史區間不會再變，快取久一點；只有「最新」那一段需要頻繁失效。
  const ttl = end === undefined ? TTL_MS[interval] : HISTORY_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) {
    return hit.payload;
  }

  const seconds = INTERVALS[interval];
  const now = Math.floor(Date.now() / 1000);
  let candles: Candle[] = [];
  let source: SourceInfo | null = null;
  let sourceError: string | undefined;

  // ── 第一級：加密貨幣走 Coinbase 現貨 ──
  //
  // 首選是**現貨**，不是永續。這裡原本相反，理由是「我們賣的就是永續，拿別人
  // 的永續當參考比較誠實」——那個理由在平台把門面改成代幣化 RWA 現貨、下單面板
  // 預設關掉槓桿之後就不成立了：圖表下方掛著「Bybit perpetual contract」的出處，
  // 會跟畫面上其他每一句話打架。Bybit 沒有被刪掉，退居 fallback。
  if (!source && meta.coinbase) {
    try {
      const native = COINBASE_GRANULARITIES.includes(seconds);
      // 4h 沒有原生 granularity，用 1h 抓四倍的量再併。
      const base = native ? seconds : 3600;
      const need = native ? limit : limit * (seconds / base);
      const raw = await fetchCoinbase(meta.coinbase, base, need, end);
      const merged = native ? raw : aggregate(raw, seconds);
      if (merged.length) {
        candles = merged;
        source = {
          kind: "exchange",
          name: "Coinbase Exchange",
          url: `https://exchange.coinbase.com/trade/${meta.coinbase}`,
          attribution: `Coinbase Exchange · ${meta.coinbase} spot`,
          reference: "spot",
          fetchedAt: now,
        };
      } else {
        sourceError = "Coinbase returned no usable candles";
      }
    } catch (err) {
      sourceError = `Coinbase: ${(err as Error).message}`;
    }
  }

  // ── 第二級：Coinbase 拿不到時退到 Bybit 永續 ──
  //
  // 參考標的從現貨變成永續，會有基差；下面的 degraded 旗標正是要讓前端知道
  // 「這不是第一順位來源」。
  //
  // `!source` 這個條件是必要的，不是多餘的防禦：這塊以前排在第一順位所以不需要
  // 守衛，換順序後少了它，Bybit 會直接覆寫剛剛抓到的 Coinbase 結果。
  if (!source && meta.bybit) {
    try {
      const raw = await fetchBybit(meta.bybit, interval, limit, end);
      if (raw.length) {
        candles = raw;
        source = {
          kind: "exchange",
          name: "Bybit",
          url: `https://www.bybit.com/trade/usdt/${meta.bybit}`,
          attribution: `Bybit · ${meta.bybit} perpetual contract`,
          reference: "perpetual",
          fetchedAt: now,
        };
      } else {
        sourceError = "Bybit returned no usable candles";
      }
    } catch (err) {
      sourceError = `Bybit: ${(err as Error).message}`;
    }
  }

  // ── 第三級：其餘標的走 Yahoo ──
  if (!source && meta.yahoo) {
    try {
      const native = interval !== "4h";
      const need = native ? limit : limit * 4;
      const raw = await fetchYahoo(meta.yahoo, interval, need, end);
      const merged = native ? raw : aggregate(raw, seconds);
      if (merged.length) {
        candles = merged;
        source = {
          kind: "delayed",
          name: "Yahoo Finance",
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(meta.yahoo)}`,
          attribution: `Yahoo Finance · ${meta.underlying} (unofficial endpoint, quotes may be delayed)`,
          reference: "delayed quote",
          fetchedAt: now,
        };
      } else {
        sourceError = "Yahoo returned no usable candles";
      }
    } catch (err) {
      sourceError = `Yahoo: ${(err as Error).message}`;
    }
  }

  // ── 保底：模擬 ──
  // degraded 的定義是「沒拿到第一順位的來源」，不是「只剩模擬」。Coinbase 掛掉退到
  // Bybit 時 kind 一樣是 exchange，但參考標的從現貨變成永續、價格會有基差，
  // 那也該讓前端知道。sourceError 只在某一級失敗時才會被設，正好等價。
  let degraded = sourceError !== undefined;
  let exhausted = false;

  if (!source) {
    if (end !== undefined) {
      // 往回翻頁翻到沒有資料，是正常的終點，不是故障——**絕對不能**在這裡生成
      // 模擬蠟燭。上游的歷史保留期本來就有限（Bybit 1m、Yahoo 盤中都只留幾天），
      // 捲到那條線之後憑空畫出「2015 年的行情」比留白糟糕得多：使用者沒有辦法
      // 分辨那是真的還是編的。回空陣列，讓前端停在最後一根真實資料。
      exhausted = true;
      candles = [];
      source = {
        kind: "none",
        name: "No earlier data",
        url: "",
        attribution: "Reached this source's historical retention limit",
        reference: "none",
        fetchedAt: now,
      };
    } else {
      degraded = true;
      candles = simulate(meta, interval, limit, end);
      source = {
        kind: "simulated",
        name: "Simulated data",
        url: "",
        attribution: "SIMULATED — external market data unavailable; this chart is programmatically generated, not a real market price",
        reference: "simulated",
        fetchedAt: now,
      };
    }
  }

  // end 對外一律是「嚴格早於」。上游各家不一致——Bybit 的 end 與 Yahoo 的
  // period2 都是包含式的，直接透出去會讓交界那根蠟燭在相鄰兩頁重複出現。把差異
  // 收在這裡，前端就不必知道每個來源的邊界規則。
  const windowed = end === undefined ? candles : candles.filter((k) => k.t < end);

  const payload: CandleResponse = {
    ok: true,
    symbol: meta.symbol,
    assetId: assetIdFor(meta.symbol),
    underlying: meta.underlying,
    interval,
    candles: windowed.slice(-limit),
    source,
    ...(degraded ? { degraded } : {}),
    // 上游有回東西、但整批都不早於 end（例如只回了那根包含式的邊界蠟燭），
    // 過濾後就空了——對呼叫端而言同樣是「沒有更早的了」。
    ...(exhausted || (end !== undefined && windowed.length === 0)
      ? { exhausted: true }
      : {}),
    ...(sourceError ? { sourceError } : {}),
    disclaimer: DISCLAIMER,
  };

  cache.set(key, { at: Date.now(), payload });
  return payload;
}
