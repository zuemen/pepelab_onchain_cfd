import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/meta.ts`。
 *
 * 型別標註要下在**每個 feature 檔**，不能只在 `en/index.ts` 標一次：index 傳進去的是
 * `meta` 這個變數而不是新鮮的物件字面值，而 TypeScript 的 excess property check 只對
 * 字面值生效——只在 index 標註的話，「多一個 zh-TW 沒有的 key」會被當成合法的結構子型別
 * 而編譯通過。標在這裡才會擋，而且錯誤會指在多出來的那一行上。
 *
 * description 目前仍是中文原文的逐字複本——搬移階段兩份 catalog 一律寫入同一份原文，
 * 翻譯是後面獨立的一步。`locales.test.ts` 的 ratchet 會盯著 `en` 裡剩下的中文字數，
 * 那個數字就是英文版的待辦量，歸零代表翻完。
 */
export const meta: Catalog['meta'] = {
  title: 'PepeLab · Agent-Native RWA Perpetuals',
  description:
    'PepeLab — agent-native RWA perpetuals on Base. 鏈上永續 + x402 付費訊號 + 社交跟單。',
};
