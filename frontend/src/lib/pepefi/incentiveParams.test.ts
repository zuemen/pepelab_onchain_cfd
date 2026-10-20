import { it, expect, describe } from 'vitest'

import {
  bpsToPercent,
  formatWholeTokens,
  tradeMiningReward,
  readIncentiveParams,
  type IncentiveParamsReader,
} from './incentiveParams'

const E18 = 10n ** 18n

// GameFi 的數值（ConfigurePepeIncentivesGameFi.s.sol）。
const gamefi: IncentiveParamsReader = {
  tradeMiningBps: async () => 200n,
  tradeMiningCap: async () => 1_000n * E18,
  copyReward: async () => 500n * E18,
  tierThresholds: async (i) => [5_000n, 25_000n, 100_000n, 500_000n][i] * E18,
  tierRewards: async (i) => [1_000n, 3_000n, 10_000n, 40_000n][i] * E18,
}

describe('readIncentiveParams', () => {
  it('讀出合約上的五組數值', async () => {
    const p = await readIncentiveParams(gamefi)
    expect(p).not.toBeNull()
    expect(p!.tradeMiningBps).toBe(200n)
    expect(p!.copyReward).toBe(500n * E18)
    expect(p!.tierThresholds.map(formatWholeTokens)).toEqual(['5,000', '25,000', '100,000', '500,000'])
    expect(p!.tierRewards.map(formatWholeTokens)).toEqual(['1,000', '3,000', '10,000', '40,000'])
  })

  it('任何一個讀取失敗就回 null，不拿舊的預設值充數', async () => {
    const broken = { ...gamefi, tierRewards: async (i: number) => { if (i === 3) throw new Error('rpc'); return 1n } }
    expect(await readIncentiveParams(broken)).toBeNull()
  })
})

describe('tradeMiningReward', () => {
  it('名目 × bps，封頂 cap——與合約同一個算法', () => {
    const p = { tradeMiningBps: 200n, tradeMiningCap: 1_000n * E18 }
    // 1,000 USDC × 5 倍 = 5,000 名目 → 100 PEPE
    expect(tradeMiningReward(5_000n * E18, p)).toBe(100n * E18)
    expect(tradeMiningReward(1_000_000n * E18, p)).toBe(1_000n * E18)
  })
})

describe('bpsToPercent', () => {
  it('bps 轉成百分比字串', () => {
    expect(bpsToPercent(200n)).toBe('2')
    expect(bpsToPercent(50n)).toBe('0.5')
  })
})
