import { describe, it, expect } from 'vitest'

import {
  syncStatus,
  hoursLabel,
  syncCostWei,
  versionLabel,
  parseEthInput,
  clampLeverage,
  parseSyncState,
  syncsAffordable,
  parseSyncConfig,
  settingsProblem,
  selfSyncShortfall,
  effectiveLeverage,
  defaultPrefundWei,
  defaultMaxLeverage,
  followWithAutoSyncValue,
  sameAddress,
  parseExecutor,
  resyncPreview,
  executorProblem,
  syncAttention,
  autoSyncEntry,
  COOLDOWN_CHOICES,
  DEFAULT_COOLDOWN,
  DEFAULT_TIP_WEI,
  FALLBACK_MAX_TIP_WEI,
  AUTO_SYNC_MIN_INTERVAL,
  type SyncConfig,
  type SyncStatusInput,
} from './autoSync'

const E18 = 10n ** 18n
const FEE = 10n ** 14n // 0.0001 ETH，與線上 executionFee 相同

describe('reading the chain', () => {
  it('reads syncConfig by name, the way ethers returns a Result', () => {
    expect(parseSyncConfig({ autoSync: true, maxLeverage: 3n, minSyncInterval: 3600n, tipWei: 5n })).toEqual({
      autoSync: true, maxLeverage: 3, minSyncInterval: 3600, tipWei: 5n,
    })
  })

  it('falls back to positions when the names are missing', () => {
    expect(parseSyncConfig([false, 2n, 60n, 0n])).toEqual({ autoSync: false, maxLeverage: 2, minSyncInterval: 60, tipWei: 0n })
    expect(parseSyncState([1700000000n, 4n, true, 0n, 0n])).toEqual({ lastSyncedAt: 1700000000, syncCount: 4, followerClosed: true })
  })
})

describe('settings', () => {
  it('defaults the leverage cap to the highest leverage in the strategy the follower saw', () => {
    // 交易者之後把策略改成 5×，自動同步也不會超過跟單時同意的 3×
    expect(defaultMaxLeverage([1n, 3n, 2n])).toBe(3)
    expect(defaultMaxLeverage([])).toBe(1)
    expect(defaultMaxLeverage([9])).toBe(5)
  })

  it('clamps into the contract range 1..5', () => {
    expect(clampLeverage(0)).toBe(1)
    expect(clampLeverage(7)).toBe(5)
    expect(clampLeverage(2.4)).toBe(2)
  })

  it('rejects what setAutoSync would reject', () => {
    const ok = { maxLeverage: 3, minSyncInterval: 3600, tipWei: DEFAULT_TIP_WEI }
    expect(settingsProblem(ok)).toBeNull()
    expect(settingsProblem({ ...ok, maxLeverage: 0 })).toBe('leverage')
    expect(settingsProblem({ ...ok, maxLeverage: 6 })).toBe('leverage')
    expect(settingsProblem({ ...ok, tipWei: FALLBACK_MAX_TIP_WEI + 1n })).toBe('tip')
    expect(settingsProblem({ ...ok, tipWei: FALLBACK_MAX_TIP_WEI })).toBeNull()
    expect(settingsProblem({ ...ok, minSyncInterval: -1 })).toBe('interval')
    expect(settingsProblem({ ...ok, minSyncInterval: 2 ** 32 })).toBe('interval')
    // 合約下限 MIN_SYNC_INTERVAL（1 小時）：0 或差一秒都會被 setAutoSync 拒絕
    expect(AUTO_SYNC_MIN_INTERVAL).toBe(3600)
    expect(settingsProblem({ ...ok, minSyncInterval: 0 })).toBe('interval')
    expect(settingsProblem({ ...ok, minSyncInterval: AUTO_SYNC_MIN_INTERVAL - 1 })).toBe('interval')
    expect(settingsProblem({ ...ok, minSyncInterval: AUTO_SYNC_MIN_INTERVAL })).toBeNull()
    expect(Math.min(...COOLDOWN_CHOICES)).toBe(AUTO_SYNC_MIN_INTERVAL)
  })

  it('defaults to the most conservative cooldown on offer (24 h), not the contract minimum', () => {
    // 每次同步都是全平再開：冷卻 1 小時，交易者一天能讓你付 24 輪交易費；預設取選項裡最長的
    expect(DEFAULT_COOLDOWN).toBe(24 * 3600)
    expect(DEFAULT_COOLDOWN).toBe(Math.max(...COOLDOWN_CHOICES))
    expect(settingsProblem({ maxLeverage: 1, minSyncInterval: DEFAULT_COOLDOWN, tipWei: 0n })).toBeNull()
  })

  it('uses the on-chain tip ceiling when it is known', () => {
    expect(settingsProblem({ maxLeverage: 1, minSyncInterval: 0, tipWei: 10n }, 5n)).toBe('tip')
  })
})

