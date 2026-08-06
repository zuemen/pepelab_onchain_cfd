// 純函式測試：價格來源回應的萃取與拒絕。
//   cd agent && npx tsx keeper/feeds.test.ts
import assert from "node:assert";
import { extractCoinGecko, extractYahoo, SOURCES } from "./feeds.ts";

// ── CoinGecko simple/price ──────────────────────────────────────────────
assert.equal(extractCoinGecko({ bitcoin: { usd: 64578 } }, "bitcoin").value, 64578);
assert.equal(extractCoinGecko({ bitcoin: {} }, "bitcoin").value, null);
assert.equal(extractCoinGecko({}, "bitcoin").value, null);
// 速率限制時 CoinGecko 回的是錯誤物件，不是價格。
assert.equal(
  extractCoinGecko({ status: { error_code: 429, error_message: "rate limited" } }, "bitcoin").value,
  null,
);

// ── Yahoo chart ─────────────────────────────────────────────────────────
const YAHOO_OK = {
  chart: {
    result: [{ meta: { currency: "USD", regularMarketPrice: 311.0, regularMarketTime: 1785977652 } }],
  },
};
const NOW = 1785977652 + 300; // 報價後 5 分鐘
assert.equal(extractYahoo(YAHOO_OK, { nowSec: NOW }).value, 311);
assert.equal(extractYahoo(YAHOO_OK, { nowSec: NOW }).quoteStale, false);

// Yahoo 沒有 UA 時回 401，body 是錯誤物件而非圖表。
const YAHOO_401 = { finance: { error: { code: "Unauthorized", description: "Invalid Crumb" } } };
assert.equal(extractYahoo(YAHOO_401).value, null);

// 有結構但沒有價格 —— 這是最危險的一種：型別對、內容缺。
assert.equal(extractYahoo({ chart: { result: [{ meta: {} }] } }).value, null);
assert.equal(extractYahoo({ chart: { result: [] } }).value, null);
assert.equal(extractYahoo({ chart: { result: null } }).value, null);

// 若來源整個換成 HTML（stooq 的死法），parse 之前就會炸，這裡確認我們接得住。
assert.equal(extractYahoo("<html>404</html>").value, null);

// ── 幣別（稽核 四·Low）──────────────────────────────────────────────────
// ticker 換所後 Yahoo 會回外幣報價：數字合法、欄位齊全，寫進 oracle 就是錯價。
const YAHOO_GBP = {
  chart: { result: [{ meta: { currency: "GBP", regularMarketPrice: 245.5, regularMarketTime: 1785977652 } }] },
};
assert.equal(extractYahoo(YAHOO_GBP, { nowSec: NOW }).value, null);
assert.ok(extractYahoo(YAHOO_GBP, { nowSec: NOW }).reason.includes("GBP"));
// 完全沒有 currency 欄位 → 無法確認幣別，一律不用。
const YAHOO_NO_CCY = {
  chart: { result: [{ meta: { regularMarketPrice: 311, regularMarketTime: 1785977652 } }] },
};
assert.equal(extractYahoo(YAHOO_NO_CCY, { nowSec: NOW }).value, null);

// ── 報價時間 / 偽新鮮度（稽核 四·Low）──────────────────────────────────
// 缺 regularMarketTime → 無法判斷是不是兩天前的收盤價 → 不用。
const YAHOO_NO_TIME = {
  chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 311 } }] },
};
assert.equal(extractYahoo(YAHOO_NO_TIME, { nowSec: NOW }).value, null);

// 週末：報價是 40 小時前的收盤價 → 仍給值（否則週末全部資產都會跳過），
// 但必須標記 quoteStale，讓 keeper 印出警告而不是假裝資料是即時的。
{
  const weekend = extractYahoo(YAHOO_OK, { nowSec: 1785977652 + 40 * 3600 });
  assert.equal(weekend.value, 311);
  assert.equal(weekend.quoteStale, true, "40 小時前的報價必須被標記為 stale");
  assert.ok((weekend.quoteAgeSec ?? 0) > 26 * 3600);
}

// 來源凍結：報價 10 天沒動 → 超過上限，完全不用。
{
  const frozen = extractYahoo(YAHOO_OK, { nowSec: 1785977652 + 10 * 86400 });
  assert.equal(frozen.value, null);
  assert.equal(frozen.quoteStale, true);
}

// 未來時間戳不產生負數年齡。
assert.equal(extractYahoo(YAHOO_OK, { nowSec: 1785977652 - 3600 }).quoteAgeSec, 0);

// ── SOURCES：11 個資產一個都不能少,且不得再出現硬編碼 assetId ────────────
const EXPECTED = ["sBTC","sETH","sAAPL","sTSLA","sNVDA","sMSFT","sGOOGL","sGOLD","sBOND","sICLN","sESGU"];
assert.deepEqual(Object.keys(SOURCES).sort(), [...EXPECTED].sort());
// 沒有任何資產可以落到「隨機漫步」——那是被刪掉的舊行為。
for (const [sym, src] of Object.entries(SOURCES)) {
  assert.ok(src.kind === "coingecko" || src.kind === "yahoo", `${sym} 來源不明`);
}

console.log("feeds.test.ts ✓ all assertions passed");
