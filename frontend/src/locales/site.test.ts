import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { loadTenantForBuild } from 'src/tenant/node';

import { localeBase, localeHref, siteLocalesOf, routerBasename } from './site';

// ----------------------------------------------------------------------

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BILINGUAL = { defaultLocale: 'zh-TW', siteLocales: ['zh-TW', 'en'] } as const;
const SINGLE = { defaultLocale: 'zh-TW' } as const;

describe('siteLocalesOf', () => {
  it('ships only the default locale when siteLocales is left out', () => {
    expect(siteLocalesOf(SINGLE)).toEqual(['zh-TW']);
  });

  it('puts the default locale first, whatever order the config lists them in', () => {
    // 第一個 build 輸出到 dist/ 並清空它，所以根目錄的語言一定要先 build。
    expect(siteLocalesOf({ defaultLocale: 'zh-TW', siteLocales: ['en', 'zh-TW'] })).toEqual([
      'zh-TW',
      'en',
    ]);
  });
});

describe('localeBase', () => {
  it('serves the default locale at the site root and the others under /<locale>/', () => {
    expect(localeBase('zh-TW', BILINGUAL)).toBe('/');
    expect(localeBase('en', BILINGUAL)).toBe('/en/');
  });

  it('follows the tenant default, not a fixed language', () => {
    expect(localeBase('en', { defaultLocale: 'en', siteLocales: ['en', 'zh-TW'] })).toBe('/');
    expect(localeBase('zh-TW', { defaultLocale: 'en', siteLocales: ['en', 'zh-TW'] })).toBe(
      '/zh-TW/'
    );
  });
});

describe('routerBasename', () => {
  it('drops the trailing slash so /en itself still matches the router', () => {
    // basename "/en/" 不吃 "/en"：直接打 /en 會落到 404 頁。
    expect(routerBasename('/en/')).toBe('/en');
    expect(routerBasename('/')).toBe('/');
  });
});

describe('localeHref', () => {
  it('maps a Chinese page to the same English page', () => {
    expect(localeHref('/esg', 'en', BILINGUAL)).toBe('/en/esg');
    expect(localeHref('/trader/0xabc', 'en', BILINGUAL)).toBe('/en/trader/0xabc');
  });

  it('maps an English page back to the same Chinese page', () => {
    expect(localeHref('/en/esg', 'zh-TW', BILINGUAL)).toBe('/esg');
    expect(localeHref('/en/trader/0xabc', 'zh-TW', BILINGUAL)).toBe('/trader/0xabc');
  });

  it('maps the two home pages to each other, with or without the trailing slash', () => {
    expect(localeHref('/', 'en', BILINGUAL)).toBe('/en/');
    expect(localeHref('/en/', 'zh-TW', BILINGUAL)).toBe('/');
    expect(localeHref('/en', 'zh-TW', BILINGUAL)).toBe('/');
  });

  it('keeps the query string and the hash', () => {
    expect(localeHref('/esg?asset=sAAPL#detail', 'en', BILINGUAL)).toBe(
      '/en/esg?asset=sAAPL#detail'
    );
    expect(localeHref('/en/esg?asset=sAAPL', 'zh-TW', BILINGUAL)).toBe('/esg?asset=sAAPL');
    // 查詢字串裡的 /en/ 不是語言前綴。
    expect(localeHref('/esg?next=/en/x', 'en', BILINGUAL)).toBe('/en/esg?next=/en/x');
  });

  it('only strips a whole /en segment, not a page that starts with the letters en', () => {
    expect(localeHref('/english', 'en', BILINGUAL)).toBe('/en/english');
  });

  it('stays on the same page when the target is the current language', () => {
    expect(localeHref('/en/esg', 'en', BILINGUAL)).toBe('/en/esg');
    expect(localeHref('/esg', 'zh-TW', BILINGUAL)).toBe('/esg');
  });

  it('has nowhere to go for a language this site does not ship', () => {
    expect(localeHref('/esg', 'en', SINGLE)).toBeNull();
  });
});

// ── vercel.json ──────────────────────────────────────────────────────────

/**
 * 依 vercel.json 的 rewrites 決定一個「不是實體檔案」的網址會拿到哪個檔案。Vercel 先找
 * 實體檔案，找不到才照順序比對 rewrites，第一條對到的生效；沒有一條對到就是 404。
 * 這裡的 source 都是純 regex（沒有 :param），可以直接轉成 RegExp。
 */
function rewriteFor(url: string): string | null {
  const vercel = JSON.parse(fs.readFileSync(path.join(FRONTEND_ROOT, 'vercel.json'), 'utf8')) as {
    rewrites: { source: string; destination: string }[];
  };
  const hit = vercel.rewrites.find((r) => new RegExp(`^${r.source}$`).test(url));
  return hit ? hit.destination : null;
}

describe('vercel.json serves every language of the default tenant', () => {
  const site = loadTenantForBuild(FRONTEND_ROOT, undefined).config;
  const others = siteLocalesOf(site).filter((l) => l !== site.defaultLocale);

  it('the production site ships more than one language', () => {
    expect(others.length).toBeGreaterThan(0);
  });

  it('sends a page refresh to the index.html of the right language', () => {
    expect(rewriteFor('/')).toBe('/index.html');
    expect(rewriteFor('/esg')).toBe('/index.html');
    for (const locale of others) {
      const base = localeBase(locale, site);
      expect(rewriteFor(base.slice(0, -1)), locale).toBe(`${base}index.html`);
      expect(rewriteFor(base), locale).toBe(`${base}index.html`);
      expect(rewriteFor(`${base}esg`), locale).toBe(`${base}index.html`);
      expect(rewriteFor(`${base}trader/0xabc`), locale).toBe(`${base}index.html`);
    }
  });

  it('lets a missing code file 404 instead of answering with HTML', () => {
    // 舊分頁要的 chunk 換版後就不在了。回 index.html 的話瀏覽器拿到一份 HTML 當程式檔，
    // 錯誤變成看不出原因的 MIME type 錯誤；中文站的 HTML 混進英文站更難查。404 才是實話。
    expect(rewriteFor('/assets/index-old.js')).toBeNull();
    for (const locale of others) {
      expect(rewriteFor(`${localeBase(locale, site)}assets/index-old.js`), locale).toBeNull();
    }
  });
});
