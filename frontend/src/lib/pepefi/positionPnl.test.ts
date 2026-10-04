import { it, expect, describe } from 'vitest';

import { totalPnl, totalValue, positionPnl } from './positionPnl';

const E18 = 10n ** 18n;
const NOW = 1_790_000_000;
// 8 位小數的 oracle 價，剛更新。
const FRESH: readonly [bigint, bigint] = [276055000000n, BigInt(NOW - 60)];

describe('positionPnl', () => {
  // 2026-10-02 截圖的那個部位：sETH 做多、保證金 800、3×、10 bps；oracle 沒動，
  // getPositionValue = 800 − 2,400 × 0.1% = 797.60。
  const screenshot = {
    margin: 800n * E18,
    positionValue: 79760n * 10n ** 16n,
    oracle: FRESH,
    nowSec: NOW,
  };

  it('is position value minus margin: mark-price PnL net of close fee, borrow fee and funding', () => {
    expect(positionPnl(screenshot)).toEqual({
      status: 'ok',
      pnl: -240n * 10n ** 16n,
      value: 79760n * 10n ** 16n,
    });
  });

  it('agrees in sign with the value: a value below margin is never shown as a gain', () => {
    const { pnl, value } = positionPnl(screenshot);
    expect(pnl! < 0n).toBe(value! < screenshot.margin);
  });

  it('a wiped-out position (value clamped to 0) at a valid price loses exactly its margin', () => {
    expect(positionPnl({ ...screenshot, positionValue: 0n }).pnl).toBe(-800n * E18);
  });

  it('gives no figure — not 0 — when getPositionValue could not be read', () => {
    expect(positionPnl({ ...screenshot, positionValue: null })).toEqual({
      status: 'unreadable',
      pnl: null,
      value: null,
    });
  });

  it('gives no figure when the oracle could not be read', () => {
    expect(positionPnl({ ...screenshot, oracle: null })).toEqual({
      status: 'unreadable',
      pnl: null,
      value: null,
    });
  });

  // M8：合約在價格為 0 時不 revert，getPositionValue 回 0。照算會是「保證金全虧」。
  it('a zero oracle price is "no valid price", not a total loss', () => {
    const r = positionPnl({ ...screenshot, positionValue: 0n, oracle: [0n, BigInt(NOW)] });
    expect(r).toEqual({ status: 'noPrice', pnl: null, value: null });
  });

  it('a price older than maxPriceAge is "stale" (the contract would refuse the close)', () => {
    const old: readonly [bigint, bigint] = [276055000000n, BigInt(NOW - 21_601)];
    expect(positionPnl({ ...screenshot, oracle: old, maxPriceAgeSec: 21_600 }).status).toBe('stale');
    expect(positionPnl({ ...screenshot, oracle: old, maxPriceAgeSec: 21_600 }).pnl).toBeNull();
    // 剛好在門檻內仍是 ok。
    const edge: readonly [bigint, bigint] = [276055000000n, BigInt(NOW - 21_600)];
    expect(positionPnl({ ...screenshot, oracle: edge, maxPriceAgeSec: 21_600 }).status).toBe('ok');
  });
});

describe('totals', () => {
  it('sum the rows when every row has a figure', () => {
    expect(totalPnl([{ pnl: 1n }, { pnl: -3n }])).toBe(-2n);
    expect(totalValue([{ value: 5n }, { value: 7n }])).toBe(12n);
    expect(totalPnl([])).toBe(0n);
  });

  it('are unknown, not a smaller sum, when any row has no figure', () => {
    expect(totalPnl([{ pnl: 1n }, { pnl: null }])).toBeNull();
    expect(totalValue([{ value: 5n }, { value: null }])).toBeNull();
  });
});
