import { describe, it, expect } from 'vitest'

import { pepeNameFor } from './pepeName'

/** 隨機但可重現的 40-hex 位址。 */
const addrFrom = (seed: number): string => {
  let s = ''
  let x = seed
  for (let i = 0; i < 40; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0
    s += (x % 16).toString(16)
  }
  return `0x${s}`
}

describe('pepeNameFor', () => {
  it('沒有位址時給一個固定的名字', () => {
    expect(pepeNameFor(null)).toBe('Anon Pepe')
    expect(pepeNameFor(undefined)).toBe('Anon Pepe')
    expect(pepeNameFor('')).toBe('Anon Pepe')
  })

  it('永遠是「形容詞 + 名詞」,兩個字都存在', () => {
    // 這條測試存在的理由：名詞的索引原本用有號位移 `h >> 5`。djb2 以 `>>> 0`
    // 收尾，所以 h 可以超過 2^31；一旦超過，`>>` 會把它當成負的 int32，
    // 負數 % 16 在 JS 裡也是負的，NOUN[-13] 就是 undefined。畫面上真的出現過
    // 「Lucky undefined」。位址取樣要夠多才蓋得到 top bit 被設起來的那一半。
    for (let i = 0; i < 2_000; i += 1) {
      const name = pepeNameFor(addrFrom(i))
      expect(name).not.toContain('undefined')
      const [adj, noun, ...rest] = name.split(' ')
      expect(adj.length).toBeGreaterThan(0)
      expect(noun?.length ?? 0).toBeGreaterThan(0)
      expect(rest).toHaveLength(0)
    }
  })

  it('同一個位址永遠得到同一個名字,大小寫不影響', () => {
    const a = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    expect(pepeNameFor(a)).toBe(pepeNameFor(a.toLowerCase()))
    expect(pepeNameFor(a)).toBe(pepeNameFor(a.toUpperCase().replace('0X', '0x')))
  })

  it('兩個名詞欄位都真的被用到——不是永遠落在同一格', () => {
    const nouns = new Set(
      Array.from({ length: 500 }, (_, i) => pepeNameFor(addrFrom(i)).split(' ')[1]),
    )
    expect(nouns.size).toBeGreaterThan(8)
  })
})
