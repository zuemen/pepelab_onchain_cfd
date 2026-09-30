import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { t, locale } from 'src/locales';
import { LOCALES } from 'src/locales/catalogs';
import { ASSET_IDS } from 'src/contracts/addresses';
import { themeConfig } from 'src/theme/theme-config';
import {
  FEATURES,
  SHOW_LEVERAGE,
  SHOW_PERPETUALS,
  PERPETUALS_AUTHORIZED,
} from 'src/lib/pepefi/featureFlags';

import { loadTenantForBuild } from './node';
import { tenantFooterLinks } from './footer';
import { tenant, assetPolicy } from './index';
import { resolveTenantFeatures } from './flags';
import { applyBrand, brandCatalog } from './brand';
import { tenantDisclosureAdditions } from './disclosure';
import { TENANT_LOCALES, type TenantConfig } from './schema';

// ----------------------------------------------------------------------

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaultTenant = loadTenantForBuild(FRONTEND_ROOT, undefined).config;
const demoBank = loadTenantForBuild(FRONTEND_ROOT, 'demo-bank').config;

// ── 品牌、揭露、頁尾 ─────────────────────────────────────────────────────

describe('brand placeholders', () => {
  it('only touches {brand} and {brandMark}, leaving other placeholders to interpolate()', () => {
    expect(applyBrand('{brand} quotes {price} {brandMark}', { name: 'X', mark: '*' })).toBe(
      'X quotes {price} *'
    );
  });

  it('leaves no brand placeholder behind in either catalog, for any tenant', () => {
    for (const cfg of [defaultTenant, demoBank]) {
      for (const code of TENANT_LOCALES) {
        const json = JSON.stringify(brandCatalog(LOCALES[code].catalog, cfg.brand));
        expect(json).not.toMatch(/\{brand(Mark)?\}/);
      }
    }
  });

  it('a non-default tenant shows its own name wherever the platform names itself', () => {
    const zh = brandCatalog(LOCALES['zh-TW'].catalog, demoBank.brand);
    expect(zh.meta.title).toBe('Demo Bank · Agent 原生代幣化 RWA');
    expect(zh.nav.section.pepelab).toBe('Demo Bank');
    expect(zh.landing.enterDashboard).toBe('🏦 進入 Dashboard');
  });
});

describe('disclosure additions', () => {
  it('default tenant adds nothing', () => {
    expect(tenantDisclosureAdditions(defaultTenant.compliance, 'zh-TW', 'x {operator}')).toEqual({
      operatorLine: null,
      items: [],
    });
  });

  it('a tenant can only append: operator line and extra items, per locale', () => {
    const zh = tenantDisclosureAdditions(
      demoBank.compliance,
      'zh-TW',
      LOCALES['zh-TW'].catalog.common.disclosure.operatedBy
    );
    expect(zh.operatorLine).toBe('本站由示範銀行（虛構機構，僅供白標展示）營運。');
    expect(zh.items).toHaveLength(1);
    const en = tenantDisclosureAdditions(
      demoBank.compliance,
      'en',
      LOCALES.en.catalog.common.disclosure.operatedBy
    );
    expect(en.operatorLine).toMatch(/^This site is operated by Demo Bank/);
  });
});

describe('footer links', () => {
  it('default tenant has none, so the footer does not render', () => {
    expect(tenantFooterLinks(defaultTenant, 'zh-TW', 'Support')).toEqual([]);
  });

  it('demo-bank lists support url, mailto and legal links', () => {
    const links = tenantFooterLinks(demoBank, 'en', 'Support');
    expect(links.map((l) => l.href)).toEqual([
      'https://example.com/support',
      'mailto:support@example.com',
      'https://example.com/terms',
      'https://example.com/privacy',
      'https://example.com/risk',
    ]);
  });
});

// ── default 租戶：正式站外觀與行為不變 ──────────────────────────────────

