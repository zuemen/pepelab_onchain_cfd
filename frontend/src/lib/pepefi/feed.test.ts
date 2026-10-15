import { describe, it, expect } from 'vitest'

import { WHALE_THRESHOLD } from './whale'
import {
  buildFeed,
  filterFeed,
  diffStrategy,
  sidesOfMarket,
  isFeedIncomplete,
  type FeedEvent,
  type FeedLeg,
  type FeedItem,
} from './feed'

const E18 = 10n ** 18n
const ALICE = '0x00000000000000000000000000000000000000AA'
const BOB = '0x00000000000000000000000000000000000000bb'
const F1 = '0x00000000000000000000000000000000000000f1'
const F2 = '0x00000000000000000000000000000000000000f2'
const DAY0 = 1_760_000_000 // 2025-10-09 08:53 UTC

let seq = 0
const at = (block: number, timestamp = DAY0 + block * 60) => ({
  blockNumber: block,
  logIndex: 0,
  timestamp,
  txHash: `0xtx${block}-${seq++}`,
})

const open = (block: number, positionId: string, notionalUsd: bigint, owner = ALICE, extra: Partial<FeedEvent> = {}): FeedEvent => ({
  ...at(block), kind: 'open', owner, positionId, asset: 'sETH', isLong: true, leverage: 2n, notional: notionalUsd * E18, ...extra,
} as FeedEvent)

const legs = (...rows: [string, number, boolean][]): FeedLeg[] =>
  rows.map(([asset, weightBps, isLong]) => ({ asset, weightBps, isLong, leverage: 1 }))

const names = new Map([[ALICE.toLowerCase(), 'Whale Alpha']])
const ctx = (versions: Record<string, FeedLeg[]> = {}) => ({ names, versions: new Map(Object.entries(versions)) })

const only = <T extends FeedItem['type']>(items: FeedItem[], type: T) =>
  items.filter((i): i is Extract<FeedItem, { type: T }> => i.type === type)

describe('buildFeed — one case per kind of event', () => {
  it('lists an open at or above the whale threshold and skips a small one', () => {
    const items = buildFeed([open(1, '1', 5_000n), open(2, '2', 4_999n)], ctx())
    expect(only(items, 'bigOpen').map((i) => i.notional)).toEqual([WHALE_THRESHOLD])
  })

  it('lists a close of a big position with its PnL, sized from its own open', () => {
    const events: FeedEvent[] = [open(1, '7', 8_000n), { ...at(5), kind: 'close', owner: ALICE, positionId: '7', pnl: 120n * E18 }]
    const [close] = only(buildFeed(events, ctx()), 'bigClose')
    expect(close).toMatchObject({ asset: 'sETH', isLong: true, notional: 8_000n * E18, pnl: 120n * E18 })
  })

  it('skips a close whose open is outside the window, because its size is unknown', () => {
    const events: FeedEvent[] = [{ ...at(5), kind: 'close', owner: ALICE, positionId: '99', pnl: 1n }]
    expect(buildFeed(events, ctx())).toEqual([])
  })

  it('always lists a liquidation, even a small one or one whose open is out of the window', () => {
    const events: FeedEvent[] = [
      open(1, '3', 100n),
      { ...at(2), kind: 'liquidated', owner: ALICE, positionId: '3', pnl: -90n * E18 },
      { ...at(3), kind: 'liquidated', owner: BOB, positionId: '404', pnl: -5n * E18 },
    ]
    const liquidations = only(buildFeed(events, ctx()), 'liquidation')
    expect(liquidations.map((l) => [l.asset, l.notional])).toEqual([[null, null], ['sETH', 100n * E18]])
  })

  it('lists a slash with its amount', () => {
    const [slash] = buildFeed([{ ...at(4), kind: 'slash', trader: ALICE, follower: F1, amount: 30n * E18 }], ctx())
    expect(slash).toMatchObject({ type: 'slash', actor: ALICE.toLowerCase(), amount: 30n * E18 })
  })

  it('lists a strategy publication with the difference from the previous version', () => {
    const events: FeedEvent[] = [{ ...at(9), kind: 'publish', trader: ALICE, versionId: 3 }]
    const versions = {
      [`${ALICE.toLowerCase()}:2`]: legs(['sBTC', 5000, true], ['sETH', 3000, true], ['sGOLD', 2000, true]),
      [`${ALICE.toLowerCase()}:3`]: legs(['sBTC', 4000, true], ['sETH', 3000, false], ['sBOND', 3000, true]),
    }
    const [item] = only(buildFeed(events, ctx(versions)), 'strategy')
    expect(item.first).toBe(false)
    expect(item.diff).toEqual({
      added: [{ asset: 'sBOND', weightBps: 3000, isLong: true }],
      removed: [{ asset: 'sGOLD' }],
      reweighted: [{ asset: 'sBTC', fromBps: 5000, toBps: 4000 }],
      flipped: [{ asset: 'sETH', isLong: false }],
    })
  })

  it('marks the first version as first and has no difference to show', () => {
    const versions = { [`${ALICE.toLowerCase()}:0`]: legs(['sBTC', 5000, true], ['sETH', 5000, true]) }
    const [item] = only(buildFeed([{ ...at(1), kind: 'publish', trader: ALICE, versionId: 0 }], ctx(versions)), 'strategy')
    expect(item).toMatchObject({ first: true, diff: null })
    expect(item.legs).toHaveLength(2)
  })

  it('still lists a publication whose previous version could not be read, without a difference', () => {
    const versions = { [`${ALICE.toLowerCase()}:5`]: legs(['sBTC', 10000, true]) }
    const [item] = only(buildFeed([{ ...at(1), kind: 'publish', trader: ALICE, versionId: 5 }], ctx(versions)), 'strategy')
    expect(item).toMatchObject({ first: false, diff: null })
  })
})

