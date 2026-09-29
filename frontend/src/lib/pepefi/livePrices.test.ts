import { it, expect, describe } from 'vitest'

import { blocksTrading } from './priceFreshness'
import { buildLivePrices, emptyLivePrices } from './livePrices'

const IDS = ['0xaa', '0xbb', '0xcc'] as const
const PEPE = '0xpepe'
const NOW_SEC = 1785000000

describe('buildLivePrices — 沒有真來源就沒有數字', () => {
  it('RPC 全部失敗、CoinGecko 也讀不到時，不產生任何數字價格', () => {
    const out = buildLivePrices({
      assetIds: IDS,
      cg: {},
      oracleRaw: IDS.map(() => null),
      maxPriceAgeSec: 21600,
      nowSec: NOW_SEC,
      pepeAddr: PEPE,
    })
    for (const key of [...IDS, PEPE]) {
      expect(out[key].usd).toBeNull()
      expect(out[key].source).toBe('none')
      expect(out[key].settlementUsd).toBeUndefined()
      // 無價格 ⇒ freshness unknown ⇒ 擋單
      expect(blocksTrading(out[key].freshness)).toBe(true)
    }
    // 整個結構裡不能藏任何 number 型別的價格欄位
    const numbersInPriceFields = Object.values(out).flatMap((p) =>
      [p.usd, p.settlementUsd].filter((v) => typeof v === 'number'),
    )
    expect(numbersInPriceFields).toEqual([])
  })

  it('oracle 回 0（從未寫入）不算價格', () => {
    const out = buildLivePrices({
      assetIds: ['0xaa'],
      cg: {},
      oracleRaw: [[0n, 0n]],
      maxPriceAgeSec: 21600,
      nowSec: NOW_SEC,
    })
    expect(out['0xaa'].usd).toBeNull()
  })

  it('有 oracle 價就用 oracle，並標來源', () => {
    const out = buildLivePrices({
      assetIds: ['0xaa'],
      cg: {},
      oracleRaw: [[20_000_000_000n, BigInt(NOW_SEC - 60)]],
      maxPriceAgeSec: 21600,
      nowSec: NOW_SEC,
    })
    expect(out['0xaa'].usd).toBe(200)
    expect(out['0xaa'].source).toBe('oracle')
    expect(out['0xaa'].freshness.level).toBe('live')
  })

  it('CoinGecko 有價但 oracle 失敗：顯示 CoinGecko，但仍因無鏈上年齡而擋單', () => {
    const out = buildLivePrices({
      assetIds: ['0xaa'],
      cg: { '0xaa': 65000 },
      oracleRaw: [null],
      maxPriceAgeSec: 21600,
      nowSec: NOW_SEC,
    })
    expect(out['0xaa'].usd).toBe(65000)
    expect(out['0xaa'].source).toBe('coingecko')
    expect(out['0xaa'].settlementUsd).toBeUndefined()
    expect(blocksTrading(out['0xaa'].freshness)).toBe(true)
  })
})

describe('emptyLivePrices — 第一次輪詢前', () => {
  it('每個標的都有一筆無價格（缺 key 會讓擋單判斷變成不擋）', () => {
    const out = emptyLivePrices(IDS, PEPE)
    expect(Object.keys(out).sort()).toEqual([...IDS, PEPE].sort())
    for (const p of Object.values(out)) {
      expect(p.usd).toBeNull()
      expect(blocksTrading(p.freshness)).toBe(true)
    }
  })
})
