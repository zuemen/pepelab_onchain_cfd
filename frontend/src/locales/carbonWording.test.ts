import { it, expect, describe } from 'vitest';

import { LOCALES } from './catalogs';

// ----------------------------------------------------------------------

/**
 * #333：碳權退役相關的字串不得出現「抵銷」「碳中和」。
 *
 * 退役的受益人是平台，而且是模擬碳權（ADR-022）：寫「你抵銷了 X 噸」會讓一噸被兩方宣稱，
 * 寫「碳中和」則是綠色行銷規範（例如歐盟指令 2024/825）不允許只靠碳權做的宣稱。畫面只說「退役」
 * 與「促成平台退役」。CONTEXT.md 的 Simulated Carbon Credit 詞條把這些字列為 Avoid。
 */
const ZH = /抵銷|抵消|碳中和|淨零/;
const EN = /offset|carbon[- ]neutral|net[- ]zero|climate[- ]neutral/i;

/** 退役相關的區塊：ESG 頁的退役卡、交易者頁與投資組合的影響卡、跟單前的退役估算。 */
const SECTIONS: ReadonlyArray<[string, (catalog: Record<string, any>) => unknown]> = [
  ['esg.retirement', (c) => c.esg.retirement],
  ['esg.impact', (c) => c.esg.impact],
  ['copy.retirementEstimate', (c) => c.copy.retirementEstimate],
];

/**
 * 唯一的例外：ADR-022 的模擬聲明本身。它要用否定句明說「銷毀它不抵銷任何真實排放」——那正是這條
 * 守門要保護的事實，改寫成別的說法反而變弱（下面另有一條測試釘住它還在）。
 */
const EXEMPT = new Set(['esg.retirement.disclaimer']);

function strings(node: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
  if (typeof node === 'string') out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
  }
  return out;
}

describe('retirement wording', () => {
  for (const [code, { catalog }] of Object.entries(LOCALES)) {
    const all = SECTIONS.flatMap(([path, pick]) => strings(pick(catalog as Record<string, any>), path, [])).filter(
      ([path]) => !EXEMPT.has(path),
    );

    it(`${code}: every retirement section exists and has text`, () => {
      for (const [, pick] of SECTIONS) expect(pick(catalog as Record<string, any>)).toBeTruthy();
      expect(all.length).toBeGreaterThan(10);
    });

    it(`${code}: never says offset or carbon neutral`, () => {
      const bad = all.filter(([, s]) => ZH.test(s) || EN.test(s));
      expect(bad).toEqual([]);
    });
  }

  it('the estimate says the tonnes are the platform’s and that it is an estimate', () => {
    const zh = Object.values(LOCALES['zh-TW'].catalog.copy.retirementEstimate).join('\n');
    const en = Object.values(LOCALES.en.catalog.copy.retirementEstimate).join('\n');
    for (const must of ['平台', '估算', '模擬碳權']) expect(zh).toContain(must);
    for (const must of ['platform', 'estimate', 'simulated']) expect(en.toLowerCase()).toContain(must);
  });

  it('the exempt disclaimer still says burning the credit offsets nothing (ADR-022)', () => {
    expect(LOCALES['zh-TW'].catalog.esg.retirement.disclaimer).toContain('不抵銷任何真實');
    expect(LOCALES.en.catalog.esg.retirement.disclaimer).toContain('offsets no real');
  });

  it('the retirement card names the beneficiary rule in both languages', () => {
    expect(LOCALES['zh-TW'].catalog.esg.retirement.beneficiary).toContain('歸屬平台');
    expect(LOCALES.en.catalog.esg.retirement.beneficiary).toContain('belong to the platform');
  });
});
