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
  sBOND: { kind: "yahoo", symbol: "TLT" },
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

export function extractYahoo(json: unknown): ParsedFeed {
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
  const meta = (result[0] as Record<string, unknown> | undefined)?.meta;
  if (typeof meta !== "object" || meta === null) {
    return { value: null, reason: "yahoo: no meta" };
  }
  return parseFeedValue((meta as Record<string, unknown>).regularMarketPrice);
}

/** 網路取價。任何失敗都回 value:null，永遠不丟例外、永遠不編造數字。 */
export async function fetchPrice(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedFeed & { source: string }> {
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
