import { it, expect, describe } from 'vitest'

import { ASSET_MODE, closeBlockReason, closeAvailability } from './closeGuard'

const TRADER = '0x1111111111111111111111111111111111111111'
const ZERO = '0x0000000000000000000000000000000000000000'

describe('closeAvailability — 跟單部位不能卡住', () => {
  it('屬於仍 active 的跟單紀錄 → managed（走取消跟單）', () => {
    expect(closeAvailability({ id: 7n, copiedFrom: TRADER }, new Set(['7']))).toBe('managed')
  })

  it('跟單紀錄已 inactive（不在 active 集合裡）→ leftover，給平倉按鈕', () => {
    expect(closeAvailability({ id: 7n, copiedFrom: TRADER }, new Set(['8', '9']))).toBe('leftover')
  })

  it('跟單紀錄讀取失敗（null）→ leftover，不擋', () => {
    expect(closeAvailability({ id: 7n, copiedFrom: TRADER }, null)).toBe('leftover')
  })

  it('沒有任何跟單紀錄 → leftover', () => {
    expect(closeAvailability({ id: 7n, copiedFrom: TRADER }, new Set())).toBe('leftover')
  })

  it('自己開的部位 → own；零位址、大小寫不影響', () => {
    expect(closeAvailability({ id: 1n, copiedFrom: ZERO }, new Set())).toBe('own')
    expect(closeAvailability({ id: 1n, copiedFrom: '' }, null)).toBe('own')
    expect(closeAvailability({ id: 1n }, null)).toBe('own')
  })
})
import { classifyFreshness } from './priceFreshness'

const now = 1_800_000_000
const fresh = classifyFreshness({ updatedAtSec: now - 30, nowSec: now, maxPriceAgeSec: 3600 })
const stale = classifyFreshness({ updatedAtSec: now - 7200, nowSec: now, maxPriceAgeSec: 3600 })

describe('closeBlockReason', () => {
  it('價格新鮮、合約沒有 assetMode（舊合約）→ 可以平倉', () => {
    expect(closeBlockReason({ freshness: fresh, assetLabel: 'sBTC', assetMode: null })).toBeNull()
  })

  it('Active 與 ReduceOnly 都可以平倉——ReduceOnly 只擋新曝險', () => {
    expect(closeBlockReason({ freshness: fresh, assetLabel: 'sBTC', assetMode: ASSET_MODE.Active })).toBeNull()
    expect(closeBlockReason({ freshness: fresh, assetLabel: 'sBTC', assetMode: ASSET_MODE.ReduceOnly })).toBeNull()
  })

  it('Halted 擋平倉並指名標的', () => {
    const r = closeBlockReason({ freshness: fresh, assetLabel: 'sAAPL', assetMode: ASSET_MODE.Halted })
    expect(r).toContain('sAAPL')
  })

  it('價格過期或未知 → 擋，理由含標的', () => {
    expect(closeBlockReason({ freshness: stale, assetLabel: 'sGOLD', assetMode: null })).toContain('sGOLD')
    // 價格還沒讀到 → 視為 unknown 擋下，不放行。
    expect(closeBlockReason({ freshness: undefined, assetLabel: 'sGOLD', assetMode: null })).toContain('sGOLD')
    expect(closeBlockReason({ freshness: null, assetLabel: 'sGOLD', assetMode: null })).toContain('sGOLD')
    const unknown = classifyFreshness({ updatedAtSec: 0, nowSec: now, maxPriceAgeSec: 3600 })
    expect(closeBlockReason({ freshness: unknown, assetLabel: 'sGOLD', assetMode: null })).toContain('sGOLD')
  })
})