describe('default tenant is the current production site, unchanged', () => {
  it('is the tenant the test build (and an unset VITE_TENANT) resolves to', () => {
    expect(tenant.id).toBe('default');
    expect(tenant).toEqual(defaultTenant satisfies TenantConfig);
  });

  it('keeps the original PepeLab palette', () => {
    expect(themeConfig.palette.primary).toEqual({
      lighter: '#ddf5b9',
      light: '#a8d96a',
      main: '#7cc14a',
      dark: '#5a9e2f',
      darker: '#2e5c16',
      contrastText: '#1C252E',
    });
    expect(themeConfig.palette.secondary).toEqual({
      lighter: '#FFF5CC',
      light: '#FFE566',
      main: '#FFD23D',
      dark: '#CC9900',
      darker: '#805E00',
      contrastText: '#1C252E',
    });
  });

  it('keeps the original locale, flags and asset list', () => {
    expect(locale).toBe('zh-TW');
    expect(FEATURES).toEqual({ gamefi: false, pepeRewards: false, copyTrading: false });
    expect(SHOW_LEVERAGE).toBe(false);
    expect(SHOW_PERPETUALS).toBe(false);
    expect(PERPETUALS_AUTHORIZED).toBe(true);
    expect(assetPolicy.enabledSymbols).toEqual(Object.keys(ASSET_IDS));
  });

  // 改版前寫死在 catalog 裡的原文。{brand}/{brandMark} 代換之後必須逐字相同。
  const ORIGINAL = {
    'zh-TW': {
      'meta.title': 'PepeLab · Agent 原生代幣化 RWA',
      'meta.description':
        'PepeLab — 基於 Base 鏈的 Agent 原生代幣化 RWA 平台。鏈上買賣股債金幣 + x402 付費訊號 + 社交跟單。',
      'meta.descriptionNoCopy':
        'PepeLab — 基於 Base 鏈的 Agent 原生代幣化資產引擎（測試網研究原型）。鏈上鑄造與贖回合成股債金幣 + x402 付費訊號 + agent session 委任。',
      'common.wallet.intro': '選擇您的登入通道以進入 PepeLab 鏈上 RWA 平台。',
      'exchange.guide.spotTitle': '在 PepeLab 上買賣代幣化資產',
      'x402.docs.how.ask.body': '助理向 PepeLab 要一筆資料，例如某位交易者的下一步。',
      'x402.docs.how.quote.title': 'PepeLab 報價',
      'nav.section.pepelab': 'PepeLab',
      'landing.tagline': 'RWA · 代幣化資產 · 社交跟單 🐸',
      'landing.enterDashboard': '🐸 進入 Dashboard',
      'landing.copyOff.tagline': 'RWA · 代幣化資產 · Agent 原生 🐸',
    },
    en: {
      'meta.title': 'PepeLab · Agent-Native Tokenized RWA',
      'meta.description':
        'PepeLab — agent-native tokenized RWA on Base. Buy equities, bonds, gold, and crypto on-chain + x402 paid signals + social copy trading.',
      'meta.descriptionNoCopy':
        'PepeLab — an agent-native tokenized-asset engine on Base (testnet research prototype). Mint and redeem synthetic equities, bonds, gold and crypto on-chain + x402 paid signals + bounded agent sessions.',
      'common.wallet.intro':
        'Choose your sign-in channel to enter the PepeLab on-chain RWA platform.',
      'exchange.guide.spotTitle': 'How to buy and sell tokenized assets on PepeLab',
      'x402.docs.how.ask.body':
        'Your assistant asks PepeLab for a piece of data, such as a trader’s next move.',
      'x402.docs.how.quote.title': 'PepeLab quotes a price',
      'nav.section.pepelab': 'PepeLab',
      'landing.tagline': 'RWA · Tokenized Assets · Social Copy Trading 🐸',
      'landing.enterDashboard': '🐸 Enter Dashboard',
      'landing.copyOff.tagline': 'RWA · Tokenized Assets · Agent-Native 🐸',
    },
  } as const;

  const at = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

  /** catalog 中所有字串的 [路徑, 值]。 */
  const flatten = (node: unknown, prefix = ''): [string, string][] => {
    if (typeof node === 'string') return [[prefix, node]];
    if (node && typeof node === 'object') {
      return Object.entries(node).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
    }
    return [];
  };

  it.each(TENANT_LOCALES)('%s: every branded string reads exactly as before', (code) => {
    const branded = brandCatalog(LOCALES[code].catalog, defaultTenant.brand);
    for (const [key, original] of Object.entries(ORIGINAL[code])) {
      expect(at(branded, key), key).toBe(original);
    }
    // 反方向：catalog 裡**所有**帶品牌佔位符的字串都列在上面，沒有漏驗的。
    const withPlaceholder = flatten(LOCALES[code].catalog)
      .filter(([, v]) => /\{brand(Mark)?\}/.test(v))
      .map(([k]) => k)
      .sort();
    expect(withPlaceholder).toEqual(Object.keys(ORIGINAL[code]).sort());
  });

  it('the running catalog is the branded one', () => {
    expect(t.meta.title).toBe(ORIGINAL['zh-TW']['meta.title']);
  });

  it('matches the recorded snapshot of everything a default build derives from the tenant', () => {
    expect({
      id: tenant.id,
      brand: tenant.brand,
      theme: tenant.theme,
      defaultLocale: tenant.defaultLocale,
      enabledSymbols: assetPolicy.enabledSymbols,
      flagsWithNoEnv: resolveTenantFeatures(tenant, {}),
      perpetualsAuthorized: PERPETUALS_AUTHORIZED,
      disclosure: tenantDisclosureAdditions(tenant.compliance, 'zh-TW', 'x {operator}'),
      footer: tenantFooterLinks(tenant, 'zh-TW', 'x'),
      palette: { primary: themeConfig.palette.primary, secondary: themeConfig.palette.secondary },
    }).toMatchSnapshot();
  });
});
