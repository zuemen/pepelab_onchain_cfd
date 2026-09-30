import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { LOCALES } from 'src/locales/catalogs';
import { readFlag } from 'src/lib/pepefi/flagParse';

import { listTenantIds, loadTenantForBuild } from './node';
import { resolveFeatureFlag, resolveTenantFeatures } from './flags';
import {
  parseTenant,
  FEATURE_KEYS,
  tenantIdFrom,
  TENANT_LOCALES,
  FEATURE_ENV_KEYS,
  TenantConfigError,
} from './schema';

// ----------------------------------------------------------------------

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readTenantJson(id: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(FRONTEND_ROOT, 'src', 'tenant', 'tenants', `${id}.json`), 'utf8')
  );
}

const defaultTenant = loadTenantForBuild(FRONTEND_ROOT, undefined).config;
const demoBank = loadTenantForBuild(FRONTEND_ROOT, 'demo-bank').config;

/** 深拷貝一份合法設定，讓每個負面測試只改一個欄位。 */
function mutated(mutate: (c: Record<string, any>) => void): unknown {
  const c = structuredClone(readTenantJson('demo-bank')) as Record<string, any>;
  mutate(c);
  return c;
}

function expectRejected(raw: unknown, pathFragment: string) {
  let err: unknown;
  try {
    parseTenant(raw, 'demo-bank');
  } catch (e) {
    err = e;
  }
  expect(err, `expected rejection at ${pathFragment}`).toBeInstanceOf(TenantConfigError);
  expect((err as TenantConfigError).issues.join('\n')).toContain(pathFragment);
}

// ── 設定驗證 ─────────────────────────────────────────────────────────────

