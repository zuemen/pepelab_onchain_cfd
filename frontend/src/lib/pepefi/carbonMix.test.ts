import { it, expect, describe } from 'vitest'

import { carbonTierMix, TIER_BUCKETS } from './carbonMix'

import type { Tier } from './carbon'

const tiers: Record<string, Tier> = { a: 'low', b: 'mid', c: 'high', d: 'unrated' }
const tierOf = (asset: string): Tier | null => tiers[asset] ?? null

const sum = (mix: Record<string, number>) => Object.values(mix).reduce((s, v) => s + v, 0)

describe('carbonTierMix', () => {
  it('依權重算出每一級的比例，加總為 100%', () => {
    const mix = carbonTierMix(
      [
        { asset: 'a', weight: 5 },
        { asset: 'b', weight: 3 },
        { asset: 'c', weight: 2 },
      ],
      tierOf,
    )
    expect(mix.low).toBeCloseTo(50)
    expect(mix.mid).toBeCloseTo(30)
    expect(mix.high).toBeCloseTo(20)
    expect(sum(mix)).toBeCloseTo(100)
  })

  it('讀不到等級的資產列為未知，不算成低碳', () => {
    const mix = carbonTierMix(
      [
        { asset: 'a', weight: 1 },
        { asset: 'not-read', weight: 1 },
      ],
      tierOf,
    )
    expect(mix.low).toBeCloseTo(50)
    expect(mix.unknown).toBeCloseTo(50)
    expect(sum(mix)).toBeCloseTo(100)
  })

  it('未評等（鏈上沒有有效見證）和未知（讀取失敗）是兩件事', () => {
    const mix = carbonTierMix([{ asset: 'd', weight: 1 }], tierOf)
    expect(mix.unrated).toBeCloseTo(100)
    expect(mix.unknown).toBe(0)
  })

  it('同一資產的多筆持倉合併；沒有權重時全部為 0', () => {
    const mix = carbonTierMix(
      [
        { asset: 'a', weight: 1 },
        { asset: 'a', weight: 1 },
        { asset: 'c', weight: 2 },
      ],
      tierOf,
    )
    expect(mix.low).toBeCloseTo(50)
    const empty = carbonTierMix([], tierOf)
    for (const b of TIER_BUCKETS) expect(empty[b]).toBe(0)
  })
})
