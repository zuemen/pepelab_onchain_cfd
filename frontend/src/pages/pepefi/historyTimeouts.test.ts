import { it, expect, describe } from 'vitest';

import { fetchPositionEvents } from './HistoryPage';

// 審查 N2：「載入中…」之前的 RPC 都要有上限。節點不回應時要失敗（呼叫端結束 loading、
// 顯示「讀取失敗，可重試」），而不是永遠等下去。
describe('history page initial reads', () => {
  const never = () => new Promise<never>(() => {});

  it('getUserPositions that never answers fails within its timeout', async () => {
    const t0 = Date.now();
    await expect(
      fetchPositionEvents({ getUserPositions: never, getPosition: never }, '0xabc', 20)
    ).rejects.toThrow('rpc timeout');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('nextPositionId that never answers fails within its timeout (all-activity tab)', async () => {
    await expect(fetchPositionEvents({ nextPositionId: never }, null, 20)).rejects.toThrow('rpc timeout');
  });

  it('a getPosition that never answers is counted as missed, not waited on forever', async () => {
    const r = await fetchPositionEvents(
      { getUserPositions: async () => [1n], getPosition: never },
      '0xabc',
      20
    );
    expect(r).toEqual({ evs: [], missed: 1 });
  });
});