describe('buildFeed — follows', () => {
  it('merges the same trader’s follows on the same UTC day into one item without follower addresses', () => {
    const events: FeedEvent[] = [
      { ...at(1), kind: 'follow', trader: ALICE, follower: F1, totalMargin: 500n * E18 },
      { ...at(2), kind: 'follow', trader: ALICE, follower: F2, totalMargin: 1_000n * E18 },
    ]
    const items = buildFeed(events, ctx())
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'follow', count: 2, totalMargin: 1_500n * E18, day: '2025-10-09' })
    expect(JSON.stringify(items, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/f1|f2/)
  })

  it('keeps different days, different traders and unfollows apart', () => {
    const events: FeedEvent[] = [
      { ...at(1), kind: 'follow', trader: ALICE, follower: F1, totalMargin: 1n },
      { ...at(2, DAY0 + 86_400), kind: 'follow', trader: ALICE, follower: F2, totalMargin: 1n },
      { ...at(3), kind: 'follow', trader: BOB, follower: F1, totalMargin: 1n },
      { ...at(4), kind: 'unfollow', trader: ALICE, follower: F1 },
    ]
    const items = buildFeed(events, ctx())
    expect(items.map((i) => i.type).sort()).toEqual(['follow', 'follow', 'follow', 'unfollow'])
  })
})

describe('buildFeed — names and order', () => {
  it('names a registered trader and leaves an unregistered address without a name', () => {
    const items = buildFeed([open(1, '1', 9_000n, ALICE), open(2, '2', 9_000n, BOB)], ctx())
    expect(items.map((i) => [i.actor, i.actorName])).toEqual([
      [BOB.toLowerCase(), null],
      [ALICE.toLowerCase(), 'Whale Alpha'],
    ])
  })

  it('sorts newest first by block, then by log index inside a block', () => {
    const a = { ...open(5, '1', 9_000n), logIndex: 1 }
    const b = { ...open(5, '2', 9_000n), logIndex: 4 }
    const c = open(7, '3', 9_000n)
    const items = buildFeed([a, c, b], ctx())
    expect(items.map((i) => [i.blockNumber, i.logIndex])).toEqual([[7, 0], [5, 4], [5, 1]])
  })
})

describe('diffStrategy', () => {
  it('reports nothing when the two versions are the same', () => {
    const same = legs(['sBTC', 5000, true], ['sETH', 5000, true])
    expect(diffStrategy(same, same)).toEqual({ added: [], removed: [], reweighted: [], flipped: [] })
  })
})

describe('filterFeed', () => {
  const items = buildFeed(
    [open(1, '1', 9_000n, ALICE), open(2, '2', 9_000n, BOB), { ...at(3), kind: 'slash', trader: ALICE, follower: F1, amount: 1n }],
    ctx()
  )

  it('keeps only the chosen types', () => {
    expect(filterFeed(items, { types: ['slash'] }).map((i) => i.type)).toEqual(['slash'])
  })

  it('keeps only one trader, whatever the case of the address', () => {
    expect(filterFeed(items, { actor: ALICE }).every((i) => i.actor === ALICE.toLowerCase())).toBe(true)
    expect(filterFeed(items, { actor: ALICE })).toHaveLength(2)
  })
})

describe('isFeedIncomplete', () => {
  it('is incomplete when any scan reported a failed chunk', () => {
    expect(isFeedIncomplete([0, 2])).toBe(true)
    expect(isFeedIncomplete([0, 0])).toBe(false)
  })
})

describe('sidesOfMarket', () => {
  const sentiment = [
    { asset: 'sBTC', longShare: 0.7, total: 10n },
    { asset: 'sETH', longShare: 0.5, total: 10n },
    { asset: 'sGOLD', longShare: 0.2, total: 10n },
  ]

  it('says whether the trader is on the same side as most of the market', () => {
    const rows = sidesOfMarket(
      [{ asset: 'sBTC', isLong: true }, { asset: 'sGOLD', isLong: true }, { asset: 'sETH', isLong: false }, { asset: 'sBOND', isLong: true }],
      sentiment
    )
    expect(rows.map((r) => r.withMajority)).toEqual([true, false, null, null])
    expect(rows[3].longShare).toBeNull()
  })

  it('calls a market that rounds to 50% / 50% evenly split, not a side', () => {
    const [row] = sidesOfMarket([{ asset: 'sBTC', isLong: true }], [{ asset: 'sBTC', longShare: 0.4996, total: 10n }])
    expect(row.withMajority).toBeNull()
  })
})