describe('designated executor (setSyncExecutor)', () => {
  const ME = '0x' + 'aa'.repeat(20)
  const AGENT = '0x' + 'Bb'.repeat(20)

  it('reads the zero address as anyone', () => {
    expect(parseExecutor('0x0000000000000000000000000000000000000000')).toBeNull()
    expect(parseExecutor(AGENT)).toBe(AGENT)
    expect(parseExecutor(undefined)).toBeNull()
    expect(parseExecutor('0x1234')).toBeNull()
  })

  it('accepts an empty field (anyone) or another address, and refuses your own', () => {
    expect(executorProblem('', ME)).toBeNull()
    expect(executorProblem('  ', ME)).toBeNull()
    expect(executorProblem(AGENT, ME)).toBeNull()
    expect(executorProblem(` ${AGENT} `, ME)).toBeNull()
    expect(executorProblem('0x123', ME)).toBe('address')
    expect(executorProblem('0x0000000000000000000000000000000000000000', ME)).toBe('address')
    expect(executorProblem(ME.toUpperCase().replace('0X', '0x'), ME)).toBe('self')
  })

  it('compares addresses case-insensitively', () => {
    expect(sameAddress(AGENT, AGENT.toLowerCase())).toBe(true)
    expect(sameAddress(AGENT, null)).toBe(false)
  })
})

describe('leverage used on sync', () => {
  it('takes the smallest of strategy, asset cap and follower cap', () => {
    expect(effectiveLeverage(5, 2, 3)).toBe(2) // 高碳資產上限 2×
    expect(effectiveLeverage(5, 5, 3)).toBe(3)
    expect(effectiveLeverage(2, 5, 3)).toBe(2)
  })

  it('treats an unknown asset cap and a zero follower cap as no cap', () => {
    expect(effectiveLeverage(4, null, 0)).toBe(4)
    expect(effectiveLeverage(4, 0, 0)).toBe(4)
  })
})

describe('cost and the gas tank', () => {
  it('charges one execution fee per new leg, plus the tip only when someone else executes', () => {
    expect(syncCostWei(FEE, 3, DEFAULT_TIP_WEI, false)).toBe(3n * FEE + DEFAULT_TIP_WEI)
    expect(syncCostWei(FEE, 3, DEFAULT_TIP_WEI, true)).toBe(3n * FEE)
  })

  it('counts whole syncs the tank can pay for', () => {
    expect(syncsAffordable(10n * FEE, 3n * FEE)).toBe(3n)
    expect(syncsAffordable(0n, 3n * FEE)).toBe(0n)
    expect(syncsAffordable(5n, 0n)).toBeNull()
  })

  it('splits the one-transaction follow value into open fees plus the deposit', () => {
    expect(followWithAutoSyncValue(FEE, 3, 7n)).toBe(3n * FEE + 7n)
    expect(followWithAutoSyncValue(FEE, 3, -1n)).toBe(3n * FEE)
  })

  it('prefunds five executor syncs by default', () => {
    expect(defaultPrefundWei(FEE, 2, 10n)).toBe((2n * FEE + 10n) * 5n)
  })

  it('tells a manual sync how much the tank is short', () => {
    expect(selfSyncShortfall(FEE, FEE, 3)).toBe(2n * FEE)
    expect(selfSyncShortfall(3n * FEE, FEE, 3)).toBe(0n)
  })
})

