import { it, expect, describe } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import {
  calendarOpen,
  marketClosed,
  SESSION_CLASS,
  sessionClassOf,
  futureWeekendClosed,
} from './marketHours'

/** UTC 牆上時間 → 秒。月份 1 起算，讀起來和日曆一樣。 */
const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

// 2026 年美東夏令時間：3/8（日）02:00 開始、11/1（日）02:00 結束。
// EDT = UTC−4（09:30 ET = 13:30 UTC），EST = UTC−5（09:30 ET = 14:30 UTC）。

describe('美股／ETF 正規時段（含夏令時間）', () => {
  it('夏令時間開始前的週五（EST）：14:30 UTC 開盤、21:00 UTC 收盤', () => {
    expect(marketClosed('sAAPL', utc(2026, 3, 6, 14, 29))).toBe(true)
    expect(marketClosed('sAAPL', utc(2026, 3, 6, 14, 30))).toBe(false)
    expect(marketClosed('sAAPL', utc(2026, 3, 6, 20, 59))).toBe(false)
    expect(marketClosed('sAAPL', utc(2026, 3, 6, 21, 0))).toBe(true)
  })

  it('夏令時間開始後的週一（EDT）：開盤提前到 13:30 UTC、收盤 20:00 UTC', () => {
    expect(marketClosed('sAAPL', utc(2026, 3, 9, 13, 29))).toBe(true)
    expect(marketClosed('sAAPL', utc(2026, 3, 9, 13, 30))).toBe(false)
    expect(marketClosed('sAAPL', utc(2026, 3, 9, 19, 59))).toBe(false)
    expect(marketClosed('sAAPL', utc(2026, 3, 9, 20, 0))).toBe(true)
    // 同一個 UTC 時刻在 EST 時是盤前：14:00 UTC 夏令前是 09:00 ET（休市），夏令後是 10:00 ET（開盤）。
    expect(marketClosed('sAAPL', utc(2026, 3, 6, 14, 0))).toBe(true)
    expect(marketClosed('sAAPL', utc(2026, 3, 9, 14, 0))).toBe(false)
  })

  it('夏令時間結束：10/30（五，EDT）13:30 UTC 開盤，11/2（一，EST）要到 14:30 UTC', () => {
    expect(marketClosed('sNVDA', utc(2026, 10, 30, 13, 30))).toBe(false)
    expect(marketClosed('sNVDA', utc(2026, 11, 2, 13, 30))).toBe(true)
    expect(marketClosed('sNVDA', utc(2026, 11, 2, 14, 29))).toBe(true)
    expect(marketClosed('sNVDA', utc(2026, 11, 2, 14, 30))).toBe(false)
    expect(marketClosed('sNVDA', utc(2026, 11, 2, 21, 0))).toBe(true)
  })

  it('週末整天休市（ETF 同股票）', () => {
    for (const sym of ['sAAPL', 'sBOND', 'sICLN', 'sESGU']) {
      expect(marketClosed(sym, utc(2026, 10, 3, 17, 0)), `${sym} 週六`).toBe(true)
      expect(marketClosed(sym, utc(2026, 10, 4, 17, 0)), `${sym} 週日`).toBe(true)
      expect(marketClosed(sym, utc(2026, 10, 5, 17, 0)), `${sym} 週一盤中`).toBe(false)
    }
  })
})

describe('黃金（COMEX）只在週末休市', () => {
  it('週五 17:00 ET 進入週末休市（EDT：21:00 UTC）', () => {
    expect(marketClosed('sGOLD', utc(2026, 10, 2, 20, 59))).toBe(false)
    expect(marketClosed('sGOLD', utc(2026, 10, 2, 21, 0))).toBe(true)
  })

  it('EST 時是 22:00 UTC', () => {
    expect(marketClosed('sGOLD', utc(2026, 11, 6, 21, 59))).toBe(false)
    expect(marketClosed('sGOLD', utc(2026, 11, 6, 22, 0))).toBe(true)
  })

  it('週六整天休市，週日 18:00 ET 重新開盤', () => {
    expect(marketClosed('sGOLD', utc(2026, 10, 3, 12, 0))).toBe(true)
    expect(marketClosed('sGOLD', utc(2026, 10, 4, 21, 59))).toBe(true)
    expect(marketClosed('sGOLD', utc(2026, 10, 4, 22, 0))).toBe(false)
  })

  it('平日 17:00–18:00 ET 的每日休息不算休市（keeper 也不切停單）', () => {
    const wedBreak = utc(2026, 9, 30, 21, 30) // 週三 17:30 EDT
    expect(calendarOpen('future', wedBreak)).toBe(false)
    expect(futureWeekendClosed(wedBreak)).toBe(false)
    expect(marketClosed('sGOLD', wedBreak)).toBe(false)
  })
})

describe('加密資產 24/7', () => {
  it('週末、深夜、夏令切換當天都不休市', () => {
    for (const ts of [utc(2026, 10, 3, 12, 0), utc(2026, 10, 4, 3, 0), utc(2026, 3, 8, 7, 0), utc(2026, 11, 1, 6, 30)]) {
      expect(marketClosed('sBTC', ts)).toBe(false)
      expect(marketClosed('sETH', ts)).toBe(false)
    }
  })
})

describe('資產分類', () => {
  it('前端的每一顆資產都有分類——新資產忘了分類會被當 equity（休市時寧可顯示休市）', () => {
    for (const sym of Object.keys(ASSET_IDS)) {
      expect(SESSION_CLASS[sym], sym).toBeDefined()
    }
    expect(sessionClassOf('sNEW')).toBe('equity')
  })
})
