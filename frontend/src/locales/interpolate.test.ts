import { it, expect, describe } from 'vitest';

import { interpolate } from './interpolate';

describe('interpolate', () => {
  it('substitutes a named placeholder with the given value', () => {
    expect(interpolate('領取 {token}', { token: 'mUSDC' })).toBe('領取 mUSDC');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(interpolate('{token} 餘額不足，請先領取 {token}', { token: 'mUSDC' })).toBe(
      'mUSDC 餘額不足，請先領取 mUSDC'
    );
  });

  it('leaves the placeholder in place when no value was given for it', () => {
    // 少給變數時留下 `{token}`，而不是印出 "undefined"：前者一眼看得出是漏傳，
    // 後者讀起來像真的內容，會混進畫面沒人發現。
    expect(interpolate('領取 {token}', {})).toBe('領取 {token}');
  });

  it('ignores values that the template does not ask for', () => {
    expect(interpolate('領取代幣', { token: 'mUSDC' })).toBe('領取代幣');
  });

  it('returns a template with no placeholders unchanged', () => {
    expect(interpolate('保證金不足')).toBe('保證金不足');
  });

  it('substitutes numbers as well as strings', () => {
    expect(interpolate('槓桿 {n}x', { n: 5 })).toBe('槓桿 5x');
  });
});
