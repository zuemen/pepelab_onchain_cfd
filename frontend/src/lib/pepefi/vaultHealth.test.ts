import { it, expect, describe } from 'vitest'

import {
  type VaultHealth,
  vaultActions,
  reserveSources,
  simpleReserveNote,
} from './vaultHealth'

const E18 = 10n ** 18n

function health(overrides: Partial<VaultHealth> = {}): VaultHealth {
  return {
    reserve: 201_510n * E18,
    liability: 1_462n * E18,
    ratioBps: 1_377_544n,
    minRatioBps: 11_000n,
    paused: false,
    stale: false,
    mintingHalted: false,
    maxDeviationBps: 1_000n,
    operatorFunded: 200_000n * E18,
    ...overrides,
  }
}

describe('reserveSources', () => {
  it('把儲備拆成營運方注資與其餘，並算出不含注資的儲備率', () => {
    const s = reserveSources(health({ reserve: 1_100n * E18, liability: 500n * E18, operatorFunded: 1_000n * E18 }))
    expect(s?.operatorFunded).toBe(1_000n * E18)
    expect(s?.userNet).toBe(100n * E18)
    expect(s?.operatorShareBps).toBe(9_090n)
    expect(s?.ownRatioBps).toBe(2_000n)
  })

  it('讀不到注資紀錄就是無法拆分，不是 0', () => {
    expect(reserveSources(health({ operatorFunded: null }))).toBeNull()
    expect(reserveSources(health({ reserve: null }))).toBeNull()
  })

  it('沒有任何注資時，不含注資的儲備率等於儲備率', () => {
    const s = reserveSources(health({ reserve: 200n * E18, liability: 100n * E18, operatorFunded: 0n }))
    expect(s?.operatorShareBps).toBe(0n)
    expect(s?.ownRatioBps).toBe(20_000n)
  })

  it('注資已被賠付吃掉（儲備低於注資總額）時，其餘是 0、注資占比封頂 100%', () => {
    const s = reserveSources(health({ reserve: 800n * E18, liability: 900n * E18, operatorFunded: 1_000n * E18 }))
    expect(s?.userNet).toBe(0n)
    expect(s?.operatorShareBps).toBe(10_000n)
    expect(s?.ownRatioBps).toBe(0n)
  })

  it('價格不可信時負債被低估，不含注資的儲備率不給數字', () => {
    const s = reserveSources(health({ stale: true }))
    expect(s?.operatorFunded).toBe(200_000n * E18)
    expect(s?.ownRatioBps).toBeNull()
  })

  it('尚無發行時沒有不含注資的儲備率', () => {
    expect(reserveSources(health({ liability: 0n }))?.ownRatioBps).toBeNull()
  })

  it('儲備為 0 時注資占比是 0，不除以零', () => {
    expect(reserveSources(health({ reserve: 0n, operatorFunded: 0n }))?.operatorShareBps).toBe(0n)
  })
})

describe('vaultActions', () => {
  it('正常時買進與贖回都可用', () => {
    expect(vaultActions(health())).toEqual({ buy: 'open', redeem: 'open' })
  })

  it('暫停時兩邊都不能用（redeem 也是 whenNotPaused）', () => {
    expect(vaultActions(health({ paused: true }))).toEqual({ buy: 'blocked', redeem: 'blocked' })
  })

  it('鑄造停止、價格不可信、低於下限都只擋買進', () => {
    for (const h of [
      health({ mintingHalted: true }),
      health({ stale: true }),
      health({ ratioBps: 10_999n }),
    ]) {
      expect(vaultActions(h)).toEqual({ buy: 'blocked', redeem: 'open' })
    }
  })

  it('剛好等於下限不算低於下限', () => {
    expect(vaultActions(health({ ratioBps: 11_000n })).buy).toBe('open')
  })

  it('尚無發行（ratioBps 為 null）不算低於下限', () => {
    expect(vaultActions(health({ ratioBps: null })).buy).toBe('open')
  })

  it('讀不到暫停狀態時是未知，不是可用', () => {
    expect(vaultActions(health({ paused: null }))).toEqual({ buy: 'unknown', redeem: 'unknown' })
  })
})

describe('simpleReserveNote', () => {
  it('這條鏈沒有硬化版金庫時說明未接上', () => {
    expect(simpleReserveNote(health(), false).severity).toBe('info')
  })

  it('暫停時明講不能贖回，不出現「可以買進與贖回」', () => {
    const note = simpleReserveNote(health({ paused: true }), true)
    expect(note.severity).toBe('error')
    expect(note.message).toContain('不能贖回')
  })

  it('價格不可信時不給儲備數字', () => {
    const note = simpleReserveNote(health({ stale: true }), true)
    expect(note.severity).toBe('warning')
    expect(note.message).not.toContain('201,510')
  })

  it('鑄造停止時說買進已暫停、贖回不受影響', () => {
    const note = simpleReserveNote(health({ mintingHalted: true }), true)
    expect(note.severity).toBe('error')
    expect(note.message).toContain('贖回不受影響')
  })

  it('低於下限時說買進會被拒絕', () => {
    const note = simpleReserveNote(health({ ratioBps: 10_999n }), true)
    expect(note.severity).toBe('error')
    expect(note.message).toContain('買進會被拒絕')
  })

  it('正常時講金額與營運方注資占比，不講「可隨時贖回」', () => {
    const note = simpleReserveNote(
      health({ reserve: 1_000n * E18, liability: 400n * E18, operatorFunded: 900n * E18 }),
      true,
    )
    expect(note.severity).toBe('info')
    expect(note.message).toContain('1,000')
    expect(note.message).toContain('400')
    expect(note.message).toContain('90.00%')
    expect(note.message).not.toContain('隨時')
  })

  it('讀不到注資紀錄時只講金額', () => {
    const note = simpleReserveNote(health({ operatorFunded: null }), true)
    expect(note.message).toContain('201,510')
    expect(note.message).not.toContain('注資')
  })

  it('讀不到儲備金額時不編數字', () => {
    const note = simpleReserveNote(health({ reserve: null, liability: null }), true)
    expect(note.message).not.toContain('USDC')
  })

  it('讀不到暫停狀態時不說可以買賣', () => {
    const note = simpleReserveNote(health({ paused: null }), true)
    expect(note.severity).toBe('warning')
    expect(note.message).not.toContain('可以買進')
  })
})
