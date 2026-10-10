import { it, expect, describe } from 'vitest'

import { esg as esgEn } from 'src/locales/en/esg'
import { esg as esgZh } from 'src/locales/zh-TW/esg'

import {
  summarizeRetirements,
  retirementReadFailed,
  simulationFlagContradicts,
  type RawRetirementState,
} from './carbonRetirement'

const base: RawRetirementState = {
  simulated: true,
  decimals: 18,
  totalRetiredTonnes: 25n * 10n ** 18n,
  totalSpent: 250n * 10n ** 18n,
  budget: 750n * 10n ** 18n,
  count: 2n,
  recent: [
    { amount: 200n * 10n ** 18n, tonnesCO2e: 20n * 10n ** 18n, timestamp: 1_800_000_100n, retiredBy: '0xb' },
    { amount: 50n * 10n ** 18n, tonnesCO2e: 5n * 10n ** 18n, timestamp: 1_800_000_000n, retiredBy: '0xa' },
  ],
}

describe('summarizeRetirements', () => {
  it('18 位結算幣：公噸與金額都換算成一般數字，列順序維持最新在前', () => {
    const s = summarizeRetirements(base)
    expect(s.totalTonnes).toBe(25)
    expect(s.totalSpent).toBe(250)
    expect(s.budget).toBe(750)
    expect(s.count).toBe(2)
    expect(s.rows.map((r) => r.tonnes)).toEqual([20, 5])
    expect(s.rows.map((r) => r.amount)).toEqual([200, 50])
    expect(s.rows[0].timestamp).toBe(1_800_000_100)
    expect(s.simulatedOnChain).toBe(true)
  })

  it('6 位結算幣（x402 用的 USDC）：金額按 6 位換算，公噸永遠按 18 位', () => {
    const s = summarizeRetirements({
      ...base,
      decimals: 6,
      totalSpent: 25_000_000n,
      budget: 0n,
      recent: [{ amount: 25_000_000n, tonnesCO2e: 25n * 10n ** 17n, timestamp: 1n, retiredBy: '0xa' }],
    })
    expect(s.totalSpent).toBe(25)
    expect(s.budget).toBe(0)
    expect(s.rows[0]).toMatchObject({ amount: 25, tonnes: 2.5 })
  })

  it('讀不到結算幣 decimals 時金額是未知（null），不猜 18；公噸照常', () => {
    const s = summarizeRetirements({ ...base, decimals: null })
    expect(s.totalSpent).toBeNull()
    expect(s.budget).toBeNull()
    expect(s.rows.every((r) => r.amount === null)).toBe(true)
    expect(s.totalTonnes).toBe(25)
  })

  it('還沒有任何退役：0 公噸與空清單，不是讀取失敗', () => {
    const empty: RawRetirementState = { ...base, totalRetiredTonnes: 0n, totalSpent: 0n, count: 0n, recent: [] }
    expect(retirementReadFailed(empty)).toBe(false)
    const s = summarizeRetirements(empty)
    expect(s.totalTonnes).toBe(0)
    expect(s.rows).toEqual([])
  })
})

describe('讀取失敗與模擬旗標', () => {
  it('核心欄位全部讀不到才算讀取失敗', () => {
    const none: RawRetirementState = {
      simulated: null,
      decimals: null,
      totalRetiredTonnes: null,
      totalSpent: null,
      budget: null,
      count: null,
      recent: null,
    }
    expect(retirementReadFailed(none)).toBe(true)
    expect(retirementReadFailed({ ...none, count: 0n })).toBe(false)
  })

  it('合約明確回報「不是模擬」視為讀取異常（位址指錯合約）；讀不到旗標不算矛盾', () => {
    expect(simulationFlagContradicts({ ...base, simulated: false })).toBe(true)
    expect(simulationFlagContradicts({ ...base, simulated: null })).toBe(false)
    expect(simulationFlagContradicts(base)).toBe(false)
  })
})

describe('誠實聲明（issue #105：被銷毀的代幣是模擬的，必須寫在畫面上）', () => {
  it('中文聲明明說「模擬碳權」、不對應真實減碳、款項沒有流向真實專案', () => {
    expect(esgZh.retirement.simulatedChip).toBe('模擬碳權')
    expect(esgZh.retirement.disclaimerTitle).toContain('模擬碳權')
    expect(esgZh.retirement.disclaimer).toContain('模擬碳權')
    expect(esgZh.retirement.disclaimer).toContain('不對應任何真實的減碳')
    expect(esgZh.retirement.disclaimer).toContain('模擬賣方')
    expect(esgZh.retirement.totalTonnes).toContain('模擬')
    expect(esgZh.retirement.column.tonnes).toContain('模擬')
  })

  it('英文聲明同樣明說 simulated', () => {
    expect(esgEn.retirement.simulatedChip.toLowerCase()).toContain('simulated')
    expect(esgEn.retirement.disclaimerTitle.toLowerCase()).toContain('simulated')
    expect(esgEn.retirement.disclaimer.toLowerCase()).toContain('simulated')
    expect(esgEn.retirement.totalTonnes.toLowerCase()).toContain('simulated')
  })
})
