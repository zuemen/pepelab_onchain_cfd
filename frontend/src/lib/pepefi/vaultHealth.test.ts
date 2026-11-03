import { it, expect, describe } from 'vitest'

import { type VaultHealth, vaultStatusNote } from './vaultHealth'

function health(overrides: Partial<VaultHealth> = {}): VaultHealth {
  return {
    ratioBps: 1_377_544n,
    minRatioBps: 11_000n,
    paused: false,
    stale: false,
    mintingHalted: false,
    ...overrides,
  }
}

describe('vaultStatusNote', () => {
  it('正常時不顯示任何提醒', () => {
    expect(vaultStatusNote(health())).toBeNull()
  })

  it('還沒讀到暫停狀態時不提醒，避免頁面一載入就閃一下警告', () => {
    expect(vaultStatusNote(health({ paused: null }))).toBeNull()
  })

  it('尚無發行（ratioBps 為 null）不算低於下限', () => {
    expect(vaultStatusNote(health({ ratioBps: null }))).toBeNull()
  })

  it('剛好等於下限不提醒', () => {
    expect(vaultStatusNote(health({ ratioBps: 11_000n }))).toBeNull()
  })

  it('暫停時明講買進與贖回都不能用（redeem 也是 whenNotPaused）', () => {
    const note = vaultStatusNote(health({ paused: true }))
    expect(note?.severity).toBe('error')
    expect(note?.message).toContain('不能贖回')
  })

  it('暫停優先於其他狀態', () => {
    const note = vaultStatusNote(health({ paused: true, stale: true, mintingHalted: true }))
    expect(note?.message).toContain('不能贖回')
  })

  it('有資產無法估值時是無法確認，不保證贖回（該資產自己的 redeem 會被 StalePrice 擋下）', () => {
    const note = vaultStatusNote(health({ stale: true }))
    expect(note?.severity).toBe('warning')
    expect(note?.message).toContain('無法確認')
    expect(note?.message).not.toContain('贖回')
  })

  it('鑄造停止與低於下限都是買進停止、贖回不受影響', () => {
    for (const h of [health({ mintingHalted: true }), health({ ratioBps: 10_999n })]) {
      const note = vaultStatusNote(h)
      expect(note?.severity).toBe('error')
      expect(note?.message).toContain('贖回不受影響')
    }
  })
})
