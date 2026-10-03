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
  latest?: BlockLike | null
): Promise<{ est: number; latest: number } | null> {
  const head = latest ?? (await provider.getBlock('latest'));
  if (!head) return null;
  if (timestamp >= head.timestamp) return { est: head.number, latest: head.number };

  const bt = avgBlockTime(chainId);
  const clamp = (n: number) => Math.min(head.number, Math.max(0, Math.round(n)));
  let est = clamp(head.number - (head.timestamp - timestamp) / bt);

  const probe = await provider.getBlock(est).catch(() => null);
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
