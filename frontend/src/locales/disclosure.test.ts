import { it, expect, describe } from 'vitest';

import { LOCALES } from './catalogs';

// 合成資產揭露的必要內容。文案可以改寫，但這幾個事實陳述不能在改寫時掉出去——
// 少了任何一項，揭露就不再準確。
describe('synthetic-asset disclosure copy', () => {
  const zh = LOCALES['zh-TW'].catalog.common.disclosure;
  const en = LOCALES.en.catalog.common.disclosure;

  it('zh-TW states testnet, no real assets, under-collateralized synthetic, no shareholder rights, not advice', () => {
    const all = Object.values(zh).join('\n');
    for (const must of ['測試網', '研究原型', '非足額抵押', '合成曝險', '不具股東', '不構成投資建議']) {
      expect(all, must).toContain(must);
    }
  });

  it('en states the same facts', () => {
    const all = Object.values(en).join('\n');
    for (const must of ['testnet', 'research prototype', 'under-collateralized', 'synthetic exposure', 'no shareholder', 'investment advice']) {
      expect(all, must).toContain(must);
    }
  });
});
