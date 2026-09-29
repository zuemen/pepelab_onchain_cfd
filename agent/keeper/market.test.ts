// 市場時段／休市判斷的純函式測試。
//   cd agent && npx tsx keeper/market.test.ts
import assert from "node:assert";
import {
  assetClassOf,
  calendarOpen,
  extractMarketSession,
  judgeStaleness,
  marketOpen,
  MAX_CLOSED_AGE_SEC,
  type MarketSession,
} from "./market.ts";
import { extractYahoo } from "./feeds.ts";

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const H = 3600;
const MAX_AGE = 5 * H; // oracle-health.yml 的 HEALTH_MAX_AGE

// 2026-10-02（五）美股正規盤：09:30–16:00 EDT = 13:30–20:00 UTC
const FRI: MarketSession = {
  regularStart: utc(2026, 10, 2, 13, 30),
  regularEnd: utc(2026, 10, 2, 20, 0),
  regularMarketTime: utc(2026, 10, 2, 20, 0),
};
// 2026-09-29（二）
const TUE: MarketSession = {
  regularStart: utc(2026, 9, 29, 13, 30),
  regularEnd: utc(2026, 9, 29, 20, 0),
  regularMarketTime: utc(2026, 9, 29, 15, 55),
};
const SAT_NOON = utc(2026, 10, 3, 15, 0); // 週六 11:00 EDT
const TUE_MIDDAY = utc(2026, 9, 29, 16, 0); // 週二 12:00 EDT

// ── 分類 ──────────────────────────────────────────────────────────────────
assert.equal(assetClassOf("sBTC"), "crypto");
assert.equal(assetClassOf("sETH"), "crypto");
assert.equal(assetClassOf("sAAPL"), "equity");
assert.equal(assetClassOf("sICLN"), "equity");
assert.equal(assetClassOf("sGOLD"), "future");
assert.equal(assetClassOf("sNEW"), "crypto", "未分類資產必須走最嚴格的 24/7 檢查");

// ── 必要案例 1：週六的 sAAPL 不告警 ─────────────────────────────────────────
{
  // keeper 週五收盤後 10 分鐘最後一次寫入，之後整個週末沒寫：age ≈ 19h > 5h。
  const v = judgeStaleness({
    symbol: "sAAPL", updatedAtSec: utc(2026, 10, 2, 20, 10), nowSec: SAT_NOON, maxAgeSec: MAX_AGE, session: FRI,
  });
  assert.equal(v.stale, false, v.reason);
  assert.equal(v.tolerated, true, v.reason);
}
// Yahoo 拿不到時，行事曆後備也不告警。
{
  const v = judgeStaleness({
    symbol: "sAAPL", updatedAtSec: utc(2026, 10, 2, 20, 10), nowSec: SAT_NOON, maxAgeSec: MAX_AGE, session: null,
  });
  assert.equal(v.stale, false, v.reason);
  assert.equal(v.tolerated, true);
}

// ── 必要案例 2：週二盤中過期要告警 ──────────────────────────────────────────
{
  const v = judgeStaleness({
    symbol: "sAAPL", updatedAtSec: TUE_MIDDAY - 6 * H, nowSec: TUE_MIDDAY, maxAgeSec: MAX_AGE, session: TUE,
  });
  assert.equal(v.stale, true, v.reason);
  assert.ok(v.reason.includes("盤中"), v.reason);
  // 行事曆後備同樣判為盤中。
  assert.equal(
    judgeStaleness({ symbol: "sAAPL", updatedAtSec: TUE_MIDDAY - 6 * H, nowSec: TUE_MIDDAY, maxAgeSec: MAX_AGE }).stale,
    true,
  );
}

// ── 必要案例 3：sBTC 週六過期要告警（加密 24/7 嚴格） ───────────────────────
{
  const v = judgeStaleness({
    symbol: "sBTC", updatedAtSec: SAT_NOON - 6 * H, nowSec: SAT_NOON, maxAgeSec: MAX_AGE, session: FRI,
  });
  assert.equal(v.stale, true, v.reason);
  assert.equal(v.tolerated, false);
  assert.equal(marketOpen("sBTC", SAT_NOON), true);
}

