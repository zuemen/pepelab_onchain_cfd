import { describe, it, expect } from 'vitest'

import {
  pctChangeOf,
  formatBenchmarkValue,
  formatPct,
  formatAxisPrice,
  formatAxisDate,
  priceDomainOf,
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
  it('畫面由左到右的顯示順序:幣、股、金、債', () => {
    expect(BENCHMARK_KEYS).toEqual(['btc', 'spx', 'gold', 'bond'])
  })
})

describe('formatAxisPrice', () => {
  // 四個指數量級差三個數量級,同一種格式套下去不是擠成一團就是精度全失。
  it('比特幣量級（~80,000）縮成 k,不留小數', () => {
    expect(formatAxisPrice(79977.52)).toBe('80k')
  })

  it('標普量級（~7,600）縮成 k,留一位小數才分得出刻度', () => {
    expect(formatAxisPrice(7652.86)).toBe('7.7k')
  })

  it('黃金量級（~4,700）同樣留一位小數', () => {
    expect(formatAxisPrice(4678.8)).toBe('4.7k')
  })

  it('美債量級（~82）不縮寫,留一位小數', () => {
    expect(formatAxisPrice(82.56)).toBe('82.6')
  })

  it('三位數不留小數', () => {
    expect(formatAxisPrice(199.34)).toBe('199')
  })

  it('負值也照量級處理,不會變成 NaN 或掉負號', () => {
    expect(formatAxisPrice(-7652.86)).toBe('-7.7k')
  })
})

describe('formatAxisDate', () => {
  it('unix 秒 → MM/DD,固定 UTC', () => {
    expect(formatAxisDate(Date.UTC(2026, 7, 24, 13, 30) / 1000)).toBe('08/24')
  })

  it('個位數的月與日補零,刻度寬度才一致', () => {
    expect(formatAxisDate(Date.UTC(2026, 0, 5, 0, 0) / 1000)).toBe('01/05')
  })

  // 不看瀏覽器時區:UTC 當天稍晚的時間戳仍屬同一天,不會前後跳一天。
  it('UTC 深夜的時間戳不會跨到隔天', () => {
    expect(formatAxisDate(Date.UTC(2026, 7, 24, 23, 59) / 1000)).toBe('08/24')
  })
})

describe('priceDomainOf', () => {
  it('空序列 → 一個安全的預設區間,不是 NaN', () => {
    expect(priceDomainOf([])).toEqual([0, 1])
  })

  it('不從 0 起算——從 0 起算會把一個月的波動壓成一條直線', () => {
    const [lo, hi] = priceDomainOf([100, 110])
    expect(lo).toBeGreaterThan(0)
    expect(lo).toBeLessThan(100)
    expect(hi).toBeGreaterThan(110)
  })

  it('上下各留 5% 餘裕', () => {
    expect(priceDomainOf([100, 200])).toEqual([95, 205])
  })

  // 這條是重點:上下界相同時 recharts 畫不出線,必須強制撐開。
  it('整段價格完全沒動 → 仍撐開一個區間,上下界不相等', () => {
    const [lo, hi] = priceDomainOf([50, 50, 50])
    expect(hi).toBeGreaterThan(lo)
  })

  it('價格為 0 且完全沒動也要撐開,不能回 [0, 0]', () => {
    const [lo, hi] = priceDomainOf([0, 0])
    expect(hi).toBeGreaterThan(lo)
  })
})