describe('preview before “Sync now”', () => {
  const legs = [
    // 高碳資產：交易所只給 2×
    { asset: 'BTC', weight: 6000n, isLong: true, strategyLeverage: 5, assetMaxLeverage: 2, tradingFeeBps: 100 },
    { asset: 'ETH', weight: 4000n, isLong: false, strategyLeverage: 4, assetMaxLeverage: 5, tradingFeeBps: 10 },
  ]
  const current = [
    { value: 600n * E18, pnl: 100n * E18, leverage: 2 }, // 獲利 100 → 績效費 10
    { value: 380n * E18, pnl: -20n * E18, leverage: 1 },
  ]

  it('shows each leg at the leverage the contract will use, and flags caps and raises', () => {
    const p = resyncPreview({ legs, followerMax: 3, executionFee: FEE, tankBalance: E18, currentLegs: current })
    expect(p.legs.map(l => [l.leverage, l.capped])).toEqual([[2, true], [3, true]])
    expect(p.noFollowerCap).toBe(false)
    expect(p.leverageRaised).toBe(true) // 目前最高 2×，這次會用到 3×
    expect(p.executionFeeWei).toBe(2n * FEE)
    expect(p.topUpWei).toBe(0n)
  })

  it('estimates released margin, the performance fee and the opening trading fee like the contract buffer', () => {
    const p = resyncPreview({ legs, followerMax: 3, executionFee: FEE, tankBalance: E18, currentLegs: current })
    expect(p.estPerformanceFee).toBe(10n * E18)
    expect(p.estReleased).toBe(970n * E18)
    // 970 × (60% × 2× × 1.00% + 40% × 3× × 0.10%) = 970 × (1.2% + 0.12%) = 12.804
    expect(p.estOpenTradingFee).toBe((970n * E18 * 6000n * 2n * 100n) / 100_000_000n + (970n * E18 * 4000n * 3n * 10n) / 100_000_000n)
  })

  it('warns when the follower never set a cap, and tops up a short tank', () => {
    const p = resyncPreview({ legs, followerMax: 0, executionFee: FEE, tankBalance: FEE / 2n, currentLegs: current })
    expect(p.noFollowerCap).toBe(true)
    expect(p.legs.map(l => l.leverage)).toEqual([2, 4]) // 只受資產上限約束
    expect(p.topUpWei).toBe(2n * FEE - FEE / 2n)
  })

  it('does not guess figures it cannot read', () => {
    const p = resyncPreview({
      legs: [{ ...legs[0], tradingFeeBps: null }],
      followerMax: 3,
      executionFee: FEE,
      tankBalance: null,
      currentLegs: [{ value: null, pnl: null, leverage: 2 }],
    })
    expect(p.topUpWei).toBeNull()
    expect(p.estReleased).toBeNull()
    expect(p.estPerformanceFee).toBeNull()
    expect(p.estOpenTradingFee).toBeNull()
  })
})

describe('sync status', () => {
  const on: SyncConfig = { autoSync: true, maxLeverage: 3, minSyncInterval: 3600, tipWei: 10n }
  const base: SyncStatusInput = {
    recordVersion: 0n,
    latestVersion: 1n,
    config: on,
    state: { lastSyncedAt: 0, syncCount: 0, followerClosed: false },
    gasBalance: E18,
    executionFee: FEE,
    latestLegs: 3,
    nowSec: 1_000_000,
  }

  it('is up to date on the latest version', () => {
    expect(syncStatus({ ...base, recordVersion: 1n })).toEqual({ kind: 'upToDate' })
  })

  it('is manual when auto-sync is off', () => {
    expect(syncStatus({ ...base, config: { ...on, autoSync: false } })).toEqual({ kind: 'manual' })
  })

  it('waits for any executor once every condition holds', () => {
    expect(syncStatus(base)).toEqual({ kind: 'waiting' })
  })

  it('waits for the designated executor when the follower chose one', () => {
    expect(syncStatus({ ...base, executor: '0x' + 'ae'.repeat(20) })).toEqual({ kind: 'waitingExecutor' })
    expect(syncStatus({ ...base, executor: null })).toEqual({ kind: 'waiting' })
  })

  it('reports the cooldown until lastSyncedAt + minSyncInterval', () => {
    const state = { lastSyncedAt: 999_000, syncCount: 1, followerClosed: false }
    expect(syncStatus({ ...base, state })).toEqual({ kind: 'cooldown', readyAt: 1_002_600 })
    expect(syncStatus({ ...base, state, nowSec: 1_002_600 })).toEqual({ kind: 'waiting' })
  })

  it('counts the first cooldown from the follow itself, like syncReadyAt', () => {
    expect(syncStatus({ ...base, copiedAt: 999_000 })).toEqual({ kind: 'cooldown', readyAt: 1_002_600 })
    expect(syncStatus({ ...base, copiedAt: 999_000, nowSec: 1_002_600 })).toEqual({ kind: 'waiting' })
    // 同步過之後改從上次同步起算
    const state = { lastSyncedAt: 990_000, syncCount: 1, followerClosed: false }
    expect(syncStatus({ ...base, copiedAt: 999_000, state })).toEqual({ kind: 'waiting' })
  })

  it('flags an execution fee raised above what the follower agreed to', () => {
    expect(syncStatus({ ...base, execFeeCap: FEE - 1n })).toEqual({ kind: 'feeAboveCap' })
    expect(syncStatus({ ...base, execFeeCap: FEE })).toEqual({ kind: 'waiting' })
    expect(syncStatus({ ...base, execFeeCap: FEE * 2n })).toEqual({ kind: 'waiting' })
    // 讀不到上限（舊合約或 RPC 失敗）時不猜
    expect(syncStatus({ ...base, execFeeCap: null })).toEqual({ kind: 'waiting' })
    // 關閉自動同步時只顯示「手動」
    expect(syncStatus({ ...base, config: { ...on, autoSync: false }, execFeeCap: 0n })).toEqual({ kind: 'manual' })
  })

  it('warns ahead of the next version when the fee was raised while already up to date', () => {
    const latest = { ...base, recordVersion: 1n }
    expect(syncStatus({ ...latest, execFeeCap: FEE - 1n })).toEqual({ kind: 'consentStale' })
    expect(syncStatus({ ...latest, execFeeCap: FEE })).toEqual({ kind: 'upToDate' })
    // 讀不到上限、或自動同步關著（沒有人會代為同步）時，照舊是「已是最新版」
    expect(syncStatus({ ...latest, execFeeCap: null })).toEqual({ kind: 'upToDate' })
    expect(syncStatus({ ...latest, config: { ...on, autoSync: false }, execFeeCap: 0n })).toEqual({ kind: 'upToDate' })
    expect(syncStatus({ ...latest, config: null, execFeeCap: 0n })).toEqual({ kind: 'upToDate' })
  })

  it('needs gas when the tank cannot pay an executor', () => {
    expect(syncStatus({ ...base, gasBalance: 3n * FEE })).toEqual({ kind: 'needsGas', shortfall: 10n })
  })

  it('does not guess when a read failed', () => {
    expect(syncStatus({ ...base, latestVersion: null })).toEqual({ kind: 'unknown' })
    expect(syncStatus({ ...base, config: null })).toEqual({ kind: 'unknown' })
    // 油箱讀不到時不說「不夠」：只剩冷卻與開關能判斷
    expect(syncStatus({ ...base, gasBalance: null })).toEqual({ kind: 'waiting' })
  })
})

