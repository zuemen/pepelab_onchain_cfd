import type { Catalog } from './zh-TW';

import en from './en';
import zhTW from './zh-TW';

// ----------------------------------------------------------------------

/**
 * 每個語言的 catalog 加上它在 `<html lang>` 上該用的值。
 *
 * `zh-TW` 的文件語言是 `zh-Hant` 而不是 `zh-TW`：前者描述的是書寫系統（繁體），
 * 螢幕閱讀器與瀏覽器翻譯要的是這個。
 */
export const LOCALES = {
  'zh-TW': { htmlLang: 'zh-Hant', catalog: zhTW },
  en: { htmlLang: 'en', catalog: en },
} satisfies Record<string, { htmlLang: string; catalog: Catalog }>;

export type LocaleCode = keyof typeof LOCALES;

export const DEFAULT_LOCALE: LocaleCode = 'zh-TW';

/**
 * 把 `VITE_LOCALE` 的值換成我們真的有出貨的語言，認不出來就退回預設。
 *
 * 大小寫不敏感是為了部署現場：`VITE_LOCALE` 是打在 Vercel 欄位裡的字串，有人會打
 * `EN`。嚴格比對的話那會靜悄悄變成一個中文站，而且只有在別人回報時才會發現。
 * 認不出來的值則會留一行 warn——寬容但不沉默。
 */
export function pickLocale(code: string | undefined): LocaleCode {
  if (!code) {
    return DEFAULT_LOCALE;
  }

  const codes = Object.keys(LOCALES) as LocaleCode[];
  const match = codes.find((known) => known.toLowerCase() === code.toLowerCase());

  if (!match) {
    console.warn(`[locales] 不認得的 VITE_LOCALE "${code}"，改用 ${DEFAULT_LOCALE}`);
    return DEFAULT_LOCALE;
  }

  return match;
}
