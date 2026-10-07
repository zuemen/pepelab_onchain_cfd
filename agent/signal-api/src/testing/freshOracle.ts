// 測試用的 /oracle/:asset 新鮮度讀取：一律回報「剛寫入、maxPriceAge 6 小時」的價格。
// 付款前的新鮮度閘門讀不到鏈上資料時會回 503（fail-closed），所以離線測試要走到 402
// 或付費牆之後，就必須注入這個 reader（createApp 的 oracleFreshnessReader）。
// 只給離線測試用，不會被打包進 Vercel bundle（vercel-entry 不 import 它）。
export const freshOracleReader = async (): Promise<{ updatedAtSec: number; maxPriceAgeSec: number }> => ({
  updatedAtSec: Math.floor(Date.now() / 1000),
  maxPriceAgeSec: 21_600,
});
