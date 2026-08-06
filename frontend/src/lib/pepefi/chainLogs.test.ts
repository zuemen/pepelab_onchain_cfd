import { describe, it, expect } from 'vitest'

import {
  CHUNK_SIZE,
  MAX_CHUNKS,
  avgBlockTime,
  chunkRanges,
  deployBlock,
  scanFromBlock,
  blocksForSeconds,
  describeScanWindow,
  DEFAULT_AVG_BLOCK_TIME,
  DEFAULT_SCAN_WINDOW_SEC,
} from './chainLogs'

describe('avgBlockTime', () => {
  it('Base Sepolia 是 2 秒,不是 Ethereum 的 12 秒', () => {
    // F-3 的核心誤差：用 12 秒去換算 Base 的區塊，時間會被高估六倍。
    expect(avgBlockTime(84532)).toBe(2)
    expect(avgBlockTime(11155111)).toBe(12)
  })

  it('不認得的鏈與 null 都退回保守的預設值', () => {
    expect(avgBlockTime(999999)).toBe(DEFAULT_AVG_BLOCK_TIME)
    expect(avgBlockTime(null)).toBe(DEFAULT_AVG_BLOCK_TIME)
    expect(avgBlockTime(undefined)).toBe(DEFAULT_AVG_BLOCK_TIME)
  })
})

describe('blocksForSeconds', () => {
  it('同一段時間在 Base 上是 Ethereum 的六倍塊數', () => {
    expect(blocksForSeconds(84532, 3600)).toBe(1800)
    expect(blocksForSeconds(11155111, 3600)).toBe(300)
  })

  it('永遠至少 1 塊,不會回 0 讓範圍變成空的', () => {
    expect(blocksForSeconds(11155111, 1)).toBe(1)
    expect(blocksForSeconds(11155111, 0)).toBe(1)
  })
})

describe('deployBlock', () => {
  it('Base Sepolia 用自己的部署塊,不是 Ethereum Sepolia 的 10,874,200', () => {
    expect(deployBlock(84532)).toBe(42_838_953)
    expect(deployBlock(11155111)).toBe(10_874_200)
    expect(deployBlock(84532)).not.toBe(deployBlock(11155111))
  })

  it('沒登記的鏈回 undefined,由 scanFromBlock 退回滾動視窗', () => {
    expect(deployBlock(1)).toBeUndefined()
    expect(deployBlock(null)).toBeUndefined()
  })
})

describe('scanFromBlock', () => {
  it('部署塊很久以前時,滾動視窗把起點夾住', () => {
    // 這正是 F-3 的病徵：Base Sepolia 部署在 42.8M，現在是 48M，
    // 直接從部署塊掃就是 5M 塊 ÷ 9,900 = 500 多次 getLogs。
    const currentBlock = 48_000_000
    const from = scanFromBlock({ chainId: 84532, currentBlock })
    expect(from).toBeGreaterThan(42_838_953)
    // 7 天 ÷ 2 秒 = 302,400 塊
    expect(from).toBe(currentBlock - 302_400)
  })

  it('剛部署不久的鏈不會掃到部署塊之前的空白區', () => {
    const currentBlock = 42_900_000 // 部署後約 61k 塊
    const from = scanFromBlock({ chainId: 84532, currentBlock })
    expect(from).toBe(42_838_953)
  })

  it('未知的鏈仍然有界——純滾動視窗', () => {
    const currentBlock = 20_000_000
    const from = scanFromBlock({ chainId: 42, currentBlock })
    expect(from).toBe(currentBlock - Math.ceil(DEFAULT_SCAN_WINDOW_SEC / DEFAULT_AVG_BLOCK_TIME))
  })

  it('不論視窗多大,切出來的段數都不超過 MAX_CHUNKS', () => {
    const currentBlock = 50_000_000
    // 給一個荒謬的視窗（10 年）逼它去撞硬上限
    const from = scanFromBlock({ chainId: 84532, currentBlock, windowSec: 10 * 365 * 86400 })
    expect(chunkRanges(from, currentBlock).length).toBeLessThanOrEqual(MAX_CHUNKS)
  })

  it('鏈高度小於視窗時不會回負數區塊', () => {
    // 部署塊(42.8M)大於節點回報的高度(100)代表我們認錯鏈了 → 退回滾動視窗 → 0
    expect(scanFromBlock({ chainId: 84532, currentBlock: 100 })).toBe(0)
    expect(scanFromBlock({ chainId: 42, currentBlock: 0 })).toBe(0)
  })

  it('起點永遠不會晚於現在的區塊', () => {
    const from = scanFromBlock({ chainId: 11155111, currentBlock: 10_000_000 })
    expect(from).toBeLessThanOrEqual(10_000_000)
  })
})

describe('chunkRanges', () => {
  it('段與段之間不重疊也不留縫——漏一塊就是漏掉整批事件', () => {
    const ranges = chunkRanges(1000, 1000 + CHUNK_SIZE * 3)
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1)
    }
    expect(ranges[0][0]).toBe(1000)
    expect(ranges[ranges.length - 1][1]).toBe(1000 + CHUNK_SIZE * 3)
  })

  it('每一段都不超過節點的 getLogs 上限', () => {
    for (const [from, to] of chunkRanges(0, 100_000)) {
      expect(to - from + 1).toBeLessThanOrEqual(CHUNK_SIZE)
    }
  })

  it('單一區塊的範圍是一段閉區間', () => {
    expect(chunkRanges(500, 500)).toEqual([[500, 500]])
  })

  it('to < from 回空陣列,不會迴圈爆掉', () => {
    expect(chunkRanges(1000, 999)).toEqual([])
  })

  it('剛好等於 CHUNK_SIZE 的範圍只切一段', () => {
    expect(chunkRanges(0, CHUNK_SIZE - 1)).toHaveLength(1)
    expect(chunkRanges(0, CHUNK_SIZE)).toHaveLength(2)
  })
})

describe('describeScanWindow', () => {
  it('同樣的塊數在不同鏈上代表不同長度的時間', () => {
    expect(describeScanWindow(84532, 43_200)).toBe('1.0 天')
    expect(describeScanWindow(11155111, 43_200)).toBe('6.0 天')
  })

  it('小範圍用分鐘', () => {
    expect(describeScanWindow(84532, 300)).toBe('10 分鐘')
  })
})
