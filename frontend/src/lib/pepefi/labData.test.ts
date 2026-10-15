import { describe, it, expect } from 'vitest'

import {
  parseLabIndex,
  parseLabResult,
  fetchLabIndex,
  fetchLabResult,
  fetchSimilarTraders,
  labResultFile,
  similarTraders,
  snapParams,
  dayToDate,
  type LabStrategy,
} from './labData'

const strategies: LabStrategy[] = [
  { id: 'martingale', kind: 'single', rule: null, params: [{ key: 'multiplier', values: [1.5, 2] }, { key: 'drop_pct', values: [5, 10] }] },
  { id: 'momentum', kind: 'portfolio', rule: 'momentum', params: [{ key: 'lookback', values: [30, 90] }, { key: 'leverage', values: [1, 2] }] },
]
const index = {
  schemaVersion: 1,
  range: { from: '2024-10-01', to: '2026-10-13' },
  capitalUsd: 10000,
  tradeFields: ['day', 'asset', 'action', 'isLong', 'price', 'marginUsd', 'pnlUsd'],
  martingaleBasePct: 2,
  forecast: { horizonDays: 90, paths: 1000, blockDays: 10, seed: 332, percentiles: [5, 25, 50, 75, 95] },
  assets: [{ id: 'sETH', carbonTier: 'low', feeBps: 10, borrowBpsPerHour: 1, maxLeverage: 5 }],
  baskets: [{ id: 'macro', assets: ['sGOLD', 'sBOND', 'sBTC', 'sESGU'] }],
  strategies,
}
const metrics = { totalReturnPct: 1.2, maxDrawdownPct: 3.4, sharpe: 0.5, winRatePct: null, closedTrades: 0, trades: 1, riskScore: null }
const band = [10000, 10010]
const result = {
  schemaVersion: 1,
  strategy: 'martingale',
  target: 'sETH',
  params: { multiplier: 2, drop_pct: 5 },
  start: '2024-10-01',
  equity: [10000, 10020],
  benchmark: [10000, 9990],
  trades: [[0, 'sETH', 'open', true, 2400.5, 199.8, null], [1, 'sETH', 'close', true, 2600, 199.8, 15.2]],
  metrics,
  benchmarkMetrics: metrics,
  forecast: { from: '2026-10-13', percentiles: { p5: band, p25: band, p50: band, p75: band, p95: band }, lossProbPct: 40, halfLossProbPct: 2.5 },
}

const serving = (files: Record<string, unknown>) => async (url: string) => {
  const name = url.split('/').pop() as string
  return name in files ? { ok: true, json: async () => files[name] } : { ok: false, json: async () => ({}) }
}

describe('parseLabIndex', () => {
  it('accepts the published format', () => {
    expect(parseLabIndex(index)?.strategies.map((s) => s.id)).toEqual(['martingale', 'momentum'])
  })

  it('refuses another format version', () => {
    expect(parseLabIndex({ ...index, schemaVersion: 2 })).toBeNull()
  })

  it.each(['range', 'capitalUsd', 'forecast', 'assets', 'baskets', 'strategies'])('refuses the whole index without %s', (key) => {
    const { [key]: _, ...rest } = index as Record<string, unknown>
    expect(parseLabIndex(rest)).toBeNull()
  })

  it('refuses a strategy with an empty parameter grid', () => {
    expect(parseLabIndex({ ...index, strategies: [{ ...strategies[0], params: [] }] })).toBeNull()
  })
})

describe('parseLabResult', () => {
  it('turns each trade row into an object', () => {
    const parsed = parseLabResult(result, 'martingale', 'sETH')
    expect(parsed?.trades[1]).toEqual({ day: 1, asset: 'sETH', action: 'close', isLong: true, price: 2600, marginUsd: 199.8, pnlUsd: 15.2 })
  })

  it('refuses a file for another strategy or target', () => {
    expect(parseLabResult(result, 'grid', 'sETH')).toBeNull()
    expect(parseLabResult(result, 'martingale', 'sBTC')).toBeNull()
  })

  it('refuses another format version', () => {
    expect(parseLabResult({ ...result, schemaVersion: 2 }, 'martingale', 'sETH')).toBeNull()
  })

  it.each(['equity', 'benchmark', 'trades', 'metrics', 'benchmarkMetrics', 'forecast'])('refuses the whole file without %s', (key) => {
    const { [key]: _, ...rest } = result as Record<string, unknown>
    expect(parseLabResult(rest, 'martingale', 'sETH')).toBeNull()
  })

  it('refuses a malformed trade row or a missing percentile band', () => {
    expect(parseLabResult({ ...result, trades: [[0, 'sETH', 'buy', true, 1, 1, null]] }, 'martingale', 'sETH')).toBeNull()
    const { p95: _, ...four } = result.forecast.percentiles
    expect(parseLabResult({ ...result, forecast: { ...result.forecast, percentiles: four } }, 'martingale', 'sETH')).toBeNull()
  })
})

