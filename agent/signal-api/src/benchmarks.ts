// 對照指數（Benchmark）資料層：S&P 500 / 黃金 / 比特幣，供 Portfolio 頁
// 「你 vs 大盤」與常駐指數列使用（frontend CONTEXT.md 的 Benchmark 詞條）。
//
// 三個指數刻意走同一個上游（Yahoo Finance），不分流：「即時取自 A、歷史取自
// B」會讓同一個指數在畫面上出現兩種數字。黃金用 GC=F（COMEX 期貨連續合約），
// 跟 symbols.ts 裡 sGOLD 的來源一致——兩邊都用同一個 ticker，鏈上 oracle 價與
// 這裡的對照價才不會系統性差一個基差。
//
// 跟 candles.ts 最重要的差異：這裡**不做模擬保底**。K 線是給圖表看熱鬧，缺一段
// 用模擬資料補上不影響交易；但「你 vs 大盤」是一個明確的數字宣稱（打贏/輸給
// 大盤幾趴），編造的數字會讓這個宣稱本身變成謊言。上游拿不到就回明確的錯誤，
// 由呼叫端（/portfolio 的指數列／比較區塊）決定要不要顯示「資料暫不可用」，
// 絕不落到 0 或任何看起來像真數字的東西。

import { getJson } from "./candles.ts";

// ── 指數定義 ─────────────────────────────────────────────────────────────────

export type BenchmarkKey = "spx" | "gold" | "btc";

interface BenchmarkDef {
  key: BenchmarkKey;
  name: string;
  /** Yahoo Finance ticker。 */
  yahoo: string;
}

export const BENCHMARKS: Record<BenchmarkKey, BenchmarkDef> = {
  spx: { key: "spx", name: "S&P 500", yahoo: "^GSPC" },
  // GC=F，不是 XAUUSD=X：後者在 Yahoo 的 chart API 回 404（symbol may be
  // delisted），且 symbols.ts 的 sGOLD 本來就是用 GC=F，理由同上。
  gold: { key: "gold", name: "Gold", yahoo: "GC=F" },
  btc: { key: "btc", name: "Bitcoin", yahoo: "BTC-USD" },
};

export const BENCHMARK_KEYS = Object.keys(BENCHMARKS) as BenchmarkKey[];

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface BenchmarkPoint {
  value: number;
  /** unix 秒，這個收盤價實際的時間戳（不是查詢時間）。 */
  at: number;
}

export interface AtDatePoint extends BenchmarkPoint {
  /**
   * 實際命中的交易日（YYYY-MM-DD），可能早於請求的 date——請求的日期若是
   * 週末或假日，這裡會是往前最近一個有收盤價的交易日。
   */
  date: string;
}

export interface BenchmarkResult {
  /** false 代表 current／atDate 至少一項失敗；成功的欄位仍會照樣給。 */
  ok: boolean;
  key: BenchmarkKey;
  name: string;
  symbol: string;
  current?: BenchmarkPoint;
  atDate?: AtDatePoint;
  error?: string;
}

export interface BenchmarksResponse {
  ok: true;
  asOf: number;
  requestedDate: string | null;
  benchmarks: Record<BenchmarkKey, BenchmarkResult>;
}

// ── date 參數 ────────────────────────────────────────────────────────────────

export class BadDateError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * y/m/d 是否為存在的日曆日。
 *
 * `Date.parse` 對 ISO 字串的月份會嚴格拒絕（"2026-13-01" → NaN），但日期溢位
 * 會被靜默捲進下個月（"2026-02-30" 被解成 3 月 2 日，不是 NaN）——實測過，
 * 不是臆測。用 UTC 建構再讀回來比對是否還原，溢位就會在讀回來的欄位對不上。
 */
function isValidCalendarDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** YYYY-MM-DD → 該日 00:00:00 UTC 的 unix 秒數。呼叫前須先過 isValidCalendarDate。 */
export function dateToUnixSec(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

/**
 * 驗證並正規化 `date` query 參數。只接受 YYYY-MM-DD，格式不對或日期不存在
 * 一律丟錯——不要把打錯的參數靜默吃掉變成「沒給」，那會讓呼叫端誤以為拿到的
 * 是某天的收盤價，實際上悄悄變成了「現在」。
 */
export function parseDateParam(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const trimmed = raw.trim();
  const m = DATE_RE.exec(trimmed);
  if (!m) {
    throw new BadDateError(`date 參數格式錯誤："${raw}"，需為 YYYY-MM-DD`);
  }
  const [, yStr, moStr, dStr] = m;
  if (!isValidCalendarDate(Number(yStr), Number(moStr), Number(dStr))) {
    throw new BadDateError(`date 參數不是合法日期："${raw}"`);
  }
  const sec = dateToUnixSec(trimmed);
  if (sec > Math.floor(Date.now() / 1000)) {
    throw new BadDateError(`date 參數不可為未來日期："${raw}"`);
  }
  return trimmed;
}

// ── 收盤點選取 ───────────────────────────────────────────────────────────────

interface ClosePoint {
  t: number;
  c: number;
}

/**
 * 在一串收盤點裡，找出「日期不晚於 targetDateSec 所在日期」的最後一筆。
 *
 * 用日期（UTC，floor(t/86400)）而不是秒數比較：targetDateSec 一律是當天
 * 00:00:00 UTC，而蠟燭的收盤時間戳落在交易日當天稍晚——直接比秒數會讓「當天
 * 自己」的那根被誤判成晚於 target。
 */
export function pickCloseAtOrBefore(points: ClosePoint[], targetDateSec: number): ClosePoint | undefined {
  const targetDay = Math.floor(targetDateSec / 86400);
  let best: ClosePoint | undefined;
  for (const p of points) {
    const day = Math.floor(p.t / 86400);
    if (day <= targetDay && (!best || p.t > best.t)) best = p;
  }
  return best;
}

// ── Yahoo Finance ────────────────────────────────────────────────────────────

const YAHOO_HOST = "https://query1.finance.yahoo.com";

interface YahooChart {
  chart?: {
    error?: { description?: string } | null;
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

async function fetchYahooCloses(ticker: string, params: string): Promise<ClosePoint[]> {
  const url = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`;
  const json = (await getJson(url)) as YahooChart;
  if (json.chart?.error) {
    throw new Error(json.chart.error.description ?? "Yahoo reported an error");
  }
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const close = result?.indicators?.quote?.[0]?.close;
  if (!ts?.length || !close) {
    throw new Error("Yahoo response has no data for this range");
  }
  const out: ClosePoint[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const c = close[i];
    // null = 休市/停牌的時段，跳過——不要讓 Number(null) 變成 0 混進收盤序列。
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    out.push({ t: Number(ts[i]), c });
  }
  if (!out.length) throw new Error("Yahoo response has no usable close prices");
  return out.sort((a, b) => a.t - b.t);
}

async function fetchCurrent(ticker: string): Promise<BenchmarkPoint> {
  // range=5d 而非 1d：週末／假日時 1d 常常整段沒資料。5d 保證跨過至少一個
  // 交易日，最後仍只取最新一筆，不影響「當前值」的意義。
  const points = await fetchYahooCloses(ticker, "interval=1d&range=5d");
  const last = points[points.length - 1];
  return { value: last.c, at: last.t };
}

async function fetchAtDate(ticker: string, date: string): Promise<AtDatePoint> {
  const targetSec = dateToUnixSec(date);
  // 往前多抓 10 天涵蓋連假／長週末；往後抓 1 天是為了把當天本身納進視窗
  // （上游對 period2 邊界是否含當天不保證，寧可抓寬一點也不要漏掉當天）。
  const period1 = targetSec - 10 * 86400;
  const period2 = targetSec + 86400;
  const points = await fetchYahooCloses(ticker, `interval=1d&period1=${period1}&period2=${period2}`);
  const hit = pickCloseAtOrBefore(points, targetSec);
  if (!hit) {
    throw new Error(`no close on or before ${date} within the lookback window`);
  }
  return { value: hit.c, at: hit.t, date: new Date(hit.t * 1000).toISOString().slice(0, 10) };
}

// ── 快取 ─────────────────────────────────────────────────────────────────────
//
// serverless 上這個 Map 只在同一個暖實例內有效，冷啟就空了；跟 candles.ts
// 的快取同一個理由存在——一個暖實例服務多個瀏覽器分頁時，不該每次都去打
// Yahoo（免費端點沒有 CORS，第一次實測就吃過一次 429，見 issue #62）。

const CURRENT_TTL_MS = 5 * 60_000; // 對照用途，不必秒級新鮮
const HISTORY_TTL_MS = 24 * 3600_000; // 已收盤的歷史值不會再變，快取久一點

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ── 對外 ─────────────────────────────────────────────────────────────────────

/**
 * 取得三個對照指數的當前值，以及（給了 date 時）指定日期或之前最近一個
 * 交易日的收盤值。
 *
 * 三個指數各自獨立成功/失敗：一個上游掛掉不連累另外兩個，也不連累同一個
 * 指數裡已經拿到的 current／atDate 其中一項。任何一項失敗都不落回假數字，
 * 只在該欄位標 error，由呼叫端決定怎麼呈現。
 *
 * @throws {BadDateError} rawDate 給了但格式不對或不是合法日期或是未來日期。
 */
export async function getBenchmarks(rawDate?: string): Promise<BenchmarksResponse> {
  const date = parseDateParam(rawDate);

  const entries = await Promise.all(
    BENCHMARK_KEYS.map(async (key): Promise<[BenchmarkKey, BenchmarkResult]> => {
      const def = BENCHMARKS[key];
      const result: BenchmarkResult = { ok: true, key, name: def.name, symbol: def.yahoo };
      const errors: string[] = [];

      const [currentR, atDateR] = await Promise.allSettled([
        cached(`${key}:current`, CURRENT_TTL_MS, () => fetchCurrent(def.yahoo)),
        date
          ? cached(`${key}:atDate:${date}`, HISTORY_TTL_MS, () => fetchAtDate(def.yahoo, date))
          : Promise.resolve(undefined),
      ]);

      if (currentR.status === "fulfilled") {
        result.current = currentR.value;
      } else {
        errors.push(`current: ${(currentR.reason as Error)?.message ?? String(currentR.reason)}`);
      }

      if (date) {
        if (atDateR.status === "fulfilled" && atDateR.value) {
          result.atDate = atDateR.value;
        } else if (atDateR.status === "rejected") {
          errors.push(`atDate: ${(atDateR.reason as Error)?.message ?? String(atDateR.reason)}`);
        }
      }

      if (errors.length) {
        result.ok = false;
        result.error = errors.join("; ");
      }
      return [key, result];
    }),
  );

  return {
    ok: true,
    asOf: Math.floor(Date.now() / 1000),
    requestedDate: date ?? null,
    benchmarks: Object.fromEntries(entries) as Record<BenchmarkKey, BenchmarkResult>,
  };
}
