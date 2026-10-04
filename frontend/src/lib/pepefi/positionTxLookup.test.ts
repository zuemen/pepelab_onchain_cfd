import { it, expect, describe } from 'vitest';

import {
  lookupWindow,
  getBlockWithin,
  estimateBlockAt,
  resolveTxHashes,
  LOOKUP_HALF_WINDOW,
} from './positionTxLookup';

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

// M2：節點不回應時，補雜湊不能讓歷史紀錄頁一直掛著「載入中…」。
describe('a node that never answers', () => {
  const hung = { getBlock: () => new Promise<never>(() => {}) };

  it('getBlock gives up after its timeout instead of waiting forever', async () => {
    expect(await getBlockWithin(hung, 'latest', 20)).toBeNull();
    expect(await estimateBlockAt(hung, 1, 84532, null, 20)).toBeNull();
  });

  it('the whole hash lookup finishes within its budget even if every lookup hangs', async () => {
    const chain = steadyChain(1_000, 0, 2);
    const t0 = Date.now();
    const out = await resolveTxHashes({
      provider: chain,
      chainId: 84532,
      rows: [1, 2, 3, 4].map((i) => ({ key: `k${i}`, timestamp: 1_900 + i })),
      lookup: () => new Promise<never>(() => {}),
      rowTimeoutMs: 30,
      budgetMs: 200,
    });
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a hung head-block read ends the lookup with nothing found', async () => {
    const out = await resolveTxHashes({
      provider: { getBlock: (tag) => (tag === 'latest' ? new Promise<never>(() => {}) : Promise.resolve(null)) },
      chainId: 84532,
      rows: [{ key: 'a', timestamp: 10 }],
      lookup: async () => 'hash',
    });
    expect(out).toEqual([]);
  }, 10_000);
});

describe('resolveTxHashes', () => {
  const chain = steadyChain(1_000, 0, 2);

  it('returns what it finds, searching a window that contains the right block', async () => {
    const out = await resolveTxHashes({
      provider: chain,
      chainId: 84532,
      rows: [{ key: 'a', timestamp: 1_980 }],
      lookup: async (_row, from, to) => (990 >= from && 990 <= to ? 'hash-990' : null),
    });
    expect(out).toEqual(['hash-990']);
  });

  it('remembers rows it could not find and does not query them again (L7)', async () => {
    const notFound = new Set<string>();
    let calls = 0;
    const opts = {
      provider: chain,
      chainId: 84532,
      rows: [{ key: 'a', timestamp: 1_980 }],
      notFound,
      lookup: async () => {
        calls += 1;
        return null;
      },
    };
    await resolveTxHashes(opts);
    await resolveTxHashes(opts);
    expect(calls).toBe(1);
    expect(notFound.has('a')).toBe(true);
  });

  it('a cancelled run (user refreshed again) writes nothing', async () => {
    const out = await resolveTxHashes({
      provider: chain,
      chainId: 84532,
      rows: [{ key: 'a', timestamp: 1_980 }],
      lookup: async () => 'hash',
      isCancelled: () => true,
    });
    expect(out).toEqual([]);
  });
});
