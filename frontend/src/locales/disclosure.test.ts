import type { AssetCategory } from 'src/lib/pepefi/assetMeta';

import { it, expect, describe } from 'vitest';

import { ASSET_IDS } from 'src/contracts/addresses';
import { ASSET_META } from 'src/lib/pepefi/assetMeta';

import { LOCALES } from './catalogs';

// 合成資產揭露的必要內容。文案可以改寫，但這幾個事實陳述不能在改寫時掉出去——
// 少了任何一項，揭露就不再準確。
describe('synthetic-asset disclosure copy', () => {
  const zh = LOCALES['zh-TW'].catalog.common.disclosure;
  const en = LOCALES.en.catalog.common.disclosure;
  const zhAll = Object.values(zh).join('\n');
  const enAll = Object.values(en).join('\n');

  it('zh-TW states testnet, no real assets, AssetVault under-collateralized synthetic, no holder rights, not advice', () => {
    for (const must of ['測試網', '研究原型', 'AssetVault', '非足額抵押', '合成曝險', '不具股東', '不構成投資建議']) {
      expect(zhAll, must).toContain(must);
    }
  });

  it('en states the same facts', () => {
    for (const must of [
      'testnet',
      'research prototype',
      'AssetVault',
      'under-collateralized',
      'synthetic exposure',
      'no shareholder',
      'investment advice',
    ]) {
      expect(enAll, must).toContain(must);
    }
  });

  // 揭露必須涵蓋本站「所有」合成代幣的資產類別，不只股債。類別清單直接從
  // ASSET_META 推出來：新增一個類別（或一檔新類別的代幣）卻沒改揭露，這裡就會失敗。
  const CATEGORY_WORDS: Record<AssetCategory, { zh: string; en: string }> = {
    equity: { zh: '股票', en: 'equities' },
    bond: { zh: '債券', en: 'bonds' },
    commodity: { zh: '黃金', en: 'gold' },
    crypto: { zh: '加密資產', en: 'crypto' },
    etf: { zh: 'ETF', en: 'ETFs' },
  };
  const liveCategories = [
    ...new Set(Object.values(ASSET_IDS).map((id) => ASSET_META[id]?.category).filter(Boolean)),
  ] as AssetCategory[];

  it('the site actually has all five asset classes (guards the list below)', () => {
    expect([...liveCategories].sort()).toEqual(['bond', 'commodity', 'crypto', 'equity', 'etf']);
  });

  it.each(liveCategories)('covers asset class %s in both locales', (category) => {
    const words = CATEGORY_WORDS[category];
    expect(words, `no wording defined for ${category}`).toBeDefined();
    expect(zhAll).toContain(words.zh);
    expect(enAll).toContain(words.en);
  });

  it.each(liveCategories)('names at least one %s ticker in both locales', (category) => {
    const tickers = Object.values(ASSET_IDS)
      .map((id) => ASSET_META[id])
      .filter((m) => m?.category === category)
      .map((m) => m.symbol);
    expect(tickers.some((s) => zhAll.includes(s)), `${category}: ${tickers.join(',')}`).toBe(true);
    expect(tickers.some((s) => enAll.includes(s)), `${category}: ${tickers.join(',')}`).toBe(true);
  });
});
