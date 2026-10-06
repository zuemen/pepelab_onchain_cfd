// RWA 透明度頁的讀取狀態（純函式，可測）。
//
// 審查（PR #268）：換鏈或重新讀取失敗時，不能把舊資料當成現值繼續顯示。
//   - 讀取對象換了（換鏈、換節點）→ 舊資料立刻清空；
//   - 同一個對象重新讀取失敗 → 保留上一次成功的資料，但標記 failed，畫面顯示「上次成功讀取於 …」。

export interface AsyncState<T> {
  data: T | null
  /** 上一次成功讀取的時間（unix 秒）。 */
  updatedAt: number | null
  loading: boolean
  /** 最近一次讀取失敗（資料若還在，就是上一次成功的那份）。 */
  failed: boolean
  /** 讀取對象的識別（例如 loader 函式本身）。 */
  source: unknown
}

export const initialAsyncState = <T,>(): AsyncState<T> => ({
  data: null,
  updatedAt: null,
  loading: false,
  failed: false,
  source: null,
})

export type AsyncEvent<T> =
  | { type: 'start'; source: unknown }
  | { type: 'success'; source: unknown; data: T; at: number }
  | { type: 'failure'; source: unknown }
  | { type: 'none' }

export function asyncReducer<T>(s: AsyncState<T>, e: AsyncEvent<T>): AsyncState<T> {
  switch (e.type) {
    case 'none':
      return initialAsyncState<T>()
    case 'start':
      return e.source === s.source
        ? { ...s, loading: true }
        : { data: null, updatedAt: null, loading: true, failed: false, source: e.source }
    case 'success':
      // 過期的回應（對象已經換了）直接丟掉。
      return e.source === s.source ? { ...s, data: e.data, updatedAt: e.at, loading: false, failed: false } : s
    case 'failure':
      return e.source === s.source ? { ...s, loading: false, failed: true } : s
    default:
      return s
  }
}
