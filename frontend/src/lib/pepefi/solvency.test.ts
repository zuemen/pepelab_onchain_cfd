import type { SolvencyDeps, RawReserveLog } from './solvency'
import { CHUNK_SIZE } from './chainLogs'

import { it, expect, describe } from 'vitest'

import { ok, FAILED, selectorOf, UNSUPPORTED } from './contractProbe'
import {
  formatRatio,
  formatAmount,
  loadSolvency,
  HISTORY_CHUNK,
  buildWaterfall,
  plottablePoints,
  loadReserveHistory,
  SOLVENCY_EXCHANGE_VIEWS,
} from './solvency'

const codeWith = (sigs: readonly string[]) => `0x${sigs.map((s) => `63${selectorOf(s).slice(2)}`).join('')}00`
const E18 = 10n ** 18n
const MAX = (1n << 256n) - 1n

function deps(over: Partial<SolvencyDeps> = {}): SolvencyDeps {
  return {
    exchangeCode: async () => codeWith(SOLVENCY_EXCHANGE_VIEWS),
    usdcDecimals: async () => 18n,
    exchangeUsdcBalance: async () => 500n * E18,
    nextPositionId: async () => 3n,
    getPosition: async (id) => ({ isOpen: id !== 1, margin: 100n * E18, asset: '0x' + '01'.repeat(32) }),
    getUnrealizedPnL: async (id) => (id === 0 ? -10n * E18 : 25n * E18),
    solvencyFlags: async () => ({ adl: true }),
    insuranceTotalAssets: async () => 1_000n * E18,
    vault: {
      reserveStatus: async () => ({
        reserve_: 201_291_500n * 10n ** 15n,
        liability: 1_375_262_711_626_364_115_023n,
        ratioBps: 1_463_658n,
        unpriced: 0n,
        stale: false,
        halted: false,
      }),
      minReserveRatioBps: async () => 11_000n,
    },
    timeoutMs: 200,
    ...over,
  }
}

describe('loadSolvency', () => {
  it('彙總未平倉部位的保證金與未實現損益（已平倉不算）', async () => {
    const s = await loadSolvency(deps())
    expect(s.exchangeBalance).toEqual(ok(500n * E18))
    expect(s.positions.status).toBe('ok')
    expect(s.positions.open).toBe(2)
    expect(s.positions.totalMargin).toBe(200n * E18)
    expect(s.positions.unrealizedPnl).toBe(15n * E18)
    expect(s.insuranceAssets).toEqual(ok(1_000n * E18))
    expect(s.adl).toEqual(ok(true))
    expect(s.vault.status).toBe('ok')
    if (s.vault.status === 'ok') {
      expect(s.vault.value.ratioBps).toBe(1_463_658n)
      expect(s.vault.value.minRatioBps).toEqual(ok(11_000n))
    }
  })

  it('沒有任何部位（nextPositionId = 0）：合計是 0，狀態 ok', async () => {
    const s = await loadSolvency(deps({ nextPositionId: async () => 0n }))
    expect(s.positions.status).toBe('ok')
    expect(s.positions.nextId).toBe(0)
    expect(s.positions.totalMargin).toBe(0n)
  })

  it('讀取失敗是「讀取失敗」不是 0：nextPositionId、餘額、保險金庫、金庫', async () => {
    const fail = () => Promise.reject(new Error('rpc down'))
    const s = await loadSolvency(
      deps({
        nextPositionId: fail,
        exchangeUsdcBalance: fail,
        insuranceTotalAssets: fail,
        vault: { reserveStatus: fail, minReserveRatioBps: fail },
      })
    )
    expect(s.positions.status).toBe('failed')
    expect(s.exchangeBalance).toEqual(FAILED)
    expect(s.insuranceAssets).toEqual(FAILED)
    expect(s.vault).toEqual(FAILED)
    const w = buildWaterfall(s)
    expect(w[0].amount).toEqual(FAILED)
    expect(w[1].amount).toEqual(FAILED)
  })

  it('部分部位讀不到 → partial，並計數', async () => {
    const s = await loadSolvency(
      deps({
        getPosition: async (id) => {
          if (id === 2) throw new Error('dropped')
          return { isOpen: true, margin: 100n * E18, asset: '0x' + '01'.repeat(32) }
        },
      })
    )
    expect(s.positions.status).toBe('partial')
    expect(s.positions.missed).toBe(1)
    expect(s.positions.totalMargin).toBe(200n * E18)
  })

  it('函式不存在的降級：adlEnabled／getPosition 不在 bytecode → unsupported；沒部署金庫 → notDeployed', async () => {
    const s = await loadSolvency(
      deps({
        exchangeCode: async () => codeWith(['nextPositionId()']),
        insuranceTotalAssets: null,
        vault: null,
      })
    )
    expect(s.adl).toEqual(UNSUPPORTED)
    expect(s.positions.status).toBe('unsupported')
    expect(s.insuranceAssets).toEqual(UNSUPPORTED)
    expect(s.vault).toEqual({ status: 'notDeployed' })
    const w = buildWaterfall(s)
    expect(w.map((l) => l.key)).toEqual(['margin', 'insurance', 'adl', 'badDebt'])
    expect(w[0].amount).toEqual(UNSUPPORTED)
    expect(w[2].enabled).toEqual(UNSUPPORTED)
  })

  it('沒有負債時 ratioBps 是 uint256 max → null（比率無意義），不是天文數字', async () => {
    const s = await loadSolvency(
      deps({
        vault: {
          reserveStatus: async () => ({ reserve_: 1n, liability: 0n, ratioBps: MAX, unpriced: 0n, stale: false, halted: false }),
          minReserveRatioBps: async () => 11_000n,
        },
      })
    )
    expect(s.vault.status === 'ok' && s.vault.value.ratioBps).toBeNull()
  })

  it('decimals 讀不到時是 null（不默默用 18）', async () => {
    const s = await loadSolvency(deps({ usdcDecimals: () => Promise.reject(new Error('rpc')) }))
    expect(s.usdcDecimals).toBeNull()
    const weird = await loadSolvency(deps({ usdcDecimals: async () => 255n }))
    expect(weird.usdcDecimals).toBeNull()
  })

  it('ADL 沿用 readSolvencyFlags：null 是讀取失敗；函式存在但讀不到不是「關閉」', async () => {
    const s = await loadSolvency(deps({ solvencyFlags: async () => ({ adl: null }) }))
    expect(s.adl).toEqual(FAILED)
    const off = await loadSolvency(deps({ solvencyFlags: async () => ({ adl: false }) }))
    expect(off.adl).toEqual(ok(false))
  })

  it('掃描上限：超過時標示 truncated', async () => {
    const s = await loadSolvency(deps({ nextPositionId: async () => 10n, maxScan: 4 }))
    expect(s.positions.scanned).toBe(4)
    expect(s.positions.truncated).toBe(true)
  })
})

