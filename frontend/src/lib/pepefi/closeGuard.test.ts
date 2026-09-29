import { it, expect, describe } from 'vitest'

import { ASSET_MODE, closeBlockReason } from './closeGuard'
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
    expect(closeBlockReason({ freshness: undefined, assetLabel: 'sGOLD', assetMode: null })).toBeNull()
    const unknown = classifyFreshness({ updatedAtSec: 0, nowSec: now, maxPriceAgeSec: 3600 })
    expect(closeBlockReason({ freshness: unknown, assetLabel: 'sGOLD', assetMode: null })).toContain('sGOLD')
  })
})
