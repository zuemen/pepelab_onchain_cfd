import { it, expect, describe, beforeEach } from 'vitest';

import {
  heldSinceKey,
  peekHeldSince,
  queryHeldSince,
  type HeldSinceDeps,
  __clearHeldSinceCache,
  type HeldSinceTarget,
} from './heldSinceQuery';

const USER = '0x00000000000000000000000000000000000000Aa';
const ZERO = '0x0000000000000000000000000000000000000000';
const HEAD = 1_000_000;

/** 假的鏈上 I/O：數每一種呼叫的次數。 */
function fakeDeps(opts: {
  balance: bigint;
  mintAt?: number; // 在這一塊鑄出 balance；undefined＝掃描範圍內沒有任何轉入
  failScan?: boolean;
}) {
  const calls = { head: 0, balanceAt: 0, scan: 0, blockTime: 0 };
  const deps: HeldSinceDeps = {
    head: async () => {
      calls.head++;
      return HEAD;
    },
    balanceAt: async () => {
      calls.balanceAt++;
      return opts.balance;
    },
    scan: async (from, to) => {
      calls.scan++;
      if (opts.failScan) return { transfers: [], failed: true };
      const hit = opts.mintAt !== undefined && opts.mintAt >= from && opts.mintAt <= to;
      return {
        failed: false,
        transfers: hit
          ? [{ blockNumber: opts.mintAt!, index: 0, from: ZERO, to: USER, value: opts.balance }]
          : [],
      };
    },
    blockTime: async (n) => {
      calls.blockTime++;
      return 1_700_000_000 + n;
    },
  };
  const total = () => calls.head + calls.balanceAt + calls.scan + calls.blockTime;
  return { deps, calls, total };
}

const target = (over: Partial<HeldSinceTarget> = {}): HeldSinceTarget => ({
  chainId: 31337, // Anvil：部署塊 0，掃描範圍只受 MAX_CHUNKS 限制
  token: '0x00000000000000000000000000000000000000Cc',
  user: USER,
  balance: 5n,
  ...over,
});

beforeEach(() => __clearHeldSinceCache());

describe('持有天數：預設不發請求（PR #202 M1）', () => {
  it('沒按按鈕之前只讀快取——peekHeldSince 不需要、也不碰任何鏈上 I/O', () => {
    const { total } = fakeDeps({ balance: 5n, mintAt: HEAD - 10 });
    expect(peekHeldSince(target())).toEqual({ status: 'idle' });
    expect(total()).toBe(0);
  });

  it('按下之後才查，找到起點就停（剛買的人第一步就找到）', async () => {
    const { deps, calls } = fakeDeps({ balance: 5n, mintAt: HEAD - 10 });
    const s = await queryHeldSince(target(), deps);
    expect(s).toEqual({ status: 'found', heldSinceSec: 1_700_000_000 + HEAD - 10 });
    expect(calls.scan).toBe(1);
  });
});

describe('持有天數：module-level 快取', () => {
  it('快取命中不再發任何請求，peek 也直接拿到結果', async () => {
    const first = fakeDeps({ balance: 5n, mintAt: HEAD - 10 });
    await queryHeldSince(target(), first.deps);

    const second = fakeDeps({ balance: 5n, mintAt: HEAD - 10 });
    const s = await queryHeldSince(target(), second.deps);
    expect(s.status).toBe('found');
    expect(second.total()).toBe(0);
    expect(peekHeldSince(target()).status).toBe('found');
  });

  it('負結果也快取：掃完整個範圍找不到起點，同一個餘額再查不重掃', async () => {
    const first = fakeDeps({ balance: 5n }); // 範圍內沒有轉入 → 持有早於掃描範圍
    expect(await queryHeldSince(target(), first.deps)).toEqual({ status: 'unknown' });
    expect(first.calls.scan).toBeGreaterThan(1); // 真的掃過整個範圍

    const second = fakeDeps({ balance: 5n });
    expect(await queryHeldSince(target(), second.deps)).toEqual({ status: 'unknown' });
    expect(second.total()).toBe(0);
    expect(peekHeldSince(target())).toEqual({ status: 'unknown' });
  });

  it('餘額變了（買進／贖回後）就是不同的鍵，會重新查', async () => {
    await queryHeldSince(target(), fakeDeps({ balance: 5n }).deps);
    expect(peekHeldSince(target({ balance: 7n }))).toEqual({ status: 'idle' });
    expect(heldSinceKey(target())).not.toBe(heldSinceKey(target({ balance: 7n })));
  });

  it('鍵不分位址大小寫', () => {
    expect(heldSinceKey(target({ user: USER.toUpperCase().replace('0X', '0x') }))).toBe(
      heldSinceKey(target())
    );
  });

  it('讀取失敗不快取——那是「這次沒查成」，不是「找不到」', async () => {
    const failing = fakeDeps({ balance: 5n, failScan: true });
    expect(await queryHeldSince(target(), failing.deps)).toEqual({ status: 'unknown' });
    expect(peekHeldSince(target())).toEqual({ status: 'idle' });

    const retry = fakeDeps({ balance: 5n, mintAt: HEAD - 10 });
    expect((await queryHeldSince(target(), retry.deps)).status).toBe('found');
  });

  it('中止的查詢不寫快取', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { deps } = fakeDeps({ balance: 5n });
    await queryHeldSince(target(), deps, ctrl.signal);
    expect(peekHeldSince(target())).toEqual({ status: 'idle' });
  });

  it('沒有持有就不查', async () => {
    const { deps, total } = fakeDeps({ balance: 0n });
    expect(await queryHeldSince(target({ balance: 0n }), deps)).toEqual({ status: 'unknown' });
    expect(total()).toBe(0);
  });
});
