import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';

import { flagStateLabel, readSolvencyFlags, solvencyDisclosure } from './solvencyFlags';

describe('solvency disclosure on the agent monitor page', () => {
  // 2026-10-02：揭露框寫「ADL 本測試網部署目前預設關閉」，但 Base Sepolia 上
  // PerpetualExchange.adlEnabled() 是 true。
  it('states what the chain says, not a hard-coded default', () => {
    const text = solvencyDisclosure({ adl: true });
    expect(text).toContain('ADL 已啟用');
    // 合約已移除組合保證金：不能再說它已實作，也不能說它可以開關。
    expect(text).toContain('組合保證金模式已從合約移除');
    expect(text).not.toContain('{portfolioMargin}');
    expect(text).not.toMatch(/預設關閉/);
  });

  it('never guesses: loading and unreadable flags say so', () => {
    expect(flagStateLabel(undefined)).toBe('讀取中…');
    expect(flagStateLabel(null)).toBe('無法讀取');
    expect(solvencyDisclosure({ adl: null })).toContain('ADL 無法讀取');
  });

  it.each(['zh-TW', 'en'] as const)(
    '%s: the catalog text carries no on/off state of its own',
    (code) => {
      const text = LOCALES[code].catalog.admin.agent.disclosure;
      expect(text).toContain('{adl}');
      expect(text).not.toContain('{portfolioMargin}');
      expect(text).not.toMatch(/預設關閉|目前預設|disabled by default/);
    }
  );

  it('reads the ADL flag from the exchange and reports a failed read as unknown', async () => {
    expect(await readSolvencyFlags({ adlEnabled: async () => true })).toEqual({ adl: true });
    expect(
      await readSolvencyFlags({
        adlEnabled: async () => {
          throw new Error('revert');
        },
      })
    ).toEqual({ adl: null });
    expect(await readSolvencyFlags(null)).toEqual({ adl: null });
  });
});
