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
  chart: { result: [{ meta: { regularMarketPrice: 311.0, regularMarketTime: 1785977652 } }] },
};
assert.equal(extractYahoo(YAHOO_OK).value, 311);

// Yahoo 沒有 UA 時回 401，body 是錯誤物件而非圖表。
const YAHOO_401 = { finance: { error: { code: "Unauthorized", description: "Invalid Crumb" } } };
assert.equal(extractYahoo(YAHOO_401).value, null);

// 有結構但沒有價格 —— 這是最危險的一種：型別對、內容缺。
assert.equal(extractYahoo({ chart: { result: [{ meta: {} }] } }).value, null);
assert.equal(extractYahoo({ chart: { result: [] } }).value, null);
assert.equal(extractYahoo({ chart: { result: null } }).value, null);

// 若來源整個換成 HTML（stooq 的死法），parse 之前就會炸，這裡確認我們接得住。
assert.equal(extractYahoo("<html>404</html>").value, null);

// ── SOURCES：11 個資產一個都不能少,且不得再出現硬編碼 assetId ────────────
const EXPECTED = ["sBTC","sETH","sAAPL","sTSLA","sNVDA","sMSFT","sGOOGL","sGOLD","sBOND","sICLN","sESGU"];
assert.deepEqual(Object.keys(SOURCES).sort(), [...EXPECTED].sort());
// 沒有任何資產可以落到「隨機漫步」——那是被刪掉的舊行為。
for (const [sym, src] of Object.entries(SOURCES)) {
  assert.ok(src.kind === "coingecko" || src.kind === "yahoo", `${sym} 來源不明`);
}

console.log("feeds.test.ts ✓ all assertions passed");