describe('tenant config validation', () => {
  it('every tenant file in the repo validates and its id matches its file name', () => {
    const ids = listTenantIds(FRONTEND_ROOT);
    expect(ids).toEqual(expect.arrayContaining(['default', 'demo-bank']));
    for (const id of ids) {
      expect(() => parseTenant(readTenantJson(id), id), id).not.toThrow();
    }
  });

  it('ships the same locales as the string catalog', () => {
    expect([...TENANT_LOCALES].sort()).toEqual(Object.keys(LOCALES).sort());
  });

  it('tenant files carry no contract addresses — assets are picked by symbol only', () => {
    for (const id of listTenantIds(FRONTEND_ROOT)) {
      expect(JSON.stringify(readTenantJson(id)), id).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
  });

  it('rejects an unknown field instead of ignoring a typo', () => {
    expectRejected(
      mutated((c) => {
        c.brand.nmae = 'x';
      }),
      'brand'
    );
    expectRejected(
      mutated((c) => {
        c.extra = true;
      }),
      '(root)'
    );
  });

  it('rejects an asset that addresses.ts does not know', () => {
    expectRejected(
      mutated((c) => {
        c.assets.enabled = ['sAAPL', 'sDOGE'];
      }),
      'assets.enabled'
    );
  });

  it('rejects an empty or duplicated asset list', () => {
    expectRejected(
      mutated((c) => {
        c.assets.enabled = [];
      }),
      'assets.enabled'
    );
    expectRejected(
      mutated((c) => {
        c.assets.enabled = ['sAAPL', 'sAAPL'];
      }),
      'assets.enabled'
    );
  });

  it('rejects a feature that defaults on without being allowed', () => {
    expectRejected(
      mutated((c) => {
        c.features.copyTrading = { allowed: false, default: true };
      }),
      'features.copyTrading'
    );
  });

  // 鏈上跟單鏡射交易者的全部部位、無法依資產過濾——有白名單就不能授權跟單。
  it('rejects copy trading for a tenant with an asset whitelist', () => {
    expectRejected(
      mutated((c) => {
        c.features.copyTrading = { allowed: true, default: false };
      }),
      'features.copyTrading.allowed'
    );
  });

  it('allows copy trading only when every asset is enabled', () => {
    const raw = mutated((c) => {
      c.assets.enabled = 'all';
      c.features.copyTrading = { allowed: true, default: false };
    });
    expect(() => parseTenant(raw, 'demo-bank')).not.toThrow();
  });

  it('rejects a missing feature key', () => {
    expectRejected(
      mutated((c) => {
        delete c.features.gamefi;
      }),
      'features.gamefi'
    );
  });

  it('only accepts site-local image paths (CSP img-src is self)', () => {
    expectRejected(
      mutated((c) => {
        c.brand.logo.src = 'https://cdn.example.com/logo.png';
      }),
      'brand.logo.src'
    );
    expectRejected(
      mutated((c) => {
        c.brand.logo.src = '//evil.example/logo.png';
      }),
      'brand.logo.src'
    );
    expectRejected(
      mutated((c) => {
        c.brand.favicon = '/tenants/../../secret.png';
      }),
      'brand.favicon'
    );
  });

  it('only accepts https links for support and legal', () => {
    expectRejected(
      mutated((c) => {
        c.legal.links[0].href = 'javascript:alert(1)';
      }),
      'legal.links.0.href'
    );
    expectRejected(
      mutated((c) => {
        c.support.url = 'http://example.com';
      }),
      'support.url'
    );
  });

  it('rejects brand text that would act as a catalog placeholder or markup', () => {
    expectRejected(
      mutated((c) => {
        c.brand.name = 'Evil {brand}';
      }),
      'brand.name'
    );
    expectRejected(
      mutated((c) => {
        c.brand.name = '<script>';
      }),
      'brand.name'
    );
  });

  it('keeps Han characters out of en text (same rule as the en catalog)', () => {
    expectRejected(
      mutated((c) => {
        c.compliance.operatorName.en = '示範銀行';
      }),
      'compliance.operatorName.en'
    );
  });

  it('requires the same number of extra disclosures in both locales', () => {
    expectRejected(
      mutated((c) => {
        c.compliance.additionalDisclosures.en.push('extra');
      }),
      'compliance.additionalDisclosures'
    );
  });

  it('rejects a colour that is not #RRGGBB', () => {
    expectRejected(
      mutated((c) => {
        c.theme.primary.main = 'blue';
      }),
      'theme.primary.main'
    );
  });

  it('rejects a config whose id does not match the selected tenant', () => {
    expect(() => parseTenant(readTenantJson('default'), 'demo-bank')).toThrow(TenantConfigError);
  });

  it('rejects an unknown schema version', () => {
    expectRejected(
      mutated((c) => {
        c.schemaVersion = 2;
      }),
      'schemaVersion'
    );
  });
});

describe('tenant selection (VITE_TENANT) fails closed', () => {
  it('means default when nothing is set', () => {
    expect(tenantIdFrom(undefined)).toBe('default');
    expect(tenantIdFrom('')).toBe('default');
    expect(tenantIdFrom('  ')).toBe('default');
  });

  it('refuses ids that are not a plain slug instead of falling back to default', () => {
    expect(() => tenantIdFrom('Demo-Bank')).toThrow(TenantConfigError);
    expect(() => tenantIdFrom('../default')).toThrow(TenantConfigError);
  });

  it('refuses a tenant with no config file instead of falling back to default', () => {
    expect(() => loadTenantForBuild(FRONTEND_ROOT, 'no-such-bank')).toThrow(/no config file/);
  });
});

// ── 功能旗標 ─────────────────────────────────────────────────────────────

describe('feature flags: tenant ceiling x env', () => {
  const RAW_VALUES = [undefined, '', '1', 'true', 'on', 'TRUE', '0', 'false', 'yes', 'off'];

  it('env can never open a feature the tenant has not allowed', () => {
    for (const raw of RAW_VALUES) {
      expect(resolveFeatureFlag({ allowed: false, default: false }, raw)).toBe(false);
    }
  });

  it('env can switch off a feature the tenant has on by default', () => {
    expect(resolveFeatureFlag({ allowed: true, default: true }, undefined)).toBe(true);
    expect(resolveFeatureFlag({ allowed: true, default: true }, '0')).toBe(false);
  });

  it('for the default tenant, every flag behaves exactly like readFlag(env, false) did', () => {
    for (const key of FEATURE_KEYS) {
      for (const raw of RAW_VALUES) {
        const got = resolveTenantFeatures(defaultTenant, { [FEATURE_ENV_KEYS[key]]: raw })[key];
        expect(got, `${key}=${String(raw)}`).toBe(readFlag(raw, false));
      }
    }
  });

  it('demo-bank cannot turn on retail features from env', () => {
    const allOn = Object.fromEntries(Object.values(FEATURE_ENV_KEYS).map((k) => [k, '1']));
    expect(Object.values(resolveTenantFeatures(demoBank, allOn))).toEqual(
      FEATURE_KEYS.map(() => false)
    );
  });
});
