import { it, expect, describe } from 'vitest';

import { LOCALES, pickLocale, DEFAULT_LOCALE } from './catalogs';

describe('pickLocale', () => {
  it('accepts a locale we ship', () => {
    expect(pickLocale('en')).toBe('en');
    expect(pickLocale('zh-TW')).toBe('zh-TW');
  });

  it('accepts a locale we ship whatever its case', () => {
    // VITE_LOCALE 是部署設定，會有人在 Vercel 的欄位裡打 "EN"。認得出來的大小寫
    // 就不要因此靜悄悄蓋成中文站——那種錯只有在別人回報時才會發現。
    expect(pickLocale('EN')).toBe('en');
    expect(pickLocale('zh-tw')).toBe('zh-TW');
  });

  it('falls back to the default locale when nothing was set', () => {
    expect(pickLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(pickLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('falls back to the default locale for a language we do not ship', () => {
    expect(pickLocale('fr')).toBe(DEFAULT_LOCALE);
    expect(pickLocale('zh-CN')).toBe(DEFAULT_LOCALE);
  });
});

describe('LOCALES', () => {
  it('gives every shipped locale a document language for the html element', () => {
    expect(LOCALES['zh-TW'].htmlLang).toBe('zh-Hant');
    expect(LOCALES.en.htmlLang).toBe('en');
  });

  it('defaults to Traditional Chinese', () => {
    expect(DEFAULT_LOCALE).toBe('zh-TW');
  });
});
