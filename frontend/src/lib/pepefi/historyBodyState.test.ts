import { it, expect, describe } from 'vitest'

import { historyBodyState } from './historyBodyState'

const base = { loading: false, scanning: false, eventCount: 0, visibleCount: 0, hasError: false }

describe('historyBodyState', () => {
  it('部位讀完 0 筆、日誌還在掃：骨架，不能先說「尚無活動」', () => {
    expect(historyBodyState({ ...base, scanning: true })).toBe('skeleton')
  })

  it('冷啟動讀取中：骨架', () => {
    expect(historyBodyState({ ...base, loading: true })).toBe('skeleton')
  })

  it('掃完 0 筆且有錯誤（例如 getLogs 範圍被拒）：讀取失敗', () => {
    expect(historyBodyState({ ...base, hasError: true })).toBe('readFailed')
  })

  it('掃完 0 筆且沒有錯誤：空狀態', () => {
    expect(historyBodyState(base)).toBe('empty')
  })

  it('已經有資料：掃描中也保留表格', () => {
    expect(historyBodyState({ ...base, scanning: true, eventCount: 3, visibleCount: 3 })).toBe('table')
  })

  it('有資料但篩選後 0 筆：依錯誤與否顯示讀取失敗或空狀態', () => {
    expect(historyBodyState({ ...base, eventCount: 3, visibleCount: 0 })).toBe('empty')
    expect(historyBodyState({ ...base, eventCount: 3, visibleCount: 0, hasError: true })).toBe('readFailed')
  })
})
