import { describe, it, expect } from 'vitest'

import {
  isOutdated,
  belowMinimum,
  readStopLoss,
  writeStopLoss,
  stopLossReached,
  minimumCopyAmount,
  refreshCopyPath,
} from './copyGuards'

const E18 = 10n ** 18n

describe('minimum copy amount', () => {
  it('scales the preview until the smallest leg reaches the exchange minimum, rounded up to whole USDC', () => {
    // 試算 1,000 時最小一檔 99 → 1000 × 10 / 99 = 101.01… → 102
    expect(minimumCopyAmount(1000n * E18, [497n * E18, 298n * E18, 99n * E18], 10n * E18)).toBe(102n * E18)
  })

  it('has nothing to say without a usable preview', () => {
    expect(minimumCopyAmount(0n, [1n], 10n * E18)).toBeNull()
    expect(minimumCopyAmount(1000n * E18, [], 10n * E18)).toBeNull()
    expect(minimumCopyAmount(1000n * E18, [0n, 5n * E18], 10n * E18)).toBeNull()
  })

  it('flags a preview with any leg under the minimum', () => {
    expect(belowMinimum([50n * E18, 9n * E18], 10n * E18)).toBe(true)
    expect(belowMinimum([50n * E18, 10n * E18], 10n * E18)).toBe(false)
  })
})

describe('outdated copy', () => {
  it('is outdated when the trader has published a later version', () => {
    expect(isOutdated(0n, 3n)).toBe(true)
    expect(isOutdated(2n, 3n)).toBe(false)
    expect(isOutdated(0n, 1n)).toBe(false)
    expect(isOutdated(0n, 0n)).toBe(false)
  })
})

describe('moving a copy to the latest version', () => {
  const TRADER = '0x00000000000000000000000000000000000000AA'

  it('carries the returned amount over to the copy page in whole USDC', () => {
    expect(refreshCopyPath(TRADER, 987n * E18 + 654n)).toBe(`/copy/${TRADER}?amount=987`)
  })

  it('leaves the amount to the copy page when nothing usable came back', () => {
    // 部位全被清算時取回 0；不足 1 USDC 取整後也是 0。帶 ?amount=0 只會讓跟單頁一開始就是無效金額。
    expect(refreshCopyPath(TRADER, 0n)).toBe(`/copy/${TRADER}`)
    expect(refreshCopyPath(TRADER, E18 - 1n)).toBe(`/copy/${TRADER}`)
  })
})

describe('stop-loss reminder', () => {
  it('fires once the loss reaches the threshold', () => {
    expect(stopLossReached(1000n * E18, 600n * E18, 40)).toBe(true)
    expect(stopLossReached(1000n * E18, 601n * E18, 40)).toBe(false)
  })

  it('never fires without a threshold or a basis', () => {
    expect(stopLossReached(1000n * E18, 0n, null)).toBe(false)
    expect(stopLossReached(0n, 0n, 40)).toBe(false)
  })

  it('remembers a threshold per account and copy, and treats anything odd as unset', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) },
    }
    writeStopLoss('0xAbC', 2, 30, storage)
    expect(readStopLoss('0xabc', 2, storage)).toBe(30)
    expect(readStopLoss('0xabc', 3, storage)).toBeNull()
    writeStopLoss('0xabc', 2, null, storage)
    expect(readStopLoss('0xabc', 2, storage)).toBeNull()
    data.set('pepefi.copyStopLoss.0xabc.5', 'nonsense')
    expect(readStopLoss('0xabc', 5, storage)).toBeNull()
    data.set('pepefi.copyStopLoss.0xabc.6', '99')
    expect(readStopLoss('0xabc', 6, storage)).toBeNull()
    expect(readStopLoss('0xabc', 2, null)).toBeNull()
  })
})
