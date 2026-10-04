import { withTimeout } from './safeRead';
import { avgBlockTime } from './chainLogs';

/**
 * 從合約儲存重建的部位列（歷史紀錄頁）沒有交易雜湊：storage 只記 openedAt / closedAt
 * 的時間，不記是哪一筆交易寫進來的。完整日誌掃描（最近 9,000 塊、十幾段 getLogs）
 * 跑完之前，那一列的「交易」欄只能寫「合約儲存」。
 *
 * 這裡用時間反推區塊號，對那個部位的 PositionOpened / PositionClosed 做**一次**窄範圍
 * 查詢（positionId 是 indexed topic），幾百毫秒就能補上雜湊與 explorer 連結，不必等
 * 整個掃描。找不到（估計偏太多、節點不給查）就維持原樣，完整掃描之後仍會補上。
 */

export interface BlockLike {
  number: number;
  timestamp: number;
}

export interface BlockSource {
  getBlock(tag: number | 'latest'): Promise<BlockLike | null>;
}

/**
 * 單次 getBlock 最久等多久。沒有這個上限時，一個不回應的節點會讓 await 永遠不結束——
 * 正是歷史紀錄頁「載入中…」卡住的那一類問題。
 */
export const GET_BLOCK_TIMEOUT_MS = 5_000;

/** getBlock 加逾時；逾時或錯誤一律回 null（呼叫端當成「這次查不到」）。 */
export async function getBlockWithin(
  provider: BlockSource,
  tag: number | 'latest',
  ms = GET_BLOCK_TIMEOUT_MS
): Promise<BlockLike | null> {
  try {
    return await withTimeout(provider.getBlock(tag), ms);
  } catch {
    return null;
  }
}

/** 估計值前後各查多少塊。兩段 CHUNK_SIZE 以內，一個部位最多兩趟 getLogs。 */
export const LOOKUP_HALF_WINDOW = 600;

/**
 * 某個 unix 時間點附近的區塊號：先用最新塊與平均出塊時間推一次，再拿推出來的那一塊
 * 的實際時間修正一次（出塊時間不均、anvil 這種有交易才出塊的鏈，第一次推估會偏）。
 */
export async function estimateBlockAt(
  provider: BlockSource,
  timestamp: number,
  chainId: number | null | undefined,
  latest?: BlockLike | null,
  ms = GET_BLOCK_TIMEOUT_MS
): Promise<{ est: number; latest: number } | null> {
  const head = latest ?? (await getBlockWithin(provider, 'latest', ms));
  if (!head) return null;
  if (timestamp >= head.timestamp) return { est: head.number, latest: head.number };

  const bt = avgBlockTime(chainId);
  const clamp = (n: number) => Math.min(head.number, Math.max(0, Math.round(n)));
  let est = clamp(head.number - (head.timestamp - timestamp) / bt);

  const probe = await getBlockWithin(provider, est, ms);
  if (probe) est = clamp(est - (probe.timestamp - timestamp) / bt);

  return { est, latest: head.number };
}

/** 估計值附近的查詢範圍，不超出 [0, latest]。 */
export function lookupWindow(
  est: number,
  latest: number,
  half = LOOKUP_HALF_WINDOW
): [number, number] {
  return [Math.max(0, est - half), Math.min(latest, est + half)];
}

// ── 批次補雜湊 ────────────────────────────────────────────────────────────

export interface TxLookupTarget {
  /** 去重與負向快取用，例如 `PositionOpened:12`。 */
  key: string;
  /** storage 記的 openedAt / closedAt（秒）。 */
  timestamp: number;
}

export interface ResolveOptions<R extends TxLookupTarget, T> {
  provider: BlockSource;
  chainId: number | null | undefined;
  rows: readonly R[];
  /** 在 [from, to] 裡找這一列的交易；找不到回 null。 */
  lookup: (row: R, from: number, to: number) => Promise<T | null>;
  /** 這個 session 已經查過、查不到的 key：不再重查（L7）。查不到的會加進來。 */
  notFound?: Set<string>;
  /** 一次最多處理幾列（最新的優先）。 */
  max?: number;
  /** 整批的時間預算；超過就停，不再開始新的一列。 */
  budgetMs?: number;
  /** 單列（估區塊＋查詢）的上限。 */
  rowTimeoutMs?: number;
  /** 使用者重新整理或離開頁面：停止並丟棄結果。 */
  isCancelled?: () => boolean;
  /** 測試用。 */
  now?: () => number;
}

/**
 * 批次替 storage 列補交易雜湊。每一步都有上限：getBlock 5 秒、單列 rowTimeoutMs、
 * 整批 budgetMs——節點不回應時一定會在預算內結束，不會讓頁面一直掛著「載入中…」。
 */
export async function resolveTxHashes<R extends TxLookupTarget, T>(
  o: ResolveOptions<R, T>
): Promise<T[]> {
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? 30_000);
  const rowMs = o.rowTimeoutMs ?? 25_000;
  const pending = o.rows
    .filter((r) => r.timestamp > 0 && !o.notFound?.has(r.key))
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, o.max ?? 12);
  if (pending.length === 0) return [];

  const head = await getBlockWithin(o.provider, 'latest');
  if (!head || o.isCancelled?.()) return [];

  const found: T[] = [];
  // 併發 2：與主掃描共用同一個公開節點，避免 429。
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (o.isCancelled?.() || now() >= deadline) return;
      const row = pending[next];
      next += 1;
      if (!row) return;
      let hit: T | null = null;
      try {
        hit = await withTimeout(
          (async () => {
            const at = await estimateBlockAt(o.provider, row.timestamp, o.chainId, head);
            if (!at) return null;
            const [from, to] = lookupWindow(at.est, at.latest);
            return o.lookup(row, from, to);
          })(),
          Math.max(1, Math.min(rowMs, deadline - now()))
        );
      } catch {
        // 逾時或錯誤：這次查不到，下次重新整理再試（不記進負向快取）。
        continue;
      }
      if (hit !== null) found.push(hit);
      else o.notFound?.add(row.key);
    }
  };
  await Promise.all([worker(), worker()]);
  return o.isCancelled?.() ? [] : found;
}
