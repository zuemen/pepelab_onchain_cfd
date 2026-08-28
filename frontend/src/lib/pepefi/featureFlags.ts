// 顯示層的功能旗標。
//
// 這裡只關「畫面上看不看得到」，**不改任何鏈上行為**。合約照舊收 leverage
// 參數、照舊算保證金；旗標關掉的時候前端一律傳 1，等同現貨。這樣要把功能開
// 回來是改一個環境變數，不是回頭改合約與測試。
//
// 值的解析規則統一：`VITE_X=1` / `true` / `on` 才算開，其餘（含未設定）都算關。

function readFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * 下單面板要不要露出槓桿選擇器。
 *
 * 預設 **關**。平台的門面是代幣化 RWA 的現貨買賣（AssetVault mint/redeem），
 * 永續終端機是進階功能；一進站就看到 5× 按鈕，會讓人以為這是炒幣平台，而那
 * 是我們最不想給的第一印象。開發或要展示永續時設 `VITE_SHOW_LEVERAGE=1`。
 */
export const SHOW_LEVERAGE = readFlag(import.meta.env.VITE_SHOW_LEVERAGE, false);

/** 旗標關閉時強制的槓桿倍數——1× 就是「保證金 = 部位大小」。 */
export const FIXED_LEVERAGE = 1;

export const __test__ = { readFlag };
