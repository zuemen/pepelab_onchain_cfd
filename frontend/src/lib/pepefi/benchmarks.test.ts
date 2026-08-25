import { describe, it, expect } from 'vitest'

import {
  pctChangeOf,
  formatBenchmarkValue,
  formatPct,
  sparklinePoints,
  BENCHMARK_KEYS,
  type BenchmarkAtDatePoint,
} from './benchmarks'

describe('pctChangeOf', () => {
  it('漲跌算對:現價高於基準 → 正百分比', () => {
    const pct = pctChangeOf({ value: 110, at: 100 }, { value: 100, at: 0 })
    expect(pct).toBeCloseTo(10)
  })

  it('現價低於基準 → 負百分比', () => {
    const pct = pctChangeOf({ value: 90, at: 100 }, { value: 100, at: 0 })
    expect(pct).toBeCloseTo(-10)
  })

  it('current 缺資料 → null,不是 0 或 NaN', () => {
    expect(pctChangeOf(undefined, { value: 100, at: 0 })).toBeNull()
  })

  it('基準缺資料 → null（previousClose 只有一根資料時就是這種情況）', () => {
    expect(pctChangeOf({ value: 100, at: 0 }, undefined)).toBeNull()
  })

  // 這是最重要的一條:基準值為 0 直接除下去會是 Infinity,絕不能算出來顯示在
  // 畫面上當成一個看似真實的百分比。
  it('基準是 0 → null,不是 Infinity', () => {
    const pct = pctChangeOf({ value: 100, at: 0 }, { value: 0, at: 0 })
    expect(pct).toBeNull()
  })

  // 兩種基準共用同一個函式:當日漲跌傳 previousClose(BenchmarkPoint)、
  // 「你 vs 大盤」傳錨定日的 atDate(BenchmarkAtDatePoint,多一個 date 欄位)。
  it('帶 date 欄位的錨定點也照樣收（你 vs 大盤那條路徑）', () => {
    const anchor: BenchmarkAtDatePoint = { value: 100, at: 0, date: '2026-07-10' }
    expect(pctChangeOf({ value: 120, at: 100 }, anchor)).toBeCloseTo(20)
  })
})

describe('formatBenchmarkValue', () => {
  it('spx 不帶錢字元——指數點數,不是 USD', () => {
    expect(formatBenchmarkValue('spx', 7674.37)).toBe('7,674.37')
  })

  it('gold 帶 $', () => {
    expect(formatBenchmarkValue('gold', 4695.8)).toBe('$4,695.80')
  })

  it('btc 帶 $ 且千分位正確', () => {
    expect(formatBenchmarkValue('btc', 77105.95)).toBe('$77,105.95')
  })
})

describe('formatPct', () => {
  it('正數帶 + 號', () => {
    expect(formatPct(1.4)).toBe('+1.40%')
  })

  it('負數帶原生的 - 號,不重複加號', () => {
    expect(formatPct(-2.5)).toBe('-2.50%')
  })

  it('0 視為非負,帶 + 號', () => {
    expect(formatPct(0)).toBe('+0.00%')
  })
})

describe('BENCHMARK_KEYS', () => {
  it('四個指數對應四個 Asset Class（股債金幣）', () => {
    expect(BENCHMARK_KEYS).toEqual(['spx', 'bond', 'gold', 'btc'])
  })
})

describe('sparklinePoints', () => {
  it('空序列 → 空字串,呼叫端據此不畫圖', () => {
    expect(sparklinePoints([], 100, 20)).toBe('')
  })

  it('單點 → 一條水平線,不是壞掉的路徑', () => {
    expect(sparklinePoints([5], 100, 20)).toBe('0,10 100,10')
  })

  // 這條是重點:整段沒動時 (v-min)/(max-min) 會是 0/0 = NaN,一個 NaN 就讓
  // 整條 polyline 消失。必須畫在正中央。
  it('整段價格完全沒動 → 畫在垂直正中央,不是 NaN', () => {
    const pts = sparklinePoints([7, 7, 7], 100, 20)
    expect(pts).not.toMatch(/NaN/)
    expect(pts).toBe('0.00,10.00 50.00,10.00 100.00,10.00')
  })

  it('上漲的序列:最後一點比第一點高 → y 較小（SVG y 軸向下）', () => {
    const pts = sparklinePoints([1, 2, 3], 100, 20).split(' ').map((p) => p.split(',').map(Number))
    expect(pts[0][1]).toBeGreaterThan(pts[2][1])
  })

  it('最高點貼上緣 y=0、最低點貼下緣 y=height', () => {
    const pts = sparklinePoints([10, 30, 20], 100, 20).split(' ').map((p) => p.split(',').map(Number))
    expect(pts[0][1]).toBeCloseTo(20) // 最低 → 底
    expect(pts[1][1]).toBeCloseTo(0)  // 最高 → 頂
  })

  it('x 座標均分整個寬度', () => {
    const pts = sparklinePoints([1, 2, 3, 4, 5], 100, 20).split(' ').map((p) => Number(p.split(',')[0]))
    expect(pts).toEqual([0, 25, 50, 75, 100])
  })
})

