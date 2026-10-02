import { it, expect, describe, beforeEach } from 'vitest'

import {
  checkInUnitKey,
  settleCheckInUnit,
  settledCheckInUnit,
  resetSettledCheckInUnits,
} from './useCheckInUnit'

// PR #219 複審 B2：同一個部署者在兩條鏈用同一個 nonce 部署，合約位址會一樣。
// 已確定的結論必須以「chainId:位址」為鍵，一條鏈的結論不可套到另一條鏈。
const ADDR = '0xEBfA1dc7dDea032ac6242cB619d982e543A23c12'

describe('useCheckInUnit 的結論快取', () => {
  beforeEach(() => resetSettledCheckInUnits())

  it('鍵帶 chainId，位址大小寫不影響', () => {
    expect(checkInUnitKey(84532, ADDR)).toBe(`84532:${ADDR.toLowerCase()}`)
    expect(checkInUnitKey(84532, ADDR.toLowerCase())).toBe(checkInUnitKey(84532, ADDR))
    expect(checkInUnitKey(84532, ADDR)).not.toBe(checkInUnitKey(11155111, ADDR))
  })

  it('同位址、不同鏈：A 鏈確定的點數版不會被 B 鏈沿用', () => {
    settleCheckInUnit(84532, ADDR, 'points')
    expect(settledCheckInUnit(84532, ADDR)).toBe('points')
    expect(settledCheckInUnit(11155111, ADDR)).toBeNull()
  })

  it('同位址、不同鏈：A 鏈的 PEPE 版也不會被 B 鏈沿用', () => {
    settleCheckInUnit(11155111, ADDR, 'pepe')
    expect(settledCheckInUnit(84532, ADDR)).toBeNull()
  })

  it('chainId 未知時不寫入也不讀取', () => {
    settleCheckInUnit(null, ADDR, 'points')
    expect(settledCheckInUnit(null, ADDR)).toBeNull()
    expect(settledCheckInUnit(84532, ADDR)).toBeNull()
    expect(checkInUnitKey(undefined, ADDR)).toBeNull()
  })
})
