// 「查詢持有天數」的查詢流程與快取（#134 殘項；PR #202 審查 M1）。
//
// 為什麼不再自動掃：公開節點 getLogs 一次只收 1,000 塊，長期持有者一次查詢要把整個
// 掃描範圍（約 60 段 × 2 個 filter ≈ 110–120 次序列 getLogs）掃完，而且全部走錢包
// 擴充的 RPC。所以改成：
//   1. 預設不發任何請求——詳情層顯示「查詢持有天數」按鈕，使用者點了才掃；
//   2. 結果放進 module-level 快取，鍵含餘額（買進／贖回後餘額變了自然失效），
//      **負結果也快取**——掃完確定找不到起點，同一個餘額再點一次不重掃；
//   3. 找不到就不顯示天數，不猜。
//
// 這個檔案不 import ethers／React：I/O 由呼叫端以 HeldSinceDeps 注入，測試直接數呼叫次數。
import type { ChunkScanOptions } from './chainLogs';

import { CHUNK_SIZE, scanFromBlock } from './chainLogs';
import { streakStart, type TransferLike } from './heldSince';

/** 一次查詢會用到的所有鏈上 I/O。 */
export interface HeldSinceDeps {
  /** 最新塊號（查詢以這一塊為準）。 */
  head: () => Promise<number>;
  /** `blockTag` 那一塊的 balanceOf(user)。 */
  balanceAt: (blockTag: number) => Promise<bigint>;
  /** 掃 [from, to] 內 from 或 to 是 user 的 Transfer；failed = 有任何一段讀取失敗。 */
  scan: (
    from: number,
    to: number,
    opts: Pick<ChunkScanOptions, 'signal'>
  ) => Promise<{ transfers: TransferLike[]; failed: boolean }>;
  /** 區塊時間（unix 秒）；讀不到是 null。 */
  blockTime: (blockNumber: number) => Promise<number | null>;
}

export interface HeldSinceTarget {
  chainId: number | null;
  token: string;
  user: string;
  /** 目前畫面上的餘額（快取鍵的一部分）。 */
  balance: bigint;
}

export type HeldSinceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'found'; heldSinceSec: number }
  /** 查過了但找不到（持有早於掃描範圍、倒推對不上、讀不到區塊時間）——不顯示天數。 */
  | { status: 'unknown' };

/** 每一步往回掃幾段。持有剛開始的人通常第一步就找到。 */
const CHUNKS_PER_STEP = 5;

export const heldSinceKey = (t: HeldSinceTarget): string =>
  `${t.chainId}:${t.token.toLowerCase()}:${t.user.toLowerCase()}:${t.balance}`;

/** 值：起點秒數，或 null＝確定找不到（負結果）。沒有鍵＝還沒查過。 */
const cache = new Map<string, number | null>();

const fromCache = (v: number | null): HeldSinceState =>
  v === null ? { status: 'unknown' } : { status: 'found', heldSinceSec: v };

/** 同步讀快取，**不發任何請求**。沒查過回 idle——畫面顯示按鈕。 */
export function peekHeldSince(t: HeldSinceTarget): HeldSinceState {
  const key = heldSinceKey(t);
  return cache.has(key) ? fromCache(cache.get(key)!) : { status: 'idle' };
}

/**
 * 使用者點了「查詢持有天數」之後才呼叫。快取命中直接回傳，不發請求。
 *
 * 快取規則：
 *   - found／確定找不到（持有早於掃描範圍、倒推對不上）→ 寫入快取；
 *   - 讀取失敗（任何一段 getLogs 失敗、RPC 例外）與中止 → **不**寫入。那不是「找不到」，
 *     是「這次沒查成」；寫進快取會讓使用者在 RPC 恢復後也永遠查不到。
 */
export async function queryHeldSince(
  t: HeldSinceTarget,
  deps: HeldSinceDeps,
  signal?: AbortSignal
): Promise<HeldSinceState> {
  const key = heldSinceKey(t);
  if (cache.has(key)) return fromCache(cache.get(key)!);
  if (t.balance <= 0n) return { status: 'unknown' };

  const settle = (v: number | null): HeldSinceState => {
    if (!signal?.aborted) cache.set(key, v);
    return fromCache(v);
  };

  // 釘住一個塊：餘額與事件都以這一塊為準，否則掃描途中新進的交易會讓倒推對不上。
  const head = await deps.head();
  const bal = await deps.balanceAt(head);
  if (bal <= 0n) return { status: 'unknown' }; // 畫面上的餘額已過期，不快取
  const floor = scanFromBlock({ chainId: t.chainId, currentBlock: head });

  const transfers: TransferLike[] = [];
  const step = CHUNK_SIZE * CHUNKS_PER_STEP;
  for (let to = head; to >= floor; to -= step) {
    if (signal?.aborted) return { status: 'unknown' };
    const from = Math.max(floor, to - step + 1);
    const r = await deps.scan(from, to, { signal });
    if (r.failed) return { status: 'unknown' }; // 有缺段就不可能確定起點；不快取
    transfers.push(...r.transfers);
    const s = streakStart(bal, t.user, transfers);
    if (s.kind === 'inconsistent') return settle(null);
    if (s.kind === 'found') {
      const ts = await deps.blockTime(s.blockNumber);
      if (ts === null) return { status: 'unknown' }; // 讀取失敗，不快取
      return settle(ts);
    }
  }
  // 掃到範圍下緣仍沒有歸零：持有早於掃描範圍。
  return settle(null);
}

/** 測試用：清空快取。 */
export function __clearHeldSinceCache(): void {
  cache.clear();
}
