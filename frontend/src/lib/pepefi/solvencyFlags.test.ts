import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';

import { flagStateLabel, readSolvencyFlags, solvencyDisclosure } from './solvencyFlags';

describe('solvency disclosure on the agent monitor page', () => {
  // 2026-10-02：揭露框寫「ADL 本測試網部署目前預設關閉」，但 Base Sepolia 上
  // PerpetualExchange.adlEnabled() 是 true（portfolioMarginEnabled() 是 false）。
  it('states what the chain says, not a hard-coded default', () => {
    const text = solvencyDisclosure({ adl: true, portfolioMargin: false });
    expect(text).toContain('ADL 已啟用');
    expect(text).toContain('組合保證金 未啟用');
    expect(text).not.toMatch(/預設關閉/);
  });

  it('never guesses: loading and unreadable flags say so', () => {
    expect(flagStateLabel(undefined)).toBe('讀取中…');
    expect(flagStateLabel(null)).toBe('無法讀取');
    expect(solvencyDisclosure({ adl: null, portfolioMargin: undefined })).toContain('ADL 無法讀取');
  });

  it.each(['zh-TW', 'en'] as const)(
    '%s: the catalog text carries no on/off state of its own',
    (code) => {
      const text = LOCALES[code].catalog.admin.agent.disclosure;
      expect(text).toContain('{adl}');
      expect(text).toContain('{portfolioMargin}');
      expect(text).not.toMatch(/預設關閉|目前預設|disabled by default/);
    }
  );

  it('reads both flags from the exchange, each isolated from the other’s failure', async () => {
    expect(
      await readSolvencyFlags({
        adlEnabled: async () => true,
        portfolioMarginEnabled: async () => {
          throw new Error('revert');
        },
      })
    ).toEqual({ adl: true, portfolioMargin: null });
    expect(await readSolvencyFlags(null)).toEqual({ adl: null, portfolioMargin: null });
  });
});
