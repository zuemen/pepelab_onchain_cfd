import { tenant } from 'src/tenant';
import { brandCatalog } from 'src/tenant/brand';

import { LOCALES, pickLocale } from './catalogs';

// ----------------------------------------------------------------------

/**
 * 顯示字串的唯一出口。
 *
 * 元件一律 `import { t } from 'src/locales'`，**永不**直接 import `./zh-TW` 或 `./en`。
 * 只有一種取用方式是刻意的：hook 沒辦法在 module scope 用，而 nav 設定、合約錯誤表這些
 * 資料表就活在 module scope；一旦有兩種寫法，分批遷移就會開始出錯。
 *
 * 語言是**建置期**決定的（`VITE_LOCALE`），沒有 in-app 切換。要換語言是改部署設定、
 * 重新 build，不是改程式碼——同一個 commit 可以同時餵一個中文站和一個英文站。
 * `VITE_LOCALE` 沒設或認不出來時用白標租戶的 defaultLocale（default 租戶是 zh-TW）。
 */
export const locale = pickLocale(import.meta.env.VITE_LOCALE, tenant.defaultLocale);

/**
 * 當前語言的 catalog，平台品牌佔位符（`{brand}`、`{brandMark}`）已代換成租戶品牌。
 * 見 src/tenant/brand.ts。
 */
export const t = brandCatalog(LOCALES[locale].catalog, tenant.brand);

export { interpolate } from './interpolate';
