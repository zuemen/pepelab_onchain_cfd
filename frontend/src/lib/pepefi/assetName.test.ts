import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';

import { ASSET_META } from './assetMeta';
import { underlyingLabel, assetDisplayName } from './assetName';

const HAN = /[一-鿿]/;

describe('assetDisplayName', () => {
  it('every tradable asset has a catalog name in both locales', () => {
    for (const meta of Object.values(ASSET_META)) {
      if (!meta.provenance) continue; // PEPE 是平台工具代幣，不是追蹤標的
      expect(LOCALES['zh-TW'].catalog.tokens.assetName, meta.symbol).toHaveProperty(meta.symbol);
      expect(LOCALES.en.catalog.tokens.assetName, meta.symbol).toHaveProperty(meta.symbol);
    }
  });

  it('zh-TW names are Chinese, en names are the original English names', () => {
    for (const meta of Object.values(ASSET_META)) {
      if (!meta.provenance) continue;
      const zh = (LOCALES['zh-TW'].catalog.tokens.assetName as Record<string, string>)[meta.symbol];
      const en = (LOCALES.en.catalog.tokens.assetName as Record<string, string>)[meta.symbol];
      expect(zh, meta.symbol).toMatch(HAN);
      expect(en, meta.symbol).toBe(meta.name);
    }
  });

  it('falls back to meta.name for an asset the catalog does not know', () => {
    expect(assetDisplayName({ symbol: 'sNEW', name: 'Synthetic New' })).toBe('Synthetic New');
    expect(assetDisplayName(undefined)).toBe('');
  });
});

describe('underlyingLabel', () => {
  it('translates only the "Spot" suffix and keeps the ticker', () => {
    expect(underlyingLabel('ETH Spot')).toBe('ETH 現貨');
    expect(underlyingLabel('BTC Spot')).toBe('BTC 現貨');
  });

  it('leaves exchange tickers and product names as they are', () => {
    expect(underlyingLabel('AAPL')).toBe('AAPL');
    expect(underlyingLabel('GC=F (COMEX Gold Futures)')).toBe('GC=F (COMEX Gold Futures)');
  });
});
