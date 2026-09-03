import { describe, it, expect } from 'vitest'

import {
  tierOf,
  paramsFor,
  paramsForIntensity,
  Tier,
  attestationAgeDays,
  attestationExpired,
  nextAttestationDue,
  portfolioCarbon,
  MAX_ATTESTATION_AGE_DAYS,
} from './carbon'

// 這些門檻與逐級參數是 contracts/src/CarbonTiers.sol 的鏡射，兩邊沒有編譯期
// 連結——改一邊的門檻沒有改另一邊，兩邊的測試都還是會過，數字會悄悄漂移。
// 改門檻兩邊都要改，這份測試釘住的數字必須跟 CarbonTiers.t.sol 一致。

describe('tierOf', () => {
  it('低於 1.0 為 low', () => {
    expect(tierOf(0, true)).toBe('low')
    expect(tierOf(0.099, true)).toBe('low')
    expect(tierOf(0.999, true)).toBe('low')
  })

  it('剛好 1.0 屬於 mid——low 是嚴格小於', () => {
    expect(tierOf(1, true)).toBe('mid')
  })

  it('1.0 到 8.0 之間為 mid', () => {
    expect(tierOf(4.34, true)).toBe('mid') // sESGU，見 docs/data/carbon-intensity.md
  })

  it('剛好 8.0 屬於 mid——high 是嚴格大於', () => {
    expect(tierOf(8, true)).toBe('mid')
  })

  it('超過 8.0 為 high', () => {
    expect(tierOf(8.001, true)).toBe('high')
    expect(tierOf(10.226, true)).toBe('high') // sMSFT
  })

  it('真實資產數字,取自 docs/data/carbon-intensity.md', () => {
    expect(tierOf(0.099, true)).toBe('low') // sNVDA
    expect(tierOf(0.15, true)).toBe('low') // sAAPL
    expect(tierOf(8.949, true)).toBe('high') // sGOOGL
    expect(tierOf(10.021, true)).toBe('high') // sTSLA
    expect(tierOf(10.226, true)).toBe('high') // sMSFT
  })

  it('未評等永遠是 unrated,不管碳強度數值是多少——不能靠 0 隱含未評等', () => {
    // 0 落在 low 的區間裡；如果 isRated 沒有被檢查，一個沒有見證資料的資產
    // 會被當成成本最低、槓桿最高的資產，跟 fail-closed 的原意正好相反。
    expect(tierOf(0, false)).toBe('unrated')
    expect(tierOf(0.099, false)).toBe('unrated')
    expect(tierOf(100, false)).toBe('unrated')
  })
})

describe('paramsFor', () => {
  it('high 卡在 PerpetualExchange 自己的費率上限', () => {
    // 對應 MAX_TRADING_FEE_BPS = 100、MAX_BORROW_FEE_BPS_PER_HOUR = 10。
    const p = paramsFor('high')
    expect(p.tradingFeeBps).toBe(100)
    expect(p.borrowFeeBpsPerHour).toBe(10)
  })

  it('low 對齊 PerpetualExchange 現行預設值——上線不能悄悄調高最低一級的成本', () => {
    const p = paramsFor('low')
    expect(p.tradingFeeBps).toBe(10)
    expect(p.borrowFeeBpsPerHour).toBe(1)
  })

  it('槓桿上限只會是 {1, 2, 5}——對齊 StrategyRegistry._validLeverage', () => {
    expect(paramsFor('low').maxLeverage).toBe(5)
    expect(paramsFor('mid').maxLeverage).toBe(2)
    expect(paramsFor('high').maxLeverage).toBe(1)
  })

  it('費率隨碳排嚴格遞增,槓桿上限隨碳排嚴格遞減', () => {
    const low = paramsFor('low')
    const mid = paramsFor('mid')
    const high = paramsFor('high')
    expect(low.tradingFeeBps).toBeLessThan(mid.tradingFeeBps)
    expect(mid.tradingFeeBps).toBeLessThan(high.tradingFeeBps)
    expect(low.borrowFeeBpsPerHour).toBeLessThan(mid.borrowFeeBpsPerHour)
    expect(mid.borrowFeeBpsPerHour).toBeLessThan(high.borrowFeeBpsPerHour)
    expect(low.maxLeverage).toBeGreaterThan(mid.maxLeverage)
    expect(mid.maxLeverage).toBeGreaterThan(high.maxLeverage)
  })

  it('unrated 在數字上與 high 完全相同——「未評等資產一律落到最保守級」', () => {
    expect(paramsFor('unrated')).toEqual(paramsFor('high'))
  })
})

describe('paramsForIntensity', () => {
  it('組合 tierOf 與 paramsFor', () => {
    const r = paramsForIntensity(0.15, true) // sAAPL
    expect(r.tier).toBe('low')
    expect(r.tradingFeeBps).toBe(10)
    expect(r.maxLeverage).toBe(5)
  })

  it('未評等時完全忽略碳強度數值本身', () => {
    const r = paramsForIntensity(0.001, false)
    expect(r.tier).toBe('unrated')
    expect(r.tradingFeeBps).toBe(100)
    expect(r.maxLeverage).toBe(1)
  })
})

