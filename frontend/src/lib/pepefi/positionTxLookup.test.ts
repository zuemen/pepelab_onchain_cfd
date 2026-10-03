import { it, expect, describe } from 'vitest';

import { lookupWindow, estimateBlockAt, LOOKUP_HALF_WINDOW } from './positionTxLookup';

/** 一條出塊時間固定的假鏈：第 n 塊的時間 = t0 + n × bt。 */
const steadyChain = (head: number, t0: number, bt: number) => ({
  getBlock: async (tag: number | 'latest') => {
    const n = tag === 'latest' ? head : tag;
    return n > head ? null : { number: n, timestamp: t0 + n * bt };
  },
});

describe('estimateBlockAt', () => {
  it('lands on the right block on a steady 2-second chain (Base Sepolia)', async () => {
    const chain = steadyChain(47_581_184, 1_700_000_000, 2);
    const ts = 1_700_000_000 + 47_581_181 * 2;
    const r = await estimateBlockAt(chain, ts, 84532);
    expect(r).toEqual({ est: 47_581_181, latest: 47_581_184 });
  });

  it('corrects itself on a chain whose real block time differs from the average', async () => {
    // anvil fork：有交易才出塊，實際約 30 秒一塊；第一次用 2 秒推會偏很遠，修正後要落在窗口內。
    const chain = steadyChain(1_000, 1_700_000_000, 30);
    const target = 990;
    const r = (await estimateBlockAt(chain, 1_700_000_000 + target * 30, 84532))!;
    const [from, to] = lookupWindow(r.est, r.latest);
    expect(target).toBeGreaterThanOrEqual(from);
    expect(target).toBeLessThanOrEqual(to);
  });

  it('a timestamp at or after the head maps to the head', async () => {
    const chain = steadyChain(100, 0, 2);
    expect(await estimateBlockAt(chain, 10_000, 84532)).toEqual({ est: 100, latest: 100 });
  });

  it('returns null when the head block cannot be read', async () => {
    expect(await estimateBlockAt({ getBlock: async () => null }, 1, 84532)).toBeNull();
  });
});

describe('lookupWindow', () => {
  it('is centred on the estimate and clipped to [0, latest]', () => {
    expect(lookupWindow(10_000, 20_000)).toEqual([
      10_000 - LOOKUP_HALF_WINDOW,
      10_000 + LOOKUP_HALF_WINDOW,
    ]);
    expect(lookupWindow(5, 20_000)).toEqual([0, 5 + LOOKUP_HALF_WINDOW]);
    expect(lookupWindow(19_990, 20_000)).toEqual([19_990 - LOOKUP_HALF_WINDOW, 20_000]);
  });
});
