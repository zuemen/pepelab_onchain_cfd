import { it, expect, describe } from 'vitest'

import type { Contract } from 'ethers'

import {
  ASSET_MODE,
  isPriceTracked,
  closeBlockReason,
  closeAvailability,
  readOracleFreshness,
} from './closeGuard'

const UNKNOWN_ASSET = '0x' + 'ab'.repeat(32)
const TRACKED = ['0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1']

describe('前端資產表以外的部位（未知 asset）不能被永久擋下平倉', () => {
  it('isPriceTracked：大小寫不敏感；不在清單就是 false', () => {
    expect(isPriceTracked(TRACKED[0].toUpperCase().replace('0X', '0x'), TRACKED)).toBe(true)
    expect(isPriceTracked(UNKNOWN_ASSET, TRACKED)).toBe(false)
  })

  it('未知 asset 讀不到 oracle 價 → 放行，交給合約回報 revert 原因', () => {
    expect(closeBlockReason({ freshness: null, assetLabel: '0xabab', assetMode: null, tracked: false })).toBeNull()
    expect(closeBlockReason({ freshness: undefined, assetLabel: '0xabab', assetMode: null, tracked: false })).toBeNull()
  })

  it('未知 asset 讀到了過期價 → 照樣擋下並說明', () => {
    const now = 1_800_000_000
    const stale = classifyFreshness({ updatedAtSec: now - 99_999, nowSec: now, maxPriceAgeSec: 3600 })
    expect(closeBlockReason({ freshness: stale, assetLabel: '0xabab', assetMode: null, tracked: false })).toContain('0xabab')
  })

  it('輪詢集合內的 asset 還沒讀到價 → 仍然擋下（輪詢遲早會讀到）', () => {
    expect(closeBlockReason({ freshness: undefined, assetLabel: 'sBTC', assetMode: null, tracked: true })).toContain('sBTC')
  })

  it('readOracleFreshness：直接讀 oracle.getPrice 的 updatedAt 與 exchange.maxPriceAge 分級', async () => {
    const now = 1_800_000_000
    const oracle = { getPrice: async () => [100n, BigInt(now - 60)] } as unknown as Contract
    const exchange = { maxPriceAge: async () => 3600n } as unknown as Contract
    expect((await readOracleFreshness(oracle, exchange, UNKNOWN_ASSET, now))?.level).toBe('live')
    const staleOracle = { getPrice: async () => [100n, BigInt(now - 7200)] } as unknown as Contract
    expect((await readOracleFreshness(staleOracle, exchange, UNKNOWN_ASSET, now))?.level).toBe('stale')
  })

  it('readOracleFreshness：oracle revert（例如 GuardedOracle fail-closed）→ null，舊 exchange 沒有 maxPriceAge 用後備值', async () => {
    const now = 1_800_000_000
    const reverting = { getPrice: async () => { throw new Error('StalePrice') } } as unknown as Contract
    expect(await readOracleFreshness(reverting, null, UNKNOWN_ASSET, now)).toBeNull()
    const oracle = { getPrice: async () => [100n, BigInt(now - 60)] } as unknown as Contract
    const oldExchange = { maxPriceAge: async () => { throw new Error('missing revert data') } } as unknown as Contract
    expect((await readOracleFreshness(oracle, oldExchange, UNKNOWN_ASSET, now))?.level).toBe('live')
  })
})

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
