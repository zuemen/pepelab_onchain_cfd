import { it, expect, describe } from 'vitest';

import { positionPnl } from './positionPnl';

const E18 = 10n ** 18n;

describe('positionPnl', () => {
  // 2026-10-02 截圖的那個部位：sETH 做多、保證金 800、3×、10 bps；oracle 沒動，
  // getUnrealizedPnL = 0、getPositionValue = 800 − 2,400 × 0.1% = 797.60。
  const screenshot = { margin: 800n * E18, positionValue: 79760n * 10n ** 16n, markPnl: 0n };

  it('is position value minus margin: mark-price PnL net of close fee, borrow fee and funding', () => {
    expect(positionPnl(screenshot)).toEqual({
      pnl: -240n * 10n ** 16n,
      value: 79760n * 10n ** 16n,
    });
  });

  it('agrees in sign with the value: a value below margin is never shown as a gain', () => {
    const { pnl, value } = positionPnl(screenshot);
    expect(pnl! < 0n).toBe(value! < screenshot.margin);
  });

  it('a wiped-out position (value clamped to 0) loses exactly its margin', () => {
    expect(positionPnl({ margin: 800n * E18, positionValue: 0n, markPnl: -900n * E18 }).pnl).toBe(
      -800n * E18
    );
  });

  it('falls back to the mark-price PnL when getPositionValue could not be read', () => {
    expect(positionPnl({ margin: 800n * E18, positionValue: null, markPnl: 5n * E18 })).toEqual({
      pnl: 5n * E18,
      value: 805n * E18,
    });
  });

  it('reports unknown, not zero, when neither view could be read', () => {
    expect(positionPnl({ margin: 800n * E18, positionValue: null, markPnl: null })).toEqual({
      pnl: null,
      value: null,
    });
  });
});
