// 價格來源：CoinGecko（加密）+ Yahoo chart（股票 / ETF / 黃金）。
//
// stooq 已於 2026-07-27 起對所有 symbol 回 HTML 404，且沒有恢復跡象，故完全移除，
// 不留 fallback —— 一個永遠失敗的 fallback 只會讓日誌變吵，並讓人以為還有第二來源。
//
// 萃取邏輯與網路呼叫分離：extract* 是純函式，可以拿真實壞掉的回應直接測試。
import { parseFeedValue, type ParsedFeed } from "./core.ts";

export type Source =
  | { kind: "coingecko"; id: string }
  | { kind: "yahoo"; symbol: string };

export const SOURCES: Record<string, Source> = {
  sBTC: { kind: "coingecko", id: "bitcoin" },
  sETH: { kind: "coingecko", id: "ethereum" },
  sAAPL: { kind: "yahoo", symbol: "AAPL" },
  sTSLA: { kind: "yahoo", symbol: "TSLA" },
  sNVDA: { kind: "yahoo", symbol: "NVDA" },
  sMSFT: { kind: "yahoo", symbol: "MSFT" },
  sGOOGL: { kind: "yahoo", symbol: "GOOGL" },
  sGOLD: { kind: "yahoo", symbol: "GC=F" },
  // #106：sBOND 追蹤標的從 TLT（美國公債，無可稽核的發行方碳強度來源）換成
  // BGRN（iShares USD Green Bond ETF，持股公開揭露、依 Green Bond Principles 篩選）。
  sBOND: { kind: "yahoo", symbol: "BGRN" },
  sICLN: { kind: "yahoo", symbol: "ICLN" },
  sESGU: { kind: "yahoo", symbol: "ESGU" },
};

export function extractCoinGecko(json: unknown, id: string): ParsedFeed {
  if (typeof json !== "object" || json === null) {
    return { value: null, reason: "coingecko: non-object response" };
  }
  const entry = (json as Record<string, unknown>)[id];
  if (typeof entry !== "object" || entry === null) {
    return { value: null, reason: `coingecko: no entry for ${id}` };
  }
  return parseFeedValue((entry as Record<string, unknown>).usd);
}

/** Yahoo 回應的附加中繼資料（幣別 / 報價時間），讓 keeper 能誠實回報偽新鮮度。 */
export interface QuoteMeta {
  /** 報價本身的年齡（秒）。注意這與「鏈上價格的年齡」是兩件事。 */
  quoteAgeSec?: number;
  /** meta.currency 原值。 */
  currency?: string;
  /** 報價比 warnQuoteAgeSec 還舊（例如週末的收盤價）→ 寫上鏈會造成偽新鮮度。 */
  quoteStale?: boolean;
}

/** 報價超過這個年齡就完全不用（預設 4 天：足以涵蓋週末＋一個假日）。 */
export const DEFAULT_MAX_QUOTE_AGE_SEC = 4 * 86_400;
/** 報價超過這個年齡就警告（預設 26 小時：涵蓋正常的隔夜，抓得到週末/凍結）。 */
export const DEFAULT_WARN_QUOTE_AGE_SEC = 26 * 3_600;

/**
 * 從 Yahoo chart 回應萃取價格。
 *
 * 稽核（四·Low）：舊版只讀 `regularMarketPrice`，**不看幣別也不看報價時間**。
 *   • 幣別：Yahoo 會因 ticker 換所（例如 `AAPL` → 倫敦/法蘭克福掛牌）回 GBP/EUR
 *     的數字，型別完全合法，但寫進 oracle 就是錯價，會清算所有部位。
 *   • 報價時間：週末回的是上一個收盤價，keeper 每 15 分鐘照寫一次 → 鏈上
 *     `updatedAt` 一直新鮮、價格卻是兩天前的。對「price feed liveness」而言
 *     這是**偽新鮮度**，比明著過期更危險。
 * 現在幣別非 USD 直接拒絕；報價過舊超過 maxQuoteAgeSec 也拒絕，介於警告區間
 * 則回值但標記 `quoteStale`，由呼叫端印出來。
 */
export function extractYahoo(
  json: unknown,
  opts: { nowSec?: number; maxQuoteAgeSec?: number; warnQuoteAgeSec?: number } = {},
): ParsedFeed & QuoteMeta {
  if (typeof json !== "object" || json === null) {
    return { value: null, reason: "yahoo: non-object response" };
  }
  const chart = (json as Record<string, unknown>).chart;
  if (typeof chart !== "object" || chart === null) {
    return { value: null, reason: "yahoo: no chart field" };
  }
  const result = (chart as Record<string, unknown>).result;
  if (!Array.isArray(result) || result.length === 0) {
    return { value: null, reason: "yahoo: empty result" };
  }
  const metaRaw = (result[0] as Record<string, unknown> | undefined)?.meta;
  if (typeof metaRaw !== "object" || metaRaw === null) {
    return { value: null, reason: "yahoo: no meta" };
  }
  const meta = metaRaw as Record<string, unknown>;

  // 1) 幣別必須是 USD —— oracle 的所有價格都是 USD 8-dec。
  const currency = typeof meta.currency === "string" ? meta.currency : undefined;
  if (!currency) {
    return { value: null, reason: "yahoo: meta.currency 缺漏（無法確認幣別）" };
  }
  if (currency.toUpperCase() !== "USD") {
    return { value: null, reason: `yahoo: 幣別為 ${currency}，不是 USD`, currency };
  }

  // 2) 報價時間必須存在且合理。
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC;
  const warnAge = opts.warnQuoteAgeSec ?? DEFAULT_WARN_QUOTE_AGE_SEC;
  const t = meta.regularMarketTime;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    return { value: null, reason: "yahoo: meta.regularMarketTime 缺漏或非法", currency };
  }
  const quoteAgeSec = Math.max(0, nowSec - t);
  if (quoteAgeSec > maxAge) {
    return {
      value: null,
      reason: `yahoo: 報價已 ${(quoteAgeSec / 3600).toFixed(1)} 小時未更新（上限 ${(maxAge / 3600).toFixed(0)}h）`,
      currency,
      quoteAgeSec,
      quoteStale: true,
    };
  }

  const parsed = parseFeedValue(meta.regularMarketPrice);
  return { ...parsed, currency, quoteAgeSec, quoteStale: quoteAgeSec > warnAge };
}

/** 網路取價。任何失敗都回 value:null，永遠不丟例外、永遠不編造數字。 */
export async function fetchPrice(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedFeed & QuoteMeta & { source: string }> {
  const src = SOURCES[symbol];
  if (!src) return { value: null, reason: `unknown symbol ${symbol}`, source: "none" };

  try {
    if (src.kind === "coingecko") {
      const res = await fetchImpl(
        `https://api.coingecko.com/api/v3/simple/price?ids=${src.id}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) {
        return { value: null, reason: `coingecko HTTP ${res.status}`, source: "coingecko" };
      }
      return { ...extractCoinGecko(await res.json(), src.id), source: "coingecko" };
    }

    // Yahoo 的 chart 端點沒有瀏覽器 User-Agent 會回 401。
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(src.symbol)}?interval=1d&range=1d`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { value: null, reason: `yahoo HTTP ${res.status}`, source: "yahoo" };
    }
    return { ...extractYahoo(await res.json()), source: "yahoo" };
  } catch (e) {
    return { value: null, reason: `fetch failed: ${(e as Error).message}`, source: src.kind };
  }
}
