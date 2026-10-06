import { it, expect, describe } from 'vitest'

import { chunkRanges } from './chainLogs'
import {
  canLoadOlder,
  coverageAfterRefresh,
  coverageAfterLoadOlder,
  lowestContiguousFromTop,
} from './historyCoverage'

const W = 9000

/** 模擬一次掃描 [from, to]，failIdx 是失敗段在 chunkRanges 裡的索引。 */
const scan = (from: number, to: number, failIdx: number[] = []) => {
  const ranges = chunkRanges(from, to)
  return lowestContiguousFromTop(ranges, new Set(failIdx.map((i) => ranges[i][0])))
}

describe('lowestContiguousFromTop', () => {
  it('全成功回最低塊；中間失敗回失敗段之上；最高段失敗回 null', () => {
    expect(scan(1000, 1000 + W)).toBe(1000)
    const ranges = chunkRanges(1000, 1000 + W)
    expect(scan(1000, 1000 + W, [3])).toBe(ranges[4][0])
    expect(scan(1000, 1000 + W, [ranges.length - 1])).toBeNull()
  })
})

describe('coverageAfterRefresh', () => {
  it('首訪全成功：覆蓋整個視窗，可以載入較舊', () => {
    const c = coverageAfterRefresh(null, { from: 50_000, to: 59_000 }, scan(50_000, 59_000))
    expect(c).toEqual({ from: 50_000, to: 59_000 })
    expect(canLoadOlder(c)).toBe(true)
  })

  it('首訪中間一段失敗：只宣稱失敗段之上，「載入較舊」仍出現並會重掃失敗段', () => {
    const low = scan(50_000, 59_000, [2])
    const c = coverageAfterRefresh(null, { from: 50_000, to: 59_000 }, low)
    expect(c.from).toBe(low)
    expect(c.from).toBeGreaterThan(50_000)
    expect(canLoadOlder(c)).toBe(true)
  })

  it('首訪最高段就失敗：空覆蓋，但「載入較舊」仍有起點', () => {
    const c = coverageAfterRefresh(null, { from: 50_000, to: 59_000 }, scan(50_000, 59_000, [chunkRanges(50_000, 59_000).length - 1]))
    expect(c).toEqual({ from: 59_001, to: 59_000 })
    expect(canLoadOlder(c)).toBe(true)
  })

  it('常見情況：新視窗與舊覆蓋重疊 → 合併', () => {
    const prev = { from: 30_000, to: 59_000 }
    expect(coverageAfterRefresh(prev, { from: 51_000, to: 60_000 }, scan(51_000, 60_000))).toEqual({ from: 30_000, to: 60_000 })
  })

  it('隔天回訪有缺口：以新視窗為準，不跨過缺口宣稱覆蓋', () => {
    const prev = { from: 30_000, to: 59_000 }
    const c = coverageAfterRefresh(prev, { from: 100_000, to: 109_000 }, scan(100_000, 109_000))
    expect(c).toEqual({ from: 100_000, to: 109_000 })
  })

  it('重疊但新視窗的最低段失敗：連續段與舊覆蓋不相接時，不吃掉失敗段', () => {
    const prev = { from: 30_000, to: 50_000 }
    const low = scan(50_000, 59_000, [0])!
    expect(low).toBeGreaterThan(50_001)
    expect(coverageAfterRefresh(prev, { from: 50_000, to: 59_000 }, low)).toEqual({ from: low, to: 59_000 })
  })

  it('最高段失敗且已有舊覆蓋：維持原狀', () => {
    const prev = { from: 30_000, to: 50_000 }
    expect(coverageAfterRefresh(prev, { from: 51_000, to: 60_000 }, null)).toEqual(prev)
  })
})

describe('coverageAfterLoadOlder', () => {
  it('全成功：下緣往下推到掃描起點', () => {
    const prev = { from: 100_000, to: 109_000 }
    expect(coverageAfterLoadOlder(prev, scan(91_000, 99_999))).toEqual({ from: 91_000, to: 109_000 })
  })

  it('部分失敗：只推到失敗段之上，下次從那裡重掃', () => {
    const prev = { from: 100_000, to: 109_000 }
    const low = scan(91_000, 99_999, [3])
    const c = coverageAfterLoadOlder(prev, low)
    expect(c.from).toBe(low)
    expect(c.from).toBeGreaterThan(91_000)
  })

  it('緊貼下緣那段失敗：不動', () => {
    const prev = { from: 100_000, to: 109_000 }
    expect(coverageAfterLoadOlder(prev, null)).toEqual(prev)
  })

  it('走到區塊 0 就不再提供載入較舊', () => {
    expect(canLoadOlder({ from: 0, to: 5 })).toBe(false)
    expect(canLoadOlder(null)).toBe(false)
  })
})
