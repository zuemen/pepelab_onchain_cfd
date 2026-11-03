import { it, expect, describe } from 'vitest';

import { STALE_CHUNK_RELOAD_KEY, claimStaleChunkReload } from './staleChunkReload';

// ----------------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

const T0 = 1_800_000_000_000;

describe('claimStaleChunkReload', () => {
  it('reloads on the first failed chunk and remembers when', () => {
    const storage = memoryStorage();
    expect(claimStaleChunkReload(storage, T0)).toBe(true);
    expect(storage.data[STALE_CHUNK_RELOAD_KEY]).toBe(String(T0));
  });

  it('does not reload again right after a reload — the chunk is really gone', () => {
    // 重新整理後仍然載不到：不是舊分頁，是部署本身壞了。再重整只會無限迴圈。
    const storage = memoryStorage();
    claimStaleChunkReload(storage, T0);
    expect(claimStaleChunkReload(storage, T0 + 5_000)).toBe(false);
  });

  it('reloads again for a later deploy in the same tab', () => {
    const storage = memoryStorage();
    claimStaleChunkReload(storage, T0);
    expect(claimStaleChunkReload(storage, T0 + 60 * 60_000)).toBe(true);
  });

  it('ignores a value it cannot read as a time', () => {
    expect(claimStaleChunkReload(memoryStorage({ [STALE_CHUNK_RELOAD_KEY]: 'x' }), T0)).toBe(true);
  });

  it('never reloads when it cannot remember that it already did', () => {
    // sessionStorage 被封鎖（隱私模式、iframe）時沒有防護可言，寧可讓錯誤畫面出來。
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(claimStaleChunkReload(blocked, T0)).toBe(false);
    expect(claimStaleChunkReload(null, T0)).toBe(false);
  });
});
