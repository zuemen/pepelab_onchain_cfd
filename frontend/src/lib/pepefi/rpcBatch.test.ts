import { it, expect, describe } from 'vitest';

import { withRetry } from './rpcBatch';

describe('withRetry', () => {
  it('retries a failing call and returns the first success', async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        n += 1;
        if (n < 2) throw new Error('429');
        return 'ok';
      },
      3,
      0
    );
    expect(v).toBe('ok');
    expect(n).toBe(2);
  });

  // 審查 N2：不回應的節點不會丟錯；沒有逾時就永遠等下去。
  it('with a per-attempt timeout, a call that never answers fails instead of hanging', async () => {
    let n = 0;
    const t0 = Date.now();
    await expect(
      withRetry(
        () => {
          n += 1;
          return new Promise<never>(() => {});
        },
        2,
        0,
        20
      )
    ).rejects.toThrow('rpc timeout');
    expect(n).toBe(2);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