describe('display helpers', () => {
  it('numbers versions from 1 like the feed does', () => {
    expect(versionLabel(0n)).toBe('1')
    expect(versionLabel(4)).toBe('5')
  })

  it('formats hours', () => {
    expect(hoursLabel(3600)).toBe('1')
    expect(hoursLabel(5400)).toBe('1.5')
  })

  it('parses ETH input exactly, without floating point', () => {
    expect(parseEthInput('0.0005')).toBe(5n * 10n ** 14n)
    expect(parseEthInput('1')).toBe(E18)
    expect(parseEthInput('.5')).toBe(E18 / 2n)
    expect(parseEthInput('')).toBeNull()
    expect(parseEthInput('-1')).toBeNull()
    expect(parseEthInput('1e3')).toBeNull()
    expect(parseEthInput('0.0000000000000000001')).toBeNull()
  })
})

describe('site-wide reminder (CopySyncNotice)', () => {
  const item = (recordIdx: number, recordVersion: bigint, latestVersion: bigint | null, status: Parameters<typeof syncAttention>[0][number]['status']) =>
    ({ recordIdx, recordVersion, latestVersion, status })

  it('is quiet when every record is on the latest version or the version could not be read', () => {
    expect(syncAttention([item(0, 2n, 2n, { kind: 'upToDate' }), item(1, 0n, null, { kind: 'unknown' })])).toEqual({
      behind: 0, needsYou: 0, reasons: [], signature: '',
    })
  })

  it('separates what needs the follower from what only waits for an executor or the cooldown', () => {
    const a = syncAttention([
      item(0, 0n, 2n, { kind: 'cooldown', readyAt: 1 }),
      item(1, 1n, 2n, { kind: 'waiting' }),
      item(2, 0n, 1n, { kind: 'needsGas', shortfall: 5n }),
      item(3, 0n, 1n, { kind: 'manual' }),
      item(4, 0n, 3n, { kind: 'feeAboveCap' }),
      item(5, 0n, 3n, { kind: 'needsGas', shortfall: 1n }),
    ])
    expect(a.behind).toBe(6)
    expect(a.needsYou).toBe(4)
    expect(a.reasons).toEqual(['feeAboveCap', 'needsGas', 'manual'])
  })

  it('treats a tracker without auto-sync as something the follower must update', () => {
    expect(syncAttention([item(0, 0n, 1n, null)])).toMatchObject({ behind: 1, needsYou: 1, reasons: ['snapshot'] })
  })

  it('changes its signature when the trader publishes again, so a dismissed reminder comes back', () => {
    const before = syncAttention([item(1, 0n, 1n, { kind: 'waiting' }), item(0, 0n, 1n, { kind: 'manual' })])
    const after = syncAttention([item(1, 0n, 2n, { kind: 'waiting' }), item(0, 0n, 1n, { kind: 'manual' })])
    expect(before.signature).toBe('0:1,1:1')
    expect(after.signature).not.toBe(before.signature)
  })
})

describe('autoSyncEntry', () => {
  it('only offers the checkbox in Expert Mode on a tracker that supports auto-sync', () => {
    expect(autoSyncEntry(true, 'expert')).toBe('available')
    expect(autoSyncEntry(true, 'simple')).toBe('expertOnly')
    expect(autoSyncEntry(false, 'expert')).toBe('unsupported')
    expect(autoSyncEntry(false, 'simple')).toBe('unsupported')
  })
})
