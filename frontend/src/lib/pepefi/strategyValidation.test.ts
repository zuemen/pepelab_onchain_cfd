import { it, expect, describe } from 'vitest'

import { validateStrategy } from './strategyValidation'

const row = (asset: string, weight: string) => ({ asset, weight })
const codes = (r: ReturnType<typeof validateStrategy>) => r.issues.map((i) => i.code)

describe('validateStrategy', () => {
  it('三檔、各不超過 50%、總和 100% → 可發布', () => {
    const r = validateStrategy([row('a', '40'), row('b', '30'), row('c', '30')])
    expect(r.issues).toEqual([])
    expect(r.bps).toEqual([4000, 3000, 3000])
    expect(r.roundingAdjust).toBe(0)
  })

  it('少於 3 檔 → TooFewAssets（合約 MIN_ALLOCATION_ASSETS）', () => {
    expect(codes(validateStrategy([row('a', '50'), row('b', '50')]))).toContain('TooFewAssets')
  })

  it('單檔超過 50% → WeightExceedsMax，指名是哪一列', () => {
    const r = validateStrategy([row('a', '60'), row('b', '20'), row('c', '20')])
    expect(r.issues).toContainEqual({ code: 'WeightExceedsMax', index: 0, bps: 6000 })
  })

  it('剛好 50% 可以', () => {
    expect(validateStrategy([row('a', '50'), row('b', '25'), row('c', '25')]).issues).toEqual([])
  })

  it('33.33 × 3 四捨五入差 1 bps → 補到最大那檔，總和 10000', () => {
    const r = validateStrategy([row('a', '33.33'), row('b', '33.34'), row('c', '33.33')])
    expect(r.issues).toEqual([])
    expect(r.bps.reduce((s, v) => s + v, 0)).toBe(10_000)
  })

  it('原始輸入含三位小數，四捨五入後差額被補回', () => {
    const r = validateStrategy([row('a', '33.333'), row('b', '33.333'), row('c', '33.334')])
    expect(r.bps.reduce((s, v) => s + v, 0)).toBe(10_000)
    expect(r.roundingAdjust).toBe(1)
    expect(r.issues).toEqual([])
  })

  it('差額為正、最大那檔剛好 50% → 不補給它（否則 5001 超過上限），改補到下一檔', () => {
    // exact：5000 + 1666.4 + 1666.4 + 1667.2 = 10000；四捨五入：5000 + 1666 + 1666 + 1667 = 9999，差 +1
    const r = validateStrategy([row('a', '50'), row('b', '16.664'), row('c', '16.664'), row('d', '16.672')])
    expect(r.bps).toEqual([5000, 1666, 1666, 1668])
    expect(r.roundingAdjust).toBe(1)
    expect(r.issues).toEqual([])
  })

  it('差額為負時最大那檔仍可以吸收（補完 4999 ≤ 上限）', () => {
    // exact：5000 + 1666.66 + 1666.66 + 1666.68 = 10000；四捨五入 5000 + 1667×3 = 10001，差 -1
    const r = validateStrategy([row('a', '50'), row('b', '16.6666'), row('c', '16.6666'), row('d', '16.6668')])
    expect(r.bps).toEqual([4999, 1667, 1667, 1667])
    expect(r.issues).toEqual([])
  })

  it('原始輸入本來就不是 100% → InvalidWeightSum，不幫使用者猜', () => {
    const r = validateStrategy([row('a', '30'), row('b', '30'), row('c', '30')])
    expect(r.issues).toContainEqual({ code: 'InvalidWeightSum', bps: 9000 })
    expect(r.roundingAdjust).toBe(0)
  })

  it('0 權重 → ZeroWeight；重複標的 → DuplicateAsset', () => {
    expect(codes(validateStrategy([row('a', '50'), row('b', '50'), row('c', '0')]))).toContain('ZeroWeight')
    expect(codes(validateStrategy([row('a', '40'), row('A', '30'), row('c', '30')]))).toContain('DuplicateAsset')
  })
})

describe('prettyError 對應 StrategyRegistry 的錯誤', async () => {
  const { prettyError } = await import('./errorMessages')
  const { t } = await import('src/locales')

  it.each(['TooFewAssets', 'DuplicateAsset', 'WeightExceedsMax', 'InvalidWeightSum', 'ZeroWeight'] as const)(
    '%s 有專屬說法（ethers 解出的 revert.name 與訊息關鍵字兩條路徑）',
    (name) => {
      expect(prettyError({ revert: { name } })).toBe(t.errors.contract[name])
      expect(prettyError(new Error(`execution reverted: ${name}(1)`))).toBe(t.errors.contract[name])
    }
  )
})
