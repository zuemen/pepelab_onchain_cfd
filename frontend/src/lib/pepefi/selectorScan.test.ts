import { it, expect, describe } from 'vitest'

import { scanPush4Selectors } from './selectorScan'
import { scanPush4Selectors as fromLegacy } from './legacyExchange'

describe('scanPush4Selectors', () => {
  it('撈出 PUSH4 的運算元，大小寫統一成小寫', () => {
    expect([...scanPush4Selectors('0x6398D5FDCA14')]).toEqual(['0x98d5fdca'])
    expect([...scanPush4Selectors('6398d5fdca14')]).toEqual(['0x98d5fdca'])
  })

  it('跳過其他 PUSHn 的資料區：資料裡的 0x63 不算 PUSH4', () => {
    const fake = `63${'deadbeef'}${'00'.repeat(27)}`
    const found = scanPush4Selectors(`0x7f${fake}63a126d60100`)
    expect(found.has('0xa126d601')).toBe(true)
    expect(found.has('0xdeadbeef')).toBe(false)
  })

  it('尾端不足 4 bytes 的 PUSH4 不算；空字串與 0x → 空集合', () => {
    expect(scanPush4Selectors('0x63aabbcc').size).toBe(0)
    expect(scanPush4Selectors('0x').size).toBe(0)
    expect(scanPush4Selectors('').size).toBe(0)
  })

  it('legacyExchange 轉出的是同一個函式（/legacy 既有的 import 不受影響）', () => {
    expect(fromLegacy).toBe(scanPush4Selectors)
  })
})