// ── 休市也擋得住「keeper 在收盤前就掛了」 ─────────────────────────────────
{
  // 週五 12:00 UTC 之後就沒寫，最後一筆正規盤成交在 20:00 → 落後 8h > 5h。
  const v = judgeStaleness({
    symbol: "sAAPL", updatedAtSec: utc(2026, 10, 2, 12, 0), nowSec: SAT_NOON, maxAgeSec: MAX_AGE, session: FRI,
  });
  assert.equal(v.stale, true, v.reason);
  assert.ok(v.reason.includes("落後"), v.reason);
}

// ── 休市不能無限期靜默：超過 4 天一律過期（來源凍結／ticker 下市） ───────────
{
  const v = judgeStaleness({
    symbol: "sAAPL",
    updatedAtSec: SAT_NOON - MAX_CLOSED_AGE_SEC - H,
    nowSec: SAT_NOON,
    maxAgeSec: MAX_AGE,
    session: { ...FRI, regularMarketTime: SAT_NOON - MAX_CLOSED_AGE_SEC - H },
  });
  assert.equal(v.stale, true, v.reason);
}

// ── 在門檻內一律正常 ─────────────────────────────────────────────────────
assert.equal(
  judgeStaleness({ symbol: "sBTC", updatedAtSec: SAT_NOON - H, nowSec: SAT_NOON, maxAgeSec: MAX_AGE }).stale,
  false,
);

// ── 期貨（sGOLD）週六休市不告警 ──────────────────────────────────────────
assert.equal(
  judgeStaleness({ symbol: "sGOLD", updatedAtSec: utc(2026, 10, 2, 21, 0), nowSec: SAT_NOON, maxAgeSec: MAX_AGE }).stale,
  false,
);

// ── 行事曆後備 ───────────────────────────────────────────────────────────
assert.equal(calendarOpen("equity", TUE_MIDDAY), true);
assert.equal(calendarOpen("equity", utc(2026, 9, 29, 21, 0)), false, "週二 17:00 EDT 已收盤");
assert.equal(calendarOpen("equity", utc(2026, 9, 29, 13, 0)), false, "週二 09:00 EDT 尚未開盤");
assert.equal(calendarOpen("equity", SAT_NOON), false);
assert.equal(calendarOpen("equity", utc(2026, 12, 1, 15, 0)), true, "EST（UTC-5）10:00 盤中");
assert.equal(calendarOpen("future", SAT_NOON), false);
assert.equal(calendarOpen("future", utc(2026, 10, 4, 23, 0)), true, "週日 19:00 EDT 期貨已開");
assert.equal(calendarOpen("future", utc(2026, 10, 4, 21, 0)), false, "週日 17:00 EDT 期貨未開");
assert.equal(calendarOpen("future", utc(2026, 9, 30, 21, 30)), false, "每日 17:00–18:00 ET 休息");
assert.equal(calendarOpen("future", utc(2026, 9, 30, 23, 0)), true);
assert.equal(calendarOpen("crypto", SAT_NOON), true);

// ── Yahoo 回應萃取 ───────────────────────────────────────────────────────
const yahoo = {
  chart: {
    result: [{
      meta: {
        currency: "USD",
        regularMarketPrice: 311,
        regularMarketTime: FRI.regularMarketTime,
        currentTradingPeriod: {
          pre: { timezone: "EDT", start: FRI.regularStart - 5.5 * H, end: FRI.regularStart, gmtoffset: -14400 },
          regular: { timezone: "EDT", start: FRI.regularStart, end: FRI.regularEnd, gmtoffset: -14400 },
          post: { timezone: "EDT", start: FRI.regularEnd, end: FRI.regularEnd + 4 * H, gmtoffset: -14400 },
        },
      },
    }],
  },
};
assert.deepEqual(extractMarketSession(yahoo), FRI);
assert.equal(extractMarketSession({}), null);
assert.equal(extractMarketSession({ chart: { result: [{ meta: { regularMarketTime: 1 } }] } }), null);
assert.equal(
  extractMarketSession({ chart: { result: [{ meta: { regularMarketTime: 5, currentTradingPeriod: { regular: { start: 9, end: 3 } } } }] } }),
  null,
  "end <= start 視為壞資料",
);
// keeper 的 extractYahoo 也帶出同一份時段（第 6 項 marketOperator 用）。
assert.deepEqual(extractYahoo(yahoo, { nowSec: SAT_NOON }).session, FRI);

console.log("market.test.ts ✓ all assertions passed");
