// 換版後，開著的舊分頁要載入的程式檔（chunk）已經不在了：Vite 發出 `vite:preloadError`，
// 畫面停在 "Failed to fetch dynamically imported module"。重新整理一次就會拿到新版的
// index.html 與新的 chunk。main.tsx 監聽這個事件，用這裡決定要不要重整（issue #396）。
//
// 重整後如果還是載不到，問題就不是舊分頁，而是部署本身；這時再重整只會無限迴圈，
// 所以用 sessionStorage 記下上次重整的時間，短時間內只重整一次。

export const STALE_CHUNK_RELOAD_KEY = 'pepefi:stale-chunk-reload';

/** 這段時間內已經重整過，就不再重整。 */
const RELOAD_WINDOW_MS = 60_000;

type SessionLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 回 true = 現在該重新整理（已經記下時間）；false = 剛重整過、或記不住，讓錯誤照常顯示。
 */
export function claimStaleChunkReload(storage: SessionLike | null, now: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(STALE_CHUNK_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
