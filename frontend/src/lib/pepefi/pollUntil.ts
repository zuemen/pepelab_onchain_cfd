/**
 * 交易確認後「讀到新狀態為止」的輪詢。公開 RPC 是負載平衡的：receipt 之後的下一次讀取可能落在
 * 還沒同步到那個區塊的節點，所以要重讀幾次。
 *
 * - `check` 回 true 就停（'ok'）；丟例外視同還沒好，繼續等（呼叫端自己決定最後要不要提示錯誤）。
 * - `cancelled()` 每一輪前後都檢查：元件卸載、換錢包時停止（'cancelled'），不再更新畫面。
 * - 用完 `tries` 次回 'timeout'。
 */
export type PollResult = 'ok' | 'timeout' | 'cancelled'

export async function pollUntil(
  check: () => Promise<boolean>,
  {
    tries = 10,
    intervalMs = 2000,
    cancelled = () => false,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: { tries?: number; intervalMs?: number; cancelled?: () => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<PollResult> {
  for (let i = 0; i < tries; i++) {
    if (cancelled()) return 'cancelled'
    let done = false
    try {
      done = await check()
    } catch {
      done = false
    }
    if (cancelled()) return 'cancelled'
    if (done) return 'ok'
    if (i < tries - 1) await sleep(intervalMs)
  }
  return 'timeout'
}
