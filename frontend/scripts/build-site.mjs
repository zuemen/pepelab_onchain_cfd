// 一次 build 出這個租戶的所有語言（issue #396、docs/adr/0010-locale-by-url-path.md）。
//
//   defaultLocale → dist/             （含 public/ 的靜態檔）
//   其他語言      → dist/<locale>/    （base 是 /<locale>/，不複製 public/）
//
// public/ 約 135 MB，只放根目錄一份；其他語言的頁面引用 /pepe-skins/... 這類絕對路徑，
// 拿到的就是根目錄那份。只出一種語言的租戶（siteLocales 沒填）輸出跟以前的
// `vite build` 一樣。
//
// 每一份 build 的 VITE_LOCALE 都由這裡指定：Vercel 專案上殘留的 VITE_LOCALE 不會讓
// 根目錄變成英文。租戶、語言清單與路徑規則都從 src/ 的同一份 TS 讀（Vite 的
// runnerImport），不在這裡另寫一套。
//
// 用法：`yarn build`（先 tsc，再跑這支）。VITE_TENANT 照常從環境變數或 .env* 讀。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadEnv, runnerImport } from 'vite';

// ----------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = 'dist';

async function importTs(file) {
  const { module } = await runnerImport(path.join(ROOT, file), { root: ROOT, logLevel: 'error' });
  return module;
}

const { loadTenantForBuild } = await importTs('src/tenant/node.ts');
const { siteLocalesOf, localeBase } = await importTs('src/locales/site.ts');
const { LOCALES } = await importTs('src/locales/catalogs.ts');

// 與 vite.config.ts 同一個讀法：shell／Vercel 的環境變數優先，其次是 .env* 檔。
const fileEnv = loadEnv('production', ROOT, 'VITE_');
const tenant = loadTenantForBuild(ROOT, process.env.VITE_TENANT ?? fileEnv.VITE_TENANT);
const locales = siteLocalesOf(tenant.config);

const leftover = process.env.VITE_LOCALE ?? fileEnv.VITE_LOCALE;
if (leftover) {
  console.warn(
    `[build-site] 忽略 VITE_LOCALE="${leftover}"：語言由租戶 "${tenant.id}" 的 ` +
      `defaultLocale／siteLocales 決定（${locales.join(', ')}）`
  );
}

/** dist/ 底下放這個語言的目錄，例如 '' 或 'en'。 */
const dirOf = (base) => base.replace(/^\/|\/$/g, '');

for (const locale of locales) {
  const base = localeBase(locale, tenant.config);
  const isRoot = base === '/';
  console.log(
    `\n[build-site] ${tenant.id} / ${locale} → ${path.posix.join(OUT_DIR, dirOf(base))}/`
  );

  process.env.VITE_LOCALE = locale;
  await build({
    root: ROOT,
    base,
    // 只有根目錄那份帶 public/；false = 不複製（其他語言共用根目錄的靜態檔）。
    ...(isRoot ? {} : { publicDir: false }),
    build: { outDir: path.join(OUT_DIR, dirOf(base)), emptyOutDir: true },
  });
}

// ── build 後檢查 ─────────────────────────────────────────────────────────
// 每一份 index.html 的語言要對、程式檔要從自己那一層的 assets/ 載入；非根目錄的語言
// 不可以帶 public/ 的複本。任何一項不對就讓 build 失敗。

const problems = [];
for (const locale of locales) {
  const base = localeBase(locale, tenant.config);
  const dir = path.join(ROOT, OUT_DIR, dirOf(base));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const where = path.posix.join(OUT_DIR, dirOf(base), 'index.html');

  const lang = LOCALES[locale].htmlLang;
  if (!html.includes(`<html lang="${lang}"`))
    problems.push(`${where}: expected <html lang="${lang}">`);

  const code = [
    ...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*\srel="(?:modulepreload|stylesheet)"[^>]*\shref="([^"]+)"/g),
  ].map((m) => m[1]);
  if (code.length === 0) problems.push(`${where}: no script or stylesheet found`);
  for (const url of code) {
    if (!url.startsWith(`${base}assets/`))
      problems.push(`${where}: ${url} is outside ${base}assets/`);
  }

  if (base !== '/') {
    const extra = fs.readdirSync(dir).filter((f) => f !== 'index.html' && f !== 'assets');
    if (extra.length)
      problems.push(`${path.posix.join(OUT_DIR, dirOf(base))}/: unexpected ${extra.join(', ')}`);
  }
}

if (problems.length) {
  console.error(`\n[build-site] build output check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `\n[build-site] OK: ${locales.map((l) => `${l} at ${localeBase(l, tenant.config)}`).join(', ')}`
);
