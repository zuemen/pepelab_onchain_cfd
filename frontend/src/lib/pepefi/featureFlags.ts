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

/**
 * 要不要露出永續合約的**入口**。
 *
 * 預設 **關**。平台呈現的主要動作是在 /tokens 用 USDC 買賣代幣化的股債金幣
 * （AssetVault mint/redeem），那是現貨；永續是進階功能。旗標關閉時收起來的是
 * 三個入口：側邊欄的專業終端、首頁的永續功能卡、/exchange 的開倉面板。
 *
 * **收的是入口，不是路徑**——`/terminal` 直接打網址仍然到得了，既有部位也照樣
 * 看得到、平得掉。把路徑鎖起來會變成一套假的權限系統：擋不住真的要繞過的人
 * （前端路由本來就攔不住），卻會擋到照著舊連結進來的正常使用者，而且會讓已經
 * 開著的部位無法平倉——那比多一個入口糟得多。
 *
 * 合約完全沒有改動。要展示永續時設 `VITE_SHOW_PERPETUALS=1`。
 */
export const SHOW_PERPETUALS = readFlag(import.meta.env.VITE_SHOW_PERPETUALS, false);

export const __test__ = { readFlag };
