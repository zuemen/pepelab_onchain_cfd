import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';

import { custodyContent } from './custody';

// ----------------------------------------------------------------------

/** 一段內容裡所有會顯示的字串。 */
const allText = (c: ReturnType<typeof custodyContent>): string[] => [
  c.heading,
  c.intro,
  ...c.facts,
  c.operatorHeading,
  ...c.operator,
  c.whyHeading,
  c.why,
  ...(c.difference ? [c.difference.heading, ...c.difference.items] : []),
];

const COPY_WORDS = { 'zh-TW': /跟單|跟隨/, en: /copy|follow/i } as const;

describe.each(['zh-TW', 'en'] as const)('custodyContent（%s）', (code) => {
  const catalog = LOCALES[code].catalog.custody;

  it('兩種模式都有說明，而且都列出營運方保有的權限', () => {
    for (const mode of ['simple', 'expert'] as const) {
      for (const copyTrading of [true, false]) {
        const c = custodyContent(mode, copyTrading, catalog);
        expect(c.facts.length, `${mode}/${copyTrading}`).toBeGreaterThan(0);
        expect(c.operator.length, `${mode}/${copyTrading}`).toBeGreaterThan(0);
        expect(c.why, `${mode}/${copyTrading}`).not.toBe('');
      }
    }
  });

  it('Simple 模式用自己的詞彙：跟單旗標開著也一樣', () => {
    expect(custodyContent('simple', true, catalog)).toEqual(custodyContent('simple', false, catalog));
    expect(custodyContent('simple', true, catalog).intro).toBe(catalog.simple.intro);
  });

  it('Expert 模式＋跟單開啟：說明跟單部位在誰名下，並寫出與 eToro 的差別', () => {
    const c = custodyContent('expert', true, catalog);
    expect(c.facts).toContain(catalog.expert.facts.copy);
    expect(c.difference?.heading).toBe(catalog.expert.differenceHeading);
    expect(c.difference?.items).toEqual(Object.values(catalog.expert.difference));
  });

  it('Expert 模式＋跟單關閉：不介紹一個看不到的功能', () => {
    const c = custodyContent('expert', false, catalog);
    expect(c.facts).not.toContain(catalog.expert.facts.copy);
    expect(c.difference).toBeNull();
    expect(allText(c).filter((s) => COPY_WORDS[code].test(s))).toEqual([]);
  });
});
