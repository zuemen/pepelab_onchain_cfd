import { it, expect, describe } from 'vitest';

import { paths } from 'src/routes/paths';

import { isPublicPath } from './publicPaths';

describe('isPublicPath', () => {
  it.each([
    paths.pepefi.landing,
    paths.pepefi.x402,
    paths.pepefi.marketplace,
    paths.pepefi.rwa,
    paths.pepefi.oracle,
    paths.pepefi.solvency,
    paths.pepefi.lab,
  ])('%s opens without a wallet', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([paths.pepefi.portfolio, paths.pepefi.whale, paths.pepefi.terminal, '/copy/0xabc', '/trader/0xabc'])(
    '%s needs a wallet',
    (path) => {
      expect(isPublicPath(path)).toBe(false);
    }
  );
});