describe('loadReserveHistory', () => {
  const log = (block: number, ratio: bigint, unpriced = 0n): RawReserveLog => ({
    blockNumber: block,
    args: { reserve: 2n * E18, liability: E18, ratioBps: ratio, unpriced, timestamp: BigInt(1_791_000_000 + block) },
  })

  it('每段不超過 500 塊（公開節點上限），結果依區塊排序', async () => {
    const ranges: Array<[number, number]> = []
    const h = await loadReserveHistory({
      latestBlock: async () => 10_000,
      windowBlocks: 2_000,
      getLogs: async (from, to) => {
        ranges.push([from, to])
        return from <= 9_500 && 9_500 <= to ? [log(9_500, 20_000n)] : from <= 8_100 && 8_100 <= to ? [log(8_100, 15_000n)] : []
      },
    })
    expect(h.status).toBe('ok')
    expect(Math.max(...ranges.map(([a, b]) => b - a + 1))).toBeLessThanOrEqual(HISTORY_CHUNK)
    expect(HISTORY_CHUNK).toBeLessThanOrEqual(500)
    expect(h.fromBlock).toBe(8_001)
    expect(HISTORY_CHUNK).toBe(CHUNK_SIZE)
    expect(h.points.map((p) => p.block)).toEqual([8_100, 9_500])
  })

  it('全部失敗 → failed（畫面顯示「讀取失敗」而不是 0）；部分失敗 → partial', async () => {
    const all = await loadReserveHistory({
      latestBlock: async () => 1_000,
      windowBlocks: 900,
      retries: 0,
      getLogs: () => Promise.reject(new Error('429 too many requests')),
    })
    expect(all.status).toBe('failed')
    expect(all.points).toEqual([])

    let n = 0
    const part = await loadReserveHistory({
      latestBlock: async () => 1_000,
      windowBlocks: 900,
      retries: 0,
      concurrency: 1,
      getLogs: async () => {
        n += 1
        if (n === 1) throw new Error('429')
        return []
      },
    })
    expect(part.status).toBe('partial')
    expect(part.failedChunks).toBe(1)

    const noBlock = await loadReserveHistory({ latestBlock: () => Promise.reject(new Error('x')), getLogs: async () => [], timeoutMs: 50 })
    expect(noBlock.status).toBe('failed')
  })

  it('plottablePoints 去掉無負債與有未計價資產的點', async () => {
    const h = await loadReserveHistory({
      latestBlock: async () => 100,
      windowBlocks: 100,
      getLogs: async () => [log(10, 20_000n), log(20, MAX), log(30, 18_000n, 1n)],
    })
    expect(h.points).toHaveLength(3)
    expect(plottablePoints(h.points).map((p) => p.block)).toEqual([10])
  })
})

describe('格式', () => {
  it('formatAmount／formatRatio', () => {
    expect(formatAmount(500n * E18, 18)).toBe('500.00')
    expect(formatAmount(201_291_500n * 10n ** 15n, 18)).toBe('201,291.50')
    expect(formatAmount(-15n * E18 / 10n, 18)).toBe('-1.50')
    expect(formatAmount(1_234_567n, 6, 2)).toBe('1.23')
    expect(formatRatio(1_463_658n)).toBe('14,636.58%')
    expect(formatRatio(11_000n)).toBe('110.00%')
  })
})
