import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { ASSET_IDS } from 'src/contracts/addresses';
import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta';

import {} from './schema';
import { loadTenantForBuild } from './node';
import {
  makeAssetPolicy,
  perpetualOpenBlock,
  applyAssetWhitelist,
  sessionAssetsForTenant,
} from './assetPolicy';

// ----------------------------------------------------------------------

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaultTenant = loadTenantForBuild(FRONTEND_ROOT, undefined).config;
const demoBank = loadTenantForBuild(FRONTEND_ROOT, 'demo-bank').config;

// ── 資產白名單 ───────────────────────────────────────────────────────────

describe('asset whitelist', () => {
  const allPolicy = makeAssetPolicy(defaultTenant);
  const bankPolicy = makeAssetPolicy(demoBank);

  it('"all" enables every asset addresses.ts knows, in ASSET_IDS order', () => {
    expect(allPolicy.enabledSymbols).toEqual(Object.keys(ASSET_IDS));
  });

  it('matches by symbol and by asset id (case-insensitive), and rejects unknown assets', () => {
    expect(bankPolicy.canOpen('sAAPL')).toBe(true);
    expect(bankPolicy.canOpen(ASSET_IDS.sAAPL)).toBe(true);
    expect(bankPolicy.canOpen(ASSET_IDS.sAAPL.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(bankPolicy.canOpen('sBTC')).toBe(false);
    expect(bankPolicy.canOpen(ASSET_IDS.sBTC)).toBe(false);
    expect(bankPolicy.canOpen('0xdeadbeef')).toBe(false);
    expect(bankPolicy.canOpen('')).toBe(false);
  });

  it('filters the selectable markets on the trading screens', () => {
    const symbols = bankPolicy.selectable(ASSETS_LIST).map((a) => a.symbol);
    expect(symbols).toEqual(['sAAPL', 'sGOLD', 'sBOND', 'sNVDA', 'sMSFT', 'sICLN', 'sESGU']);
    expect(allPolicy.selectable(ASSETS_LIST)).toHaveLength(ASSETS_LIST.length);
  });

  it('blocks new perpetual positions outside the whitelist or without authorization', () => {
    expect(perpetualOpenBlock(allPolicy, true, ASSET_IDS.sBTC)).toBeNull();
    expect(perpetualOpenBlock(bankPolicy, true, ASSET_IDS.sBTC)).toBe('assetNotEnabled');
    expect(perpetualOpenBlock(bankPolicy, false, ASSET_IDS.sAAPL)).toBe('perpetualsNotAuthorized');
  });

  it('never produces an empty agent-session asset list (the contract reads [] as "all")', () => {
    expect(sessionAssetsForTenant(allPolicy, [ASSET_IDS.sBTC, ASSET_IDS.sETH])).toEqual([
      ASSET_IDS.sBTC,
      ASSET_IDS.sETH,
    ]);
    expect(sessionAssetsForTenant(bankPolicy, [ASSET_IDS.sBTC, ASSET_IDS.sETH])).toEqual([
      ASSET_IDS.sAAPL,
    ]);
  });
});

describe('exits are never blocked by the whitelist', () => {
  const bankPolicy = makeAssetPolicy(demoBank);
  const row = (symbol: string, balance: bigint, canSell = balance > 0n) => ({
    symbol,
    balance,
    canBuy: true,
    canSell,
  });

  it('keeps a whitelisted row untouched', () => {
    expect(applyAssetWhitelist([row('sAAPL', 0n)], bankPolicy)).toEqual([
      { ...row('sAAPL', 0n), enabled: true },
    ]);
  });

  it('keeps a delisted asset the user still holds: buy off, sell exactly as the vault allows', () => {
    const [held] = applyAssetWhitelist([row('sBTC', 5n)], bankPolicy);
    expect(held).toMatchObject({ symbol: 'sBTC', enabled: false, canBuy: false, canSell: true });
    // 金庫暫停時 canSell 本來就是 false——白名單不把它改回 true，也不把 true 改成 false。
    const [paused] = applyAssetWhitelist([row('sBTC', 5n, false)], bankPolicy);
    expect(paused.canSell).toBe(false);
  });

  it('hides a delisted asset only when there is nothing to exit', () => {
    expect(applyAssetWhitelist([row('sBTC', 0n)], bankPolicy)).toEqual([]);
  });

  // 出場路徑（平倉、贖回）的程式碼不得引用租戶政策。用原始碼掃描守住：以後有人在
  // 平倉按鈕上加一個白名單判斷，這裡就會紅。
  const src = (rel: string) => fs.readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8');

  it.each([
    'src/pages/pepefi/PortfolioPage.tsx',
    'src/sections/terminal/positions/PositionsTable.tsx',
    'src/lib/pepefi/closeGuard.ts',
  ])('%s (close path) does not consult the tenant policy', (rel) => {
    const code = src(rel);
    expect(code).toContain(rel.endsWith('closeGuard.ts') ? 'export' : 'closePosition(');
    expect(code).not.toMatch(/src\/tenant|assetPolicy|PERPETUALS_AUTHORIZED/);
  });

  it('the tokens page redeem handler does not consult the whitelist', () => {
    const code = src('src/pages/pepefi/TokenizedAssetsPage.tsx');
    const start = code.indexOf('const doSell = async');
    const end = code.indexOf('const addToWallet', start);
    expect(start).toBeGreaterThan(0);
    const doSell = code.slice(start, end);
    expect(doSell).toContain('.redeem(');
    expect(doSell).not.toMatch(/assetPolicy|canOpen/);
  });
});
