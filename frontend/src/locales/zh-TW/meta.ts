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
  title: '{brand} · Web3 社交交易',
  description:
    '{brand} — Base 鏈上的 Web3 社交交易平台：跟著鏈上透明的交易者投資。社交跟單、ESG 評分、GameFi（測試網研究原型）。',
  titleNoCopy: '{brand} · Agent 原生代幣化 RWA',
  descriptionNoCopy:
    '{brand} — 基於 Base 鏈的 Agent 原生代幣化資產引擎（測試網研究原型）。鏈上鑄造與贖回合成股債金幣 + x402 付費訊號 + agent session 委任。',
};
