import { tenant } from 'src/tenant';
import { brandCatalog } from 'src/tenant/brand';

import { siteLocalesOf } from './site';
import { LOCALES, pickLocale } from './catalogs';

// ----------------------------------------------------------------------

/**
 * 顯示字串的唯一出口。
 *
 * 元件一律 `import { t } from 'src/locales'`，**永不**直接 import `./zh-TW` 或 `./en`。
 * 只有一種取用方式是刻意的：hook 沒辦法在 module scope 用，而 nav 設定、合約錯誤表這些
 * 資料表就活在 module scope；一旦有兩種寫法，分批遷移就會開始出錯。
 *
 * 語言是**建置期**決定的（`VITE_LOCALE`），app 內沒有即時切換：`t` 在 module scope
 * 被大量使用，換語言就是換一份 build。一個站要出幾種語言由租戶的 `siteLocales` 決定，
 * scripts/build-site.mjs 一次 build 出全部：defaultLocale 在 `/`，其他在 `/<locale>/`
 * （default 租戶：中文 `/`、英文 `/en/`），每一份 build 的 `VITE_LOCALE` 由腳本指定。
 * 頂部列的「中 / EN」是整頁跳到另一份 build 的同一頁，見 ./site.ts 與
 * docs/adr/0010-locale-by-url-path.md。
 *
 * 直接跑 `vite`／`vite build` 時 `VITE_LOCALE` 沒設或認不出來就用白標租戶的 defaultLocale。
 */
export const locale = pickLocale(import.meta.env.VITE_LOCALE, tenant.defaultLocale);

/** 這個站出的所有語言，defaultLocale 排第一。只有一種時不顯示語言切換按鈕。 */
export const siteLocales = siteLocalesOf(tenant);

/**
 * 當前語言的 catalog，平台品牌佔位符（`{brand}`、`{brandMark}`）已代換成租戶品牌。
 * 見 src/tenant/brand.ts。
 */
export const t = brandCatalog(LOCALES[locale].catalog, tenant.brand);

export { interpolate } from './interpolate';
