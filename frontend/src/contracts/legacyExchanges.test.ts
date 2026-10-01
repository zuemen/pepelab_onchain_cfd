import { getAddress } from 'ethers';
import { it, expect, describe } from 'vitest';

import { CHAIN_MAP } from './addresses';
import { LEGACY_EXCHANGES, legacyExchangesFor } from './legacyExchanges';

import en from '../locales/en';
import zhTW from '../locales/zh-TW';

// ----------------------------------------------------------------------

describe('legacy exchange registry', () => {
  it('every address is a valid, checksummed constant', () => {
    for (const e of LEGACY_EXCHANGES) {
      expect(getAddress(e.address)).toBe(e.address);
    }
  });

  it('has no duplicates', () => {
    const keys = LEGACY_EXCHANGES.map((e) => `${e.chainId}:${e.address.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lists the live exchange of its chain as legacy', () => {
    for (const e of LEGACY_EXCHANGES) {
      const live = CHAIN_MAP[e.chainId]?.PerpetualExchange;
      expect(live, `chain ${e.chainId} must be a chain the frontend knows`).toBeTruthy();
      expect(e.address.toLowerCase()).not.toBe(live.toLowerCase());
    }
  });

  it('lists both retired Base Sepolia exchanges', () => {
    expect(legacyExchangesFor(84532).map((e) => e.address)).toEqual([
      '0xEf75ECA6514cE96B18382E921aC6190a0cF8c072',
      '0xfAEf549C687C37064cEaB5728989a839B08955cf',
    ]);
  });

  it('returns nothing for an unknown or missing chain', () => {
    expect(legacyExchangesFor(null)).toEqual([]);
    expect(legacyExchangesFor(1)).toEqual([]);
  });
});

describe('legacy catalog', () => {
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

  it('en has no Han characters', () => {
    const han = strings(en.legacy).filter((s) => /[一-鿿]/.test(s));
    expect(han).toEqual([]);
  });

  it('zh-TW and en have the same keys', () => {
    const keys = (v: unknown, at = ''): string[] =>
      typeof v === 'string'
        ? [at]
        : Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => keys(x, `${at}.${k}`));
    expect(keys(en.legacy).sort()).toEqual(keys(zhTW.legacy).sort());
  });
});
