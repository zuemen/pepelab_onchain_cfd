// 一個站出多種語言時，每種語言放在網址的哪裡（issue #396、docs/adr/0010-locale-by-url-path.md）。
//
// 語言仍然在 build 時決定（ADR 0001），只是同一個站一次 build 出好幾份：
// defaultLocale 放在根目錄 `/`，其他語言放在 `/<locale>/`。
//
// 這個檔案同時被瀏覽器端（語言切換按鈕、router basename）與 Node 端
// （scripts/build-site.mjs 經 Vite 的 runnerImport）import，所以只用相對路徑、
// 不碰 import.meta.env、不碰 fs。

import type { TenantLocale } from '../tenant/schema';

// ----------------------------------------------------------------------

export type SiteLocaleConfig = {
  defaultLocale: TenantLocale;
  siteLocales?: readonly TenantLocale[];
};

/**
 * 這個站出的語言，defaultLocale 排第一。
 *
 * 順序就是 build 順序：根目錄的語言先 build，它的 build 會清空 dist/ 並複製 public/，
 * 其他語言再各自放進 dist/<locale>/。
 */
export function siteLocalesOf(site: SiteLocaleConfig): TenantLocale[] {
  const others = (site.siteLocales ?? []).filter((l) => l !== site.defaultLocale);
  return [site.defaultLocale, ...others];
}

/** 這個語言在站上的根路徑，也是那份 build 的 Vite `base`。 */
export function localeBase(locale: TenantLocale, site: SiteLocaleConfig): string {
  return locale === site.defaultLocale ? '/' : `/${locale}/`;
}

/**
 * Vite 的 `BASE_URL` 換成 react-router 的 basename。要拿掉結尾的斜線：
 * basename `/en/` 對不到 `/en`，直接打 `/en` 會落到 404 頁。
 */
export function routerBasename(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') || '/';
}

/**
 * 目前網址在另一種語言的同一頁，例如 `/esg` ↔ `/en/esg`；查詢字串與 hash 原樣保留。
 * 目標語言不在這個站上就回 null（只出一種語言的租戶沒有地方可以跳）。
 *
 * `currentPath` 是瀏覽器上的完整路徑（含語言前綴），不是 router 去掉 basename 後的那個。
 */
export function localeHref(
  currentPath: string,
  target: TenantLocale,
  site: SiteLocaleConfig
): string | null {
  const locales = siteLocalesOf(site);
  if (!locales.includes(target)) return null;

  const split = currentPath.search(/[?#]/);
  const pathname = split === -1 ? currentPath : currentPath.slice(0, split);
  const rest = split === -1 ? '' : currentPath.slice(split);

  let appPath = pathname;
  for (const locale of locales) {
    const prefix = localeBase(locale, site).slice(0, -1);
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      appPath = pathname.slice(prefix.length) || '/';
      break;
    }
  }

  return `${localeBase(target, site).slice(0, -1)}${appPath}${rest}`;
}
