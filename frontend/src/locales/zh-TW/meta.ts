/**
 * 瀏覽器分頁標題與 meta description。
 *
 * 這是第一批搬進 catalog 的字串，刻意選它：它從 catalog 一路走到瀏覽器實際顯示的
 * 東西，能證明整條路線接通了。原本寫死在 index.html 裡。
 */
export const meta = {
  title: '{brand} · Agent 原生代幣化 RWA',
  description:
    '{brand} — 基於 Base 鏈的 Agent 原生代幣化 RWA 平台。鏈上買賣股債金幣 + x402 付費訊號 + 社交跟單。',
  /** 跟單旗標關閉時（商業版預設）建置進 index.html 的版本，由 vite.config.ts 選用。 */
  descriptionNoCopy:
    '{brand} — 基於 Base 鏈的 Agent 原生代幣化資產引擎（測試網研究原型）。鏈上鑄造與贖回合成股債金幣 + x402 付費訊號 + agent session 委任。',
};
