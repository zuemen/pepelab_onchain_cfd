// 策略腿／部位的「槓桿倍數」與「多空方向」要不要出現在畫面上。
//
// 2026-11-15 指導者：資產一律以 RWA 代幣現貨呈現。default 租戶的 SHOW_LEVERAGE 預設關，
// 關閉時畫面不出現 2×、5× 這類倍數，也不出現描述策略腿／部位方向的做多／做空、↑↓。
// 只收顯示，**不改鏈上資料**：既有 2× 的部位與策略照樣讀得到、平得掉，只是不顯示倍數。
//
// 方向跟著同一個旗標走：沒有槓桿的現貨配置只有「持有」一種方向，再標做多是多餘的；
// 旗標關閉時發布策略也一律送 isLong=true（見 TraderDashboard）。
import { SHOW_LEVERAGE } from './featureFlags';

/** 策略腿與部位的方向（做多／做空、↑↓）要不要顯示。與槓桿同一個旗標。 */
export const SHOW_DIRECTION = SHOW_LEVERAGE;

/**
 * 把 catalog 樣板裡描述槓桿與方向的佔位符拿掉，讓同一句話在現貨呈現下仍然通順。
 *
 * - 括號裡提到槓桿的補充說明（含 `{leverage}` 或 `{lev}` 的「（…）」或「(…)」）整段拿掉；
 * - `{side}` 整個拿掉；
 * - `{leverage}×`／`{lev}×`（前面可帶 `·` 分隔）整段拿掉；
 * - 多出來的空白收成一個、頭尾去掉。
 *
 * 不新增 catalog 鍵：語系檔由文案統一維護，這裡只處理樣板裡的佔位符，換句話也照樣適用。
 * `show` 為 true 時原樣回傳。
 */
export function spotTemplate(template: string, show: boolean = SHOW_LEVERAGE): string {
  if (show) return template;
  return template
    .replace(/\s*[（(][^（()）]*\{(?:leverage|lev)\}[^（()）]*[)）]/g, '')
    .replace(/\s*[·•]?\s*\{(?:leverage|lev)\}\s*[×x]/g, '')
    .replace(/\{side\}/g, '')
    .replace(/\s*[（(]\s*[)）]/g, '')
    .replace(/([（(])\s*[，,]\s*/g, '$1')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\s+([,，;；)）])/g, '$1')
    .trim();
}
