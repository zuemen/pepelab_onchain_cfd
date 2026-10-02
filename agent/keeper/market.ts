// 市場時段：讓健檢分得出「休市中合理地沒更新」與「keeper 真的掛了」。
//
// 為什麼存在：股票／ETF／期貨週末與假日沒有新成交，若健檢對所有資產一律用同一個
// 年齡門檻，每個週末都會告警 —— 被無視的告警等於沒有告警。但加密資產 24/7 交易，
// 必須維持嚴格檢查（sBTC 週六過期就是 keeper 掛了）。
//
// 資料來源：Yahoo chart 的 meta.currentTradingPeriod.regular 與 meta.regularMarketTime
// （keeper 已經在抓同一個端點，見 feeds.ts）。Yahoo 拿不到時退回靜態行事曆
// （不含假日），並把寬限上限設死，避免「來源壞了 = 永遠休市 = 永遠不告警」。
//
// 這個檔案只有純函式，可被單元測試覆蓋。

export type AssetClass = "crypto" | "equity" | "future";

/** 未列出的資產一律當 crypto（最嚴格）處理 —— 新資產忘了分類時寧可誤報。 */
export const ASSET_CLASS: Record<string, AssetClass> = {
  sBTC: "crypto",
  sETH: "crypto",
  sAAPL: "equity",
  sTSLA: "equity",
  sNVDA: "equity",
  sMSFT: "equity",
  sGOOGL: "equity",
  sBOND: "equity", // BGRN（ETF）
  sICLN: "equity", // ETF
  sESGU: "equity", // ETF
  sGOLD: "future", // GC=F（COMEX 黃金期貨）
};

export function assetClassOf(symbol: string): AssetClass {
  return ASSET_CLASS[symbol] ?? "crypto";
}

/** 休市中最多容忍多久沒更新（與 feeds.ts 的 DEFAULT_MAX_QUOTE_AGE_SEC 一致：週末＋一個假日）。 */
export const MAX_CLOSED_AGE_SEC = 4 * 86_400;

export interface MarketSession {
  /** 最近一次正規盤成交時間（meta.regularMarketTime）。 */
  regularMarketTime: number;
  /** 當前（或最近一個）交易日的正規盤區間 [start, end)。 */
  regularStart: number;
  regularEnd: number;
}

/** 從 Yahoo chart 回應取出市場時段；缺任何欄位就回 null（呼叫端退回行事曆）。 */
export function extractMarketSession(json: unknown): MarketSession | null {
  const meta = (json as { chart?: { result?: { meta?: Record<string, unknown> }[] } } | null)
    ?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta !== "object") return null;
  const regular = (meta.currentTradingPeriod as { regular?: { start?: unknown; end?: unknown } } | undefined)
    ?.regular;
  const t = meta.regularMarketTime;
  const s = regular?.start;
  const e = regular?.end;
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (!ok(t) || !ok(s) || !ok(e) || e <= s) return null;
  return { regularMarketTime: t, regularStart: s, regularEnd: e };
}

export function isSessionOpen(session: MarketSession, nowSec: number): boolean {
  return nowSec >= session.regularStart && nowSec < session.regularEnd;
}

/** America/New_York 的星期（0=Sun）與當日分鐘數。 */
function nyClock(nowSec: number): { dow: number; min: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { dow, min: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * 靜態行事曆（Yahoo 拿不到時的後備；不含假日）：
 *   equity — 週一至週五 09:30–16:00 ET
 *   future — COMEX 金屬：週日 18:00 ET 到週五 17:00 ET，每日 17:00–18:00 休息
 *   crypto — 永遠開
 */
export function calendarOpen(cls: AssetClass, nowSec: number): boolean {
  if (cls === "crypto") return true;
  const { dow, min } = nyClock(nowSec);
  if (cls === "equity") return dow >= 1 && dow <= 5 && min >= 9 * 60 + 30 && min < 16 * 60;
  // future
  if (dow === 6) return false;
  if (dow === 0) return min >= 18 * 60;
  if (dow === 5) return min < 17 * 60;
  return min < 17 * 60 || min >= 18 * 60;
}

/**
 * COMEX 週末休市窗口：週五 17:00 ET 到週日 18:00 ET（不含假日）。
 * 與 calendarOpen("future") 的差別：每天 17:00–18:00 ET 的一小時休息不算。
 */
export function futureWeekendClosed(nowSec: number): boolean {
  const { dow, min } = nyClock(nowSec);
  if (dow === 6) return true;
  if (dow === 5) return min >= 17 * 60;
  if (dow === 0) return min < 18 * 60;
  return false;
}

/**
 * 健檢用的「是否在交易時段內」—— fail-closed（審查 Medium 3）：Yahoo 與行事曆
 * **任一**說開盤就當開盤（嚴格判斷）。只有兩者都說休市（或沒有 Yahoo、行事曆說休市）
 * 才放寬。代價是美股假日會被當成開盤而告警；那是可以接受的誤報，漏報不行。
 */
export function marketOpen(symbol: string, nowSec: number, session?: MarketSession | null): boolean {
  const cls = assetClassOf(symbol);
  if (cls === "crypto") return true;
  if (calendarOpen(cls, nowSec)) return true;
  return session ? isSessionOpen(session, nowSec) : false;
}

/** 某個 UTC 時刻在 America/New_York 的 UTC 偏移（秒，EDT = −14400）。 */
function nyOffsetSec(tSec: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(tSec * 1000));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) / 1000;
  return wall - tSec;
}

