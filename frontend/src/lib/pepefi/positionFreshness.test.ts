import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { unrealised } from 'src/sections/terminal/book/MarketActivity';
import { POSITION_POLL_MS, POSITION_STALE_MS } from 'src/hooks/useTerminalAccount';

import { pnlStatusText, freshnessText, dataFreshness } from './positionFreshness';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('terminal position freshness (H1)', () => {
  const base = { nowMs: 1_000_000, staleAfterMs: POSITION_STALE_MS };

  it('fresh right after a successful read, stale once the poll has missed', () => {
    expect(dataFreshness({ ...base, updatedAt: 1_000_000 - 1_000, readFailed: false })).toBe('fresh');
    expect(
      dataFreshness({ ...base, updatedAt: 1_000_000 - POSITION_STALE_MS - 1, readFailed: false })
    ).toBe('stale');
  });

  it('a failed read is flagged even when the last good data is recent', () => {
    expect(dataFreshness({ ...base, updatedAt: 999_000, readFailed: true })).toBe('failed');
    expect(dataFreshness({ ...base, updatedAt: null, readFailed: true })).toBe('failed');
    expect(dataFreshness({ ...base, updatedAt: null, readFailed: false })).toBe('never');
  });

  it('every state says when the figures are from', () => {
    const at = new Date(2026, 9, 3, 19, 41, 5).getTime();
    expect(freshnessText('fresh', at, POSITION_STALE_MS)).toBe('更新於 19:41:05');
    expect(freshnessText('failed', at, POSITION_STALE_MS)).toContain('19:41:05');
    expect(freshnessText('stale', at, POSITION_STALE_MS)).toContain('19:41:05');
  });

  it('polls at the portfolio page’s interval and pauses in a background tab', () => {
    expect(POSITION_POLL_MS).toBe(30_000);
    expect(POSITION_STALE_MS).toBeGreaterThan(POSITION_POLL_MS);
    const hook = fs.readFileSync(path.join(SRC, 'hooks/useTerminalAccount.ts'), 'utf8');
    expect(hook).toMatch(/setInterval\([\s\S]*?POSITION_POLL_MS\)/);
    expect(hook).toMatch(/visibilityState === 'hidden'/);
  });
});

describe('pnl status text', () => {
  it('only a non-ok status has a reason', () => {
    expect(pnlStatusText('ok')).toBeNull();
    expect(pnlStatusText('unreadable')?.label).toBe('讀取失敗');
    expect(pnlStatusText('noPrice')?.label).toBe('無有效價格');
    expect(pnlStatusText('stale')?.label).toBe('價格過期');
  });
});

describe('market activity panel (M1)', () => {
  const row = {
    id: 1n,
    asset: `0x${'ab'.repeat(32)}`,
    isLong: true,
    entryPrice: 2_760n * 10n ** 18n,
    margin: 800n * 10n ** 18n,
    leverage: 3n,
    openedAt: 0n,
    closedAt: 0n,
    realizedPnL: 0n,
    isOpen: true,
  };
  const NOW = 1_790_000_000;

  it('uses the contract’s net figure when the price is valid', () => {
    const r = unrealised(
      { ...row, positionValue: 79760n * 10n ** 16n, oracle: [276000000000n, BigInt(NOW - 10)] },
      NOW
    );
    expect(r).toEqual({ status: 'ok', pnl: -240n * 10n ** 16n, value: 79760n * 10n ** 16n });
  });

  it('a zero oracle price does not paint every open position as a total loss', () => {
    const r = unrealised({ ...row, positionValue: 0n, oracle: [0n, BigInt(NOW)] }, NOW);
    expect(r.status).toBe('noPrice');
    expect(r.pnl).toBeNull();
  });

  it('an unread price or value gives no figure', () => {
    expect(unrealised({ ...row, positionValue: 5n, oracle: null }, NOW).pnl).toBeNull();
    expect(unrealised({ ...row, positionValue: null, oracle: [1n, BigInt(NOW)] }, NOW).pnl).toBeNull();
  });
});
