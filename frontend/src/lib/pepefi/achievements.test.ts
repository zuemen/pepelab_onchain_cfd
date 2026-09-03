import { describe, it, expect } from 'vitest'

import {
  ACHIEVEMENTS,
  buildQuests,
  dailyRewardFor,
  TODAY_INDEX,
  type AchCtx,
} from './achievements'

// issue #101 — 成就輸入反轉. This module had no tests; this file is the seam.
// It pins (a) the unlock conditions against the new inputs and (b) that the
// three achievements the issue names for deletion are gone.

const base: AchCtx = {
  holdingDays: 0,
  portfolioCarbon: null,
  diversification: 0,
  untouchedDays: 0,
}
const ctx = (over: Partial<AchCtx>): AchCtx => ({ ...base, ...over })
const unlocked = (c: AchCtx) => ACHIEVEMENTS.filter(a => a.check(c)).map(a => a.id)

describe('ACHIEVEMENTS — 已刪除的成就', () => {
  it('ach_degen / ach_whale / ach_first_trade 不再存在', () => {
    const ids = ACHIEVEMENTS.map(a => a.id)
    expect(ids).not.toContain('ach_degen')
    expect(ids).not.toContain('ach_whale')
    expect(ids).not.toContain('ach_first_trade')
  })

  it('獎勵「買得多、交易得多」的舊成就一併退場', () => {
    const ids = ACHIEVEMENTS.map(a => a.id)
    for (const gone of ['ach_first_stake', 'ach_streak3', 'ach_streak7', 'ach_collector', 'ach_legend']) {
      expect(ids, gone).not.toContain(gone)
    }
  })

  it('每個成就都有非空的標題與說明', () => {
    for (const a of ACHIEVEMENTS) {
      expect(a.title.length, a.id).toBeGreaterThan(0)
      expect(a.desc.length, a.id).toBeGreaterThan(0)
    }
  })
})

describe('ACHIEVEMENTS — 新的解鎖條件', () => {
  it('空白狀態(剛連錢包)不解鎖任何成就', () => {
    expect(unlocked(base)).toEqual([])
  })

  it('ach_hold_30 / ach_hold_90 依持有天數解鎖', () => {
    expect(unlocked(ctx({ holdingDays: 29 }))).not.toContain('ach_hold_30')
    expect(unlocked(ctx({ holdingDays: 30 }))).toContain('ach_hold_30')
    expect(unlocked(ctx({ holdingDays: 89 }))).not.toContain('ach_hold_90')
    expect(unlocked(ctx({ holdingDays: 90 }))).toEqual(
      expect.arrayContaining(['ach_hold_30', 'ach_hold_90']),
    )
  })

  it('ach_low_carbon:碳強度低於 1 才解鎖,未評等(null)不算', () => {
    expect(unlocked(ctx({ portfolioCarbon: null }))).not.toContain('ach_low_carbon')
    expect(unlocked(ctx({ portfolioCarbon: 1 }))).not.toContain('ach_low_carbon')
    expect(unlocked(ctx({ portfolioCarbon: 0.15 }))).toContain('ach_low_carbon')
  })

  it('ach_diversified:分散度 0.7 以上解鎖', () => {
    expect(unlocked(ctx({ diversification: 0.69 }))).not.toContain('ach_diversified')
    expect(unlocked(ctx({ diversification: 0.7 }))).toContain('ach_diversified')
  })

  it('ach_steady:連續 30 天沒有操作解鎖', () => {
    expect(unlocked(ctx({ untouchedDays: 29 }))).not.toContain('ach_steady')
    expect(unlocked(ctx({ untouchedDays: 30 }))).toContain('ach_steady')
  })

  it('ach_steward:三個條件全滿足才解鎖', () => {
    expect(unlocked(ctx({ holdingDays: 90, portfolioCarbon: 0.15, diversification: 0.6 })))
      .not.toContain('ach_steward')
    expect(unlocked(ctx({ holdingDays: 90, portfolioCarbon: 0.15, diversification: 0.8 })))
      .toContain('ach_steward')
  })

  it('一個「買得多」的錢包(舊贏家)在新規則下解鎖不了任何東西', () => {
    // 舊的 AchCtx 欄位塞進來會被忽略——holdingDays 之類的預設 0。
    const oldWinner = ctx({}) as AchCtx & Record<string, number>
    oldWinner.pepeNum = 1_000_000
    oldWinner.streak = 30
    oldWinner.positions = 50
    oldWinner.owned = 10
    expect(unlocked(oldWinner)).toEqual([])
  })
})

describe('dailyRewardFor — 成就點數,不是 PEPE', () => {
  it('第一天 50,每連續一天 +10,7 天封頂 110', () => {
    expect(dailyRewardFor(0)).toBe(50)
    expect(dailyRewardFor(1)).toBe(60)
    expect(dailyRewardFor(6)).toBe(110)
    expect(dailyRewardFor(30)).toBe(110)
  })
})

describe('buildQuests', () => {
  const qctx = { streak: 0, pepeNum: 0, positions: 0, checkedToday: false }

  it('每日簽到的獎勵以成就點數計,不再發 PEPE', () => {
    const q = buildQuests(qctx).find(x => x.id === 'q_checkin')!
    expect(q.reward).toContain('成就點數')
    expect(q.reward).not.toContain('PEPE')
  })

  it('簽到後 q_checkin 完成', () => {
    const q = buildQuests({ ...qctx, checkedToday: true }).find(x => x.id === 'q_checkin')!
    expect(q.done).toBe(true)
    expect(q.progress).toBe(100)
  })
})

describe('TODAY_INDEX', () => {
  it('回傳自 epoch 起的整數天數', () => {
    const i = TODAY_INDEX()
    expect(Number.isInteger(i)).toBe(true)
    expect(i).toBeGreaterThan(20000) // 2024 以後
  })
})