/**
 * 行事曆上「最近一次排定收盤」的 UTC 時間（≤ nowSec）。不含假日。
 *   equity — 週一至週五 16:00 ET
 *   future — 週一至週五 17:00 ET（週一至週四是每日休息的開始，週五是週末休市的開始）
 */
export function lastScheduledClose(cls: AssetClass, nowSec: number): number | null {
  if (cls === "crypto") return null;
  const closeMin = cls === "equity" ? 16 * 60 : 17 * 60;
  for (let k = 0; k <= 8; k++) {
    const t = nowSec - k * 86_400;
    const off = nyOffsetSec(t);
    const local = new Date((t + off) * 1000); // 以 UTC 欄位表示 NY 牆上時間
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const wallClose = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 + closeMin * 60;
    const close = wallClose - nyOffsetSec(wallClose - off);
    if (close <= nowSec) return close;
  }
  return null;
}

export interface StaleVerdict {
  stale: boolean;
  /** 休市中、依市場時段放寬而沒有告警（照一般門檻其實已超齡）。 */
  tolerated: boolean;
  /** 放寬只靠行事曆後備（沒有 Yahoo 時段）—— 告警端不據此自動關閉 issue。 */
  viaFallback?: boolean;
  reason: string;
}

/**
 * 判斷一個資產的鏈上價格是否過期。
 *
 *   crypto            → age > maxAge 即過期（24/7 嚴格）。
 *   股票／ETF／期貨，盤中 → 同上，嚴格。
 *   休市中，有 Yahoo 時段 → 看「鏈上價格落後最後一筆正規盤成交多久」：
 *                          regularMarketTime − updatedAt > maxAge 才算過期
 *                          （keeper 在收盤前就掛了）；休市期間沒有新成交，不更新是合理的。
 *   休市中，只有行事曆   → 用行事曆算出的「上一次排定收盤」代替最後成交時間：
 *                          lastClose − updatedAt > maxAge 才算過期；並標記 viaFallback。
 *   「休市」必須 Yahoo 與行事曆都同意（見 marketOpen），任一說開盤就嚴格判斷。
 *   任何情況下 age > MAX_CLOSED_AGE_SEC 都算過期：休市不會超過 4 天，
 *   超過代表來源凍結或 ticker 下市，不能無限期以「休市」為由靜默。
 */
export function judgeStaleness(a: {
  symbol: string;
  updatedAtSec: number;
  nowSec: number;
  maxAgeSec: number;
  session?: MarketSession | null;
}): StaleVerdict {
  const age = a.nowSec - a.updatedAtSec;
  const h = (s: number) => `${(s / 3600).toFixed(1)}h`;
  const cls = assetClassOf(a.symbol);

  if (age <= a.maxAgeSec) return { stale: false, tolerated: false, reason: `age ${h(age)}` };
  if (cls === "crypto") {
    return { stale: true, tolerated: false, reason: `crypto 24/7，age ${h(age)} > ${h(a.maxAgeSec)}` };
  }
  if (marketOpen(a.symbol, a.nowSec, a.session)) {
    return { stale: true, tolerated: false, reason: `盤中，age ${h(age)} > ${h(a.maxAgeSec)}` };
  }
  if (age > MAX_CLOSED_AGE_SEC) {
    return { stale: true, tolerated: false, reason: `休市但 age ${h(age)} > ${h(MAX_CLOSED_AGE_SEC)}（來源凍結？）` };
  }
  if (a.session) {
    const lag = a.session.regularMarketTime - a.updatedAtSec;
    if (lag > a.maxAgeSec) {
      return {
        stale: true,
        tolerated: false,
        reason: `休市，但鏈上價格落後最後一筆正規盤成交 ${h(lag)} > ${h(a.maxAgeSec)}`,
      };
    }
    return { stale: false, tolerated: true, reason: `休市（最後成交後未再更新屬正常），age ${h(age)}` };
  }
  const lastClose = lastScheduledClose(cls, a.nowSec);
  if (lastClose === null) {
    return { stale: true, tolerated: false, reason: `休市但算不出上一次收盤，age ${h(age)} > ${h(a.maxAgeSec)}` };
  }
  const lag = lastClose - a.updatedAtSec;
  if (lag > a.maxAgeSec) {
    return {
      stale: true,
      tolerated: false,
      reason: `休市（行事曆後備），但鏈上價格落後上一次排定收盤 ${h(lag)} > ${h(a.maxAgeSec)}`,
    };
  }
  return {
    stale: false,
    tolerated: true,
    viaFallback: true,
    reason: `休市（行事曆後備，無 Yahoo 時段），收盤前已更新，age ${h(age)}`,
  };
}
