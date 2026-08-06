import { describe, it, expect } from 'vitest'

import { toStrictlyIncreasingIds } from './positionIds'

/** 合約端的檢查：必須嚴格遞增（不得相等）。 */
function isStrictlyIncreasing(ids: readonly bigint[]): boolean {
  for (let i = 1; i < ids.length; i += 1) if (ids[i] <= ids[i - 1]) return false
  return true
}

describe('toStrictlyIncreasingIds', () => {
  it('把亂序的 id 排成遞增', () => {
    expect(toStrictlyIncreasingIds([5n, 1n, 3n])).toEqual([1n, 3n, 5n])
  })

  it('去掉重複的 id —— 重複會讓合約 revert PositionIdsNotSorted', () => {
    expect(toStrictlyIncreasingIds([2n, 2n, 1n, 2n])).toEqual([1n, 2n])
  })

  it('輸出永遠通過合約的嚴格遞增檢查', () => {
    const messy = [9n, 0n, 9n, 4n, 4n, 12n, 1n]
    expect(isStrictlyIncreasing(toStrictlyIncreasingIds(messy))).toBe(true)
  })

  it('bigint 用數值大小排序，不是字典序（10 要排在 9 後面）', () => {
    expect(toStrictlyIncreasingIds([10n, 9n])).toEqual([9n, 10n])
  })

  it('空陣列與單一元素', () => {
    expect(toStrictlyIncreasingIds([])).toEqual([])
    expect(toStrictlyIncreasingIds([7n])).toEqual([7n])
  })

  it('不會就地修改呼叫端的陣列', () => {
    const input = [3n, 1n]
    toStrictlyIncreasingIds(input)
    expect(input).toEqual([3n, 1n])
  })
})
