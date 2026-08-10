/**
 * 限制併發的 map。
 *
 * 存在的理由是實測出來的，不是預防性設計：Base Sepolia 的公開 RPC
 * (sepolia.base.org) 在同時收到大量 eth_call 時會直接丟掉一部分。實測讀 76 個
 * position——一次全部併發送出，39 個失敗（回 "missing revert data"）；限制併發
 * 6，只失敗 2 個。
 *
 * 這種失敗特別惡劣，因為呼叫端通常寫成 `catch { return null }`，於是限流被靜默
 * 翻譯成「這個標的沒有資料」，UI 上顯示成一個空欄位。使用者看到的是「壞掉」，
 * 而不是「重試一下就好」。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const size = Math.max(1, Math.min(limit, items.length))
  const out = new Array<R>(items.length)
  let next = 0

  const worker = async () => {
    // 每個 worker 自己去搶下一個索引，不預先切段——工作耗時不均時（有些
    // eth_call 比較慢）才不會有 worker 提早閒置。
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: size }, () => worker()))
  return out
}

/**
 * 公開 RPC 的併發上限。
 *
 * 6 是實測站得住的值。往上調之前先確認你用的 RPC 端點——自架或付費節點可以更高，
 * 但預設的公開端點不行。
 */
export const RPC_CONCURRENCY = 6

/**
 * 重試暫時性的 RPC 失敗。
 *
 * 併發降到 6 之後仍然會零星失敗——實測掃 76 個 position、併發 6，還是有 8 筆
 * 讀不到。單純跳過的話，列表會少幾筆而畫面上完全看不出來：使用者以為那個標的
 * 就只有這些部位，實際上是被限流吃掉了。
 *
 * 退避時間刻意短：這是頁面載入路徑上的操作，重試兩次還不行就放棄，讓呼叫端把
 * 「有幾筆讀不到」講出來，而不是無限等待。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 120,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, baseDelayMs * 2 ** i)
        })
      }
    }
  }
  throw lastErr
}
