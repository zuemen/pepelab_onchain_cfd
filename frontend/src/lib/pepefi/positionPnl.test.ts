import { it, expect, describe } from 'vitest';

import {
  totalPnl,
  totalValue,
  chainNowSec,
  positionPnl,
  terminalTotals,
  cachedMaxPriceAge,
  MAX_PRICE_AGE_TTL_MS,
} from './positionPnl';

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

// 審查 N1：getPosition 讀不到的部位不在列表裡；合計不能只加剩下的列。
describe('terminalTotals', () => {
  const rows = [
    { pnl: -240n, value: 79_760n },
    { pnl: 100n, value: 1_100n },
  ];

  it('equity is free margin plus every position’s close value', () => {
    expect(terminalTotals({ positions: rows, freeMargin: 1_000n, unreadCount: 0 })).toEqual({
      totalPnl: -140n,
      equity: 1_000n + 79_760n + 1_100n,
    });
  });

  it('a position whose getPosition failed makes both totals unknown, not a smaller number', () => {
    expect(terminalTotals({ positions: rows, freeMargin: 1_000n, unreadCount: 1 })).toEqual({
      totalPnl: null,
      equity: null,
    });
  });

  it('a listed position with no figure also makes both totals unknown', () => {
    expect(
      terminalTotals({ positions: [...rows, { pnl: null, value: null }], freeMargin: 1n, unreadCount: 0 })
    ).toEqual({ totalPnl: null, equity: null });
  });
});

// 審查 N4：與合約 _requireFresh 一致。
describe('freshness follows the contract', () => {
  it('an oracle that was never written (updatedAt = 0) has no usable price', () => {
    expect(
      positionPnl({ margin: 1n, positionValue: 1n, oracle: [276055000000n, 0n], nowSec: 1_790_000_000 })
        .status
    ).toBe('noPrice');
  });

  it('chainNowSec uses the latest block’s timestamp, not the user’s clock', async () => {
    const contract = { runner: { provider: { getBlock: async () => ({ timestamp: 1_234_567 }) } } };
    expect(await chainNowSec(contract)).toBe(1_234_567);
    const signerless = { runner: { getBlock: async () => ({ timestamp: 42n }) } };
    expect(await chainNowSec(signerless)).toBe(42);
  });

  it('chainNowSec falls back to the local clock when the block cannot be read', async () => {
    const hung = { runner: { provider: { getBlock: () => new Promise<never>(() => {}) } } };
    const before = Math.floor(Date.now() / 1000);
    const now = await chainNowSec(hung, 20);
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

// 審查 N6：maxPriceAge 不每輪都讀。
describe('cachedMaxPriceAge', () => {
  it('reads the contract once per TTL', async () => {
    let calls = 0;
    const exchange = {
      maxPriceAge: async () => {
        calls += 1;
        return 3_600n;
      },
    };
    let t = 0;
    const now = () => t;
    expect(await cachedMaxPriceAge(exchange, now)).toBe(3_600);
    t = MAX_PRICE_AGE_TTL_MS - 1;
    expect(await cachedMaxPriceAge(exchange, now)).toBe(3_600);
    expect(calls).toBe(1);
    t = MAX_PRICE_AGE_TTL_MS + 1;
    await cachedMaxPriceAge(exchange, now);
    expect(calls).toBe(2);
  });
});
