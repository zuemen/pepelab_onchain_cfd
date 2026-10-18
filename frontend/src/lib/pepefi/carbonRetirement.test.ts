import { it, expect, describe } from 'vitest'

import { esg as esgEn } from 'src/locales/en/esg'
import { esg as esgZh } from 'src/locales/zh-TW/esg'

import {
  attachRetirementTx,
  summarizeRetirements,
  retirementLogRanges,
  retirementReadFailed,
  copyRetirementEstimate,
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

// ── #333：跟單前的退役估算、退役紀錄的交易雜湊 ───────────────────────────────

describe('copyRetirementEstimate', () => {
  const E18 = 10n ** 18n
  const inputs = {
    copyFeeBps: 30n,
    platformShareBps: 2_000n,
    carbonShareBps: 2_500n,
    pricePerTonne: 10n * E18,
  }

  it('手算：跟單 1,000 → 跟單費 3 → 平台 0.6 → 退役預算 0.15 → 每公噸 10 → 0.015 公噸', () => {
    const e = copyRetirementEstimate({ ...inputs, totalMargin: 1_000n * E18 })
    expect(e.copyFee).toBe(3n * E18)
    expect(e.platformShare).toBe((6n * E18) / 10n)
    expect(e.toRetirement).toBe((15n * E18) / 100n)
    expect(e.tonnes).toBe((15n * E18) / 1_000n)
  })

  it('每一步照合約的整數除法向下取整', () => {
    // 1 wei 的跟單：手續費取整為 0，什麼都退役不到
    const e = copyRetirementEstimate({ ...inputs, totalMargin: 1n })
    expect(e.copyFee).toBe(0n)
    expect(e.tonnes).toBe(0n)
  })

  it('6 位結算幣：價格以最小單位計，公噸數一樣是 1e18 刻度', () => {
    const e = copyRetirementEstimate({ ...inputs, pricePerTonne: 10_000_000n, totalMargin: 1_000_000_000n })
    expect(e.tonnes).toBe((15n * E18) / 1_000n)
  })
})

describe('attachRetirementTx', () => {
  const rows = [
    { tonnes: 0.2, amount: 2, timestamp: 1_800_000_100, retiredBy: '0xb' },
    { tonnes: 0.1, amount: 1, timestamp: 1_800_000_000, retiredBy: '0xa' },
  ]
  const raw = [
    { amount: 2n * 10n ** 18n, tonnesCO2e: 2n * 10n ** 17n, timestamp: 1_800_000_100n, retiredBy: '0xb' },
    { amount: 10n ** 18n, tonnesCO2e: 10n ** 17n, timestamp: 1_800_000_000n, retiredBy: '0xa' },
  ]

  it('以金額、噸數、時間三者比對事件，附上交易雜湊', () => {
    const out = attachRetirementTx(rows, raw, [
      { amount: 10n ** 18n, tonnesCO2e: 10n ** 17n, timestamp: 1_800_000_000n, txHash: '0x01' },
      { amount: 2n * 10n ** 18n, tonnesCO2e: 2n * 10n ** 17n, timestamp: 1_800_000_100n, txHash: '0x02' },
    ])
    expect(out.map((r) => r.txHash)).toEqual(['0x02', '0x01'])
  })

  it('找不到對應事件的列是 null，不借用別筆的雜湊', () => {
    const out = attachRetirementTx(rows, raw, [
      { amount: 2n * 10n ** 18n, tonnesCO2e: 2n * 10n ** 17n, timestamp: 1_800_000_100n, txHash: '0x02' },
    ])
    expect(out.map((r) => r.txHash)).toEqual(['0x02', null])
  })

  it('完全相同的兩筆退役各配一個事件，不重複使用', () => {
    const same = { amount: 10n ** 18n, tonnesCO2e: 10n ** 17n, timestamp: 1_800_000_000n }
    const out = attachRetirementTx(
      [rows[1], rows[1]],
      [{ ...same, retiredBy: '0xa' }, { ...same, retiredBy: '0xa' }],
      [
        { ...same, txHash: '0x0a' },
        { ...same, txHash: '0x0b' },
      ],
    )
    expect(new Set(out.map((r) => r.txHash))).toEqual(new Set(['0x0a', '0x0b']))
  })
})

describe('retirementLogRanges', () => {
  const latest = { number: 40_000_000, timestamp: 1_800_000_000 }

  it('本機鏈一次查完整條鏈（回放的退役散在兩年的區塊裡，區塊與時間不成比例）', () => {
    expect(retirementLogRanges(31337, { number: 250_000, timestamp: 0 }, [1, 2], 1)).toEqual([
      { fromBlock: 0, toBlock: 250_000 },
    ])
  })

  it('公開鏈：由時間推回每一筆的區塊，只查它前後一小段', () => {
    // 一小時前（Base 2 秒一塊 → 1,800 塊前）
    const [r] = retirementLogRanges(84532, latest, [latest.timestamp - 3_600], 2)
    expect(r.fromBlock).toBeLessThanOrEqual(latest.number - 1_800)
    expect(r.toBlock).toBeGreaterThanOrEqual(latest.number - 1_800)
    expect(r.toBlock - r.fromBlock).toBeLessThanOrEqual(400)
  })

  it('相鄰的範圍合併，相距很遠的分開；不超過最新區塊', () => {
    const ranges = retirementLogRanges(
      84532,
      latest,
      [latest.timestamp, latest.timestamp - 60, latest.timestamp - 30 * 86_400],
      2,
    )
    expect(ranges).toHaveLength(2)
    expect(ranges[1].toBlock).toBe(latest.number)
    expect(ranges[0].toBlock).toBeLessThan(ranges[1].fromBlock)
  })
})