describe('reading the files', () => {
  it('builds the same file name as the data pipeline', () => {
    expect(labResultFile('martingale', 'sETH', [1.5, 5, 10])).toBe('martingale__sETH__1.5_5_10.json')
    expect(labResultFile('dca', 'sBTC', [7, 2])).toBe('dca__sBTC__7_2.json')
  })

  it('reads the index and one result', async () => {
    const fetchImpl = serving({ 'index.json': index, 'martingale__sETH__2_5.json': result })
    expect(await fetchLabIndex(fetchImpl)).not.toBeNull()
    expect((await fetchLabResult('martingale', 'sETH', [2, 5], fetchImpl))?.equity).toEqual([10000, 10020])
  })

  it('gives null when a file is missing or the fetch throws', async () => {
    expect(await fetchLabResult('martingale', 'sETH', [1.5, 5], serving({}))).toBeNull()
    expect(await fetchLabIndex(async () => { throw new Error('offline') })).toBeNull()
  })
})

// ── 相近的模擬交易者：只在連線的鏈有 #309 績效資料、而且裡面有那位交易者時才顯示 ──

const window = { pnlUsd: 0, marginUsd: 0, volumeUsd: 0, wins: 0, trades: 0 }
const hero = (address: string, name: string, rule: string) => ({
  address, name, rule, totalReturnPct: 1, maxDrawdownPct: 1, sharpe: 1, winRatePct: null, closedTrades: 0,
  esgScore: null, window7d: window, window30d: window, sparkline: [], activeSince: null,
})
const heroIndex = {
  schemaVersion: 2,
  chainId: 31337,
  range: { from: '2024-10-01', to: '2026-10-13' },
  traders: [
    hero('0x00000000000000000000000000000000000000aa', 'Momentum Mike', 'momentum'),
    hero('0x00000000000000000000000000000000000000bb', 'Whale Alpha', 'buy_hold'),
  ],
}

describe('similarTraders', () => {
  it('shows the traders that use the same rule when the connected chain has the data', () => {
    expect(similarTraders(strategies[1], heroIndex, 31337).map((h) => h.name)).toEqual(['Momentum Mike'])
  })

  it('shows nothing when the data belongs to another chain', () => {
    expect(similarTraders(strategies[1], heroIndex, 84532)).toEqual([])
  })

  it('shows nothing when there is no performance data', () => {
    expect(similarTraders(strategies[1], null, 31337)).toEqual([])
  })

  it('shows nothing when no wallet is connected', () => {
    expect(similarTraders(strategies[1], heroIndex, null)).toEqual([])
  })

  it('shows nothing when the data has no trader with that rule', () => {
    const others = { ...heroIndex, traders: [heroIndex.traders[1]] }
    expect(similarTraders(strategies[1], others, 31337)).toEqual([])
  })

  it('shows nothing for a per-trade strategy, which cannot be copied on chain', () => {
    expect(similarTraders(strategies[0], heroIndex, 31337)).toEqual([])
  })
})

describe('fetchSimilarTraders', () => {
  it('reads the leaderboard data of the connected chain', async () => {
    const traders = await fetchSimilarTraders(strategies[1], 31337, serving({ 'index.json': heroIndex }))
    expect(traders.map((h) => h.address)).toEqual(['0x00000000000000000000000000000000000000aa'])
  })

  it('reads nothing when no wallet is connected or the file is missing', async () => {
    expect(await fetchSimilarTraders(strategies[1], null, serving({ 'index.json': heroIndex }))).toEqual([])
    expect(await fetchSimilarTraders(strategies[1], 31337, serving({}))).toEqual([])
  })
})

describe('helpers', () => {
  it('snaps parameters to the grid and falls back to the first value', () => {
    expect(snapParams(strategies[0], { multiplier: 2, drop_pct: 7 })).toEqual([2, 5])
    expect(snapParams(strategies[0], {})).toEqual([1.5, 5])
  })

  it('turns a day number into a calendar date', () => {
    expect(dayToDate('2024-10-01', 0)).toBe('2024-10-01')
    expect(dayToDate('2024-10-01', 31)).toBe('2024-11-01')
  })
})