describe('Tier（型別匯出，供畫面直接使用）', () => {
  it('四個值與 tierOf 回傳的字串一致', () => {
    const all: Tier[] = ['unrated', 'low', 'mid', 'high']
    expect(all).toContain(tierOf(0.5, true))
  })
})

// ── 見證新鮮度 ──────────────────────────────────────────────────────────────

describe('attestationAgeDays', () => {
  const now = Date.parse('2026-09-03T00:00:00Z')

  it('同一天為 0 天', () => {
    expect(attestationAgeDays('2026-09-03', now)).toBe(0)
  })

  it('一天前為 1 天', () => {
    expect(attestationAgeDays('2026-09-02', now)).toBe(1)
  })

  it('未來日期夾成 0,不產生負數年齡', () => {
    expect(attestationAgeDays('2027-01-01', now)).toBe(0)
  })

  it('無法解析的日期回 Infinity——「不知道」要能被 fail-closed', () => {
    expect(attestationAgeDays('not a date', now)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('attestationExpired', () => {
  const now = Date.parse('2026-09-03T00:00:00Z')

  it('最大見證年齡是一年——對齊發行方的年度申報週期', () => {
    expect(MAX_ATTESTATION_AGE_DAYS).toBe(365)
  })

  it('碳資料蒐集當天（2026-09-02）現在還沒過期', () => {
    expect(attestationExpired('2026-09-02', now)).toBe(false)
  })

  it('剛好一年不算過期,超過一年才算', () => {
    const oneYearAgo = Date.parse('2025-09-03T00:00:00Z')
    expect(attestationExpired('2025-09-03', oneYearAgo + 365 * 86_400_000)).toBe(false)
    expect(attestationExpired('2025-09-02', now)).toBe(true)
  })

  it('無法解析的日期一律當成過期', () => {
    expect(attestationExpired('', now)).toBe(true)
  })
})

describe('nextAttestationDue', () => {
  it('見證日加一年', () => {
    expect(nextAttestationDue('2026-09-02')).toBe('2027-09-02')
  })

  it('無法解析的日期回破折號', () => {
    expect(nextAttestationDue('nope')).toBe('—')
  })
})

// ── 組合加權碳強度 ──────────────────────────────────────────────────────────

describe('portfolioCarbon', () => {
  it('空組合:強度 null,兩個百分比都是 0', () => {
    expect(portfolioCarbon([])).toEqual({ intensity: null, ratedWeightPct: 0, unratedWeightPct: 0 })
  })

  it('單一已評等持倉:強度就是它自己,100% 已評等', () => {
    const r = portfolioCarbon([{ carbonIntensity: 0.15, isRated: true, weight: 100 }])
    expect(r.intensity).toBe(0.15)
    expect(r.ratedWeightPct).toBe(100)
    expect(r.unratedWeightPct).toBe(0)
  })

  it('依權重加權,不是算術平均', () => {
    // sNVDA 0.099 佔 1、sMSFT 10.226 佔 3 → (0.099 + 30.678) / 4
    const r = portfolioCarbon([
      { carbonIntensity: 0.099, isRated: true, weight: 1 },
      { carbonIntensity: 10.226, isRated: true, weight: 3 },
    ])
    expect(r.intensity).toBeCloseTo((0.099 + 10.226 * 3) / 4, 10)
  })

  it('未評等持倉不進平均值,只進 unratedWeightPct——「沒有資料不會被當成 0」', () => {
    const r = portfolioCarbon([
      { carbonIntensity: 0.15, isRated: true, weight: 1 },
      { carbonIntensity: null, isRated: false, weight: 1 },
    ])
    expect(r.intensity).toBe(0.15) // 只有已評等那一半
    expect(r.ratedWeightPct).toBe(50)
    expect(r.unratedWeightPct).toBe(50)
  })

  it('全部未評等:強度 null,100% 未評等', () => {
    const r = portfolioCarbon([
      { carbonIntensity: null, isRated: false, weight: 2 },
      { carbonIntensity: null, isRated: false, weight: 3 },
    ])
    expect(r.intensity).toBeNull()
    expect(r.unratedWeightPct).toBe(100)
  })

  it('零與負權重的持倉被忽略,不影響百分比分母', () => {
    const r = portfolioCarbon([
      { carbonIntensity: 0.15, isRated: true, weight: 100 },
      { carbonIntensity: 999, isRated: true, weight: 0 },
      { carbonIntensity: 999, isRated: true, weight: -5 },
    ])
    expect(r.intensity).toBe(0.15)
    expect(r.ratedWeightPct).toBe(100)
  })

  it('isRated 為 true 但碳強度是 null（非營收基準資產）時當成未評等', () => {
    const r = portfolioCarbon([
      { carbonIntensity: 0.15, isRated: true, weight: 1 },
      { carbonIntensity: null, isRated: true, weight: 1 },
    ])
    expect(r.intensity).toBe(0.15)
    expect(r.unratedWeightPct).toBe(50)
  })
})
