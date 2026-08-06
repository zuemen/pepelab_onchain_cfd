// 付費 API 回應的嚴格解析 —— 「這份 body 是不是可以拿來做決策的資料」。
//
// 稽核 2026-08-06 · A-1（Critical）：所有 agent 都寫成 `const data = body?.data ?? body`。
// 錯誤 body 沒有 `data` 欄位，於是整個錯誤物件（503 的 `{ok:false,error:"price_stale"}`、
// 402 的付款需求、Vercel 的 HTML 錯誤頁 parse 後的任何東西）被當成資料使用；
// `decide()` 只檢查 `!d || d.isStale`，兩者皆假，`recommendation` 是 `undefined`
// → 不等於 `"no_trade"` → `isLong = false` → **送出真實 SHORT 單**。
// 實測：503 `price_stale` 與 402 未付款的 body 都會得到 `{"action":"short",...}`。
//
// 這個模組是所有 agent 的單一入口：只有 2xx + `ok !== false` + `data` 物件 +
// 欄位型別正確 + `recommendation` 在白名單內，才算「資料」。其餘一律不可用。

/** server 允許的建議值白名單。不在其中的值一律不得被解讀成方向。 */
export const VALID_RECOMMENDATIONS = ["long", "short", "no_trade"] as const;
export type Recommendation = (typeof VALID_RECOMMENDATIONS)[number];

export type ParsedBody<T = any> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

function httpFailure(body: any, httpStatus?: number): { ok: false; reason: string } | null {
  if (typeof httpStatus === "number" && (httpStatus < 200 || httpStatus >= 300)) {
    const why = body?.error ?? body?.message ?? "";
    return { ok: false, reason: `HTTP ${httpStatus}${why ? `（${String(why).slice(0, 120)}）` : ""}` };
  }
  return null;
}

/** 嚴格解析 `GET /oracle/:asset` 的回應。 */
export function parseOracleBody(body: any, httpStatus?: number): ParsedBody {
  const httpFail = httpFailure(body, httpStatus);
  if (httpFail) return httpFail;
  if (!body || typeof body !== "object") return { ok: false, reason: "回應不是物件" };
  if (body.ok === false) {
    return { ok: false, reason: `server 回報失敗：${String(body.error ?? "unknown").slice(0, 120)}` };
  }
  // 資料一定在 `data` 底下；**不再**退回 body 本身（那正是把錯誤當資料的來源）。
  const d = body.data;
  if (!d || typeof d !== "object") return { ok: false, reason: "回應缺少 data 物件" };
  if (typeof d.price !== "number" || !Number.isFinite(d.price) || d.price <= 0) {
    return { ok: false, reason: `data.price 不是合法價格（${JSON.stringify(d.price)}）` };
  }
  if (typeof d.fundingRateBps !== "number" || !Number.isFinite(d.fundingRateBps)) {
    return { ok: false, reason: "data.fundingRateBps 不是數值" };
  }
  if (!VALID_RECOMMENDATIONS.includes(d.recommendation)) {
    return {
      ok: false,
      reason:
        `data.recommendation 不在白名單內（收到 ${JSON.stringify(d.recommendation)}，` +
        `只接受 ${VALID_RECOMMENDATIONS.join("/")}）`,
    };
  }
  return { ok: true, data: d };
}

/** 嚴格解析 `GET /signals/:trader` 的回應。 */
export function parseSignalsBody(body: any, httpStatus?: number): ParsedBody {
  const httpFail = httpFailure(body, httpStatus);
  if (httpFail) return httpFail;
  if (!body || typeof body !== "object") return { ok: false, reason: "回應不是物件" };
  if (body.ok === false) {
    return { ok: false, reason: `server 回報失敗：${String(body.error ?? "unknown").slice(0, 120)}` };
  }
  const d = body.data;
  if (!d || typeof d !== "object") return { ok: false, reason: "回應缺少 data 物件" };
  if (typeof d.trader !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.trader)) {
    return { ok: false, reason: `data.trader 不是合法地址（${JSON.stringify(d.trader)}）` };
  }
  if (!Array.isArray(d.suggestion)) return { ok: false, reason: "data.suggestion 不是陣列" };
  return { ok: true, data: d };
}
