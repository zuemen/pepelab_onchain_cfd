import { describe, it, expect } from 'vitest'

import {
  parseAllocs,
  buildVolumeMap,
  buildPnlMap,
  buildTraderCard,
  type TraderRawInput,
} from './leaderboardMetrics'

describe('parseAllocs', () => {
  it('把合約回傳的原始陣列轉成 RawAlloc 物件', () => {
    const raw = [{ asset: '0xsBTC', weight: 4_000n, isLong: true, leverage: 3n }]
    expect(parseAllocs(raw)).toEqual([
      { asset: '0xsBTC', weight: 4_000n, isLong: true, leverage: 3n },
    ])
  })

  it('空陣列(尚未發布策略)→ 空陣列', () => {
    expect(parseAllocs([])).toEqual([])
  })
})

describe('buildVolumeMap', () => {
  it('依 owner 加總 margin × leverage', () => {
    const map = buildVolumeMap([
      { owner: '0xAAA', margin: 100n, leverage: 2n },
      { owner: '0xAAA', margin: 50n, leverage: 4n },
      { owner: '0xBBB', margin: 10n, leverage: 1n },
    ])
    expect(map).toEqual({
      '0xaaa': 400n, // 100*2 + 50*4
      '0xbbb': 10n,
    })
  })

  it('owner 地址大小寫不同也會被合併(統一小寫)', () => {
    const map = buildVolumeMap([
      { owner: '0xAAA', margin: 100n, leverage: 1n },
      { owner: '0xaaa', margin: 200n, leverage: 1n },
    ])
    expect(map).toEqual({ '0xaaa': 300n })
  })

  it('沒有任何 PositionOpened 事件(查詢失敗降級為空陣列)→ 空物件', () => {
    expect(buildVolumeMap([])).toEqual({})
  })
})

describe('buildPnlMap', () => {
  it('依 owner 加總 pnl,可正可負', () => {
    const map = buildPnlMap([
      { owner: '0xAAA', pnl: 100n },
      { owner: '0xAAA', pnl: -30n },
      { owner: '0xBBB', pnl: -5n },
    ])
    expect(map).toEqual({ '0xaaa': 70n, '0xbbb': -5n })
  })

  it('沒有任何 PositionClosed 事件(查詢失敗降級為空陣列,或這條鏈上還沒人平倉)→ 空物件', () => {
    expect(buildPnlMap([])).toEqual({})
  })
})

describe('buildTraderCard', () => {
  const base: TraderRawInput = {
    address: '0xAAA',
    displayName: 'Demo Alpha',
    allocs: [],
    followerCount: 0n,
    reputation: null,
    stake: null,
    totalSlashed: null,
  }

  it('無平倉紀錄的交易者 → totalVolume/pnl7d 落回 0n,不是 undefined 或拋錯', () => {
    const card = buildTraderCard(base, {}, {})
    expect(card.totalVolume).toBe(0n)
    expect(card.pnl7d).toBe(0n)
  })

  it('getAllTraders 回傳但沒發布過策略的地址 → hasStrategy 為 false', () => {
    const card = buildTraderCard(base, {}, {})
    expect(card.hasStrategy).toBe(false)
  })

  it('有策略(allocs 非空)→ hasStrategy 為 true', () => {
    const card = buildTraderCard(
      { ...base, allocs: [{ asset: '0xsBTC', weight: 10_000n, isLong: true, leverage: 1n }] },
      {},
      {},
    )
    expect(card.hasStrategy).toBe(true)
  })

  it('volumeMap/pnlMap 有對應地址的資料時,依小寫地址查得到', () => {
    const card = buildTraderCard(
      base,
      { '0xaaa': 500n },
      { '0xaaa': -20n },
    )
    expect(card.totalVolume).toBe(500n)
    expect(card.pnl7d).toBe(-20n)
  })

  it('Promise.allSettled 某一路(reputationScore/getStake)rejected 的降級 → reputation/stake/totalSlashed 保持 null,不影響其他欄位組裝', () => {
    const card = buildTraderCard(base, {}, {})
    expect(card.reputation).toBeNull()
    expect(card.stake).toBeNull()
    expect(card.totalSlashed).toBeNull()
    expect(card.address).toBe('0xAAA')
    expect(card.displayName).toBe('Demo Alpha')
  })
})
