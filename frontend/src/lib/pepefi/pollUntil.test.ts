import { it, expect, describe } from 'vitest'

import { pollUntil } from './pollUntil'

const noSleep = async () => {}

describe('pollUntil', () => {
  it('讀到新狀態就停（第 3 次）', async () => {
    let n = 0
    const r = await pollUntil(async () => ++n === 3, { sleep: noSleep })
    expect(r).toBe('ok')
    expect(n).toBe(3)
  })

  it('一直讀不到 → timeout，次數不超過 tries；讀取丟例外視同還沒好', async () => {
    let n = 0
    const r = await pollUntil(async () => { n++; throw new Error('rpc down') }, { tries: 4, sleep: noSleep })
    expect(r).toBe('timeout')
    expect(n).toBe(4)
  })

  it('卸載／換錢包（cancelled）後立刻停止，不再呼叫 check', async () => {
    let n = 0
    let gone = false
    const r = await pollUntil(async () => { n++; if (n === 2) gone = true; return false }, { cancelled: () => gone, sleep: noSleep })
    expect(r).toBe('cancelled')
    expect(n).toBe(2)
  })
})
