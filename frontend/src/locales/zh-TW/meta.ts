/**
 * 瀏覽器分頁標題與 meta description。
 *
 * 這是第一批搬進 catalog 的字串，刻意選它：它從 catalog 一路走到瀏覽器實際顯示的
 * 東西，能證明整條路線接通了。原本寫死在 index.html 裡。
 *
 * #331 起平台站的主軸是 Web3 社交交易（ADR-023）。跟單旗標關閉的租戶（機構白標）
 * 建置進 index.html 的是 `*NoCopy` 那一組，由 vite.config.ts 選用。
 */
export const meta = {
  title: '{brand} · 幫一般人投資的數位資產平台',
  description:
    '{brand} — 幫一般人投資的數位資產平台：股票、債券、黃金等資產以代幣形式在 Base 鏈上買賣，可以跟著紀錄公開的策略分享者投資，另有第三方 ESG 評級與碳分級、養成遊戲。',
  titleNoCopy: '{brand} · Agent 原生代幣化 RWA',
  descriptionNoCopy:
    '{brand} — Base 鏈上的代幣化資產平台。在鏈上買進與贖回追蹤股債金幣價格的代幣 + x402 付費訊號 + 有上限的 AI 代理額度。',
};
