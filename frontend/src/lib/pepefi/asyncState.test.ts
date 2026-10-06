import { it, expect, describe } from 'vitest'

import { asyncReducer, initialAsyncState } from './asyncState'

describe('asyncReducer', () => {
  const A = () => Promise.resolve(1)
  const B = () => Promise.resolve(2)

  it('換讀取對象（換鏈）時舊資料立刻清空', () => {
    let s = asyncReducer(initialAsyncState<number>(), { type: 'start', source: A })
    s = asyncReducer(s, { type: 'success', source: A, data: 1, at: 100 })
    expect(s).toMatchObject({ data: 1, updatedAt: 100, loading: false, failed: false })
    s = asyncReducer(s, { type: 'start', source: B })
    expect(s.data).toBeNull()
    expect(s.updatedAt).toBeNull()
    expect(s.loading).toBe(true)
  })

  it('同一對象重讀失敗：保留上次成功的資料，但標記 failed（畫面顯示「上次成功讀取於」）', () => {
    let s = asyncReducer(initialAsyncState<number>(), { type: 'start', source: A })
    s = asyncReducer(s, { type: 'success', source: A, data: 1, at: 100 })
    s = asyncReducer(s, { type: 'start', source: A })
    expect(s.data).toBe(1)
    s = asyncReducer(s, { type: 'failure', source: A })
    expect(s).toMatchObject({ data: 1, updatedAt: 100, loading: false, failed: true })
    s = asyncReducer(s, { type: 'start', source: A })
    s = asyncReducer(s, { type: 'success', source: A, data: 3, at: 200 })
    expect(s).toMatchObject({ data: 3, updatedAt: 200, failed: false })
  })

  it('舊對象的遲到回應不覆蓋新對象；沒有讀取對象時回初始狀態', () => {
    let s = asyncReducer(initialAsyncState<number>(), { type: 'start', source: A })
    s = asyncReducer(s, { type: 'start', source: B })
    s = asyncReducer(s, { type: 'success', source: A, data: 1, at: 100 })
    expect(s.data).toBeNull()
    s = asyncReducer(s, { type: 'failure', source: A })
    expect(s.failed).toBe(false)
    expect(asyncReducer(s, { type: 'none' })).toEqual(initialAsyncState())
  })
})
