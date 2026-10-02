import { id, JsonRpcProvider } from 'ethers'
import { it, expect, describe, afterAll } from 'vitest'

import {
  ACHIEVEMENTS,
  buildQuests,
  dailyRewardFor,
  probeCheckInUnit,
  checkInUnitFromCode,
  ACHIEVEMENT_POINTS_SELECTOR,
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

describe('probeCheckInUnit — 簽到發的是什麼,看 bytecode,不靠試呼叫', () => {
  // 舊版與 #169 版 runtime bytecode 的最小替身：dispatcher 以 PUSH4 比對 selector。
  // 舊版有 lastCheckIn(0xef6fdb1c)沒有 achievementPoints(0xeaf542d4)。
  const OLD_CODE = '0x6080604052' + '63ef6fdb1c' + '14'
  const NEW_CODE = '0x6080604052' + '63ef6fdb1c' + '14' + '63eaf542d4' + '14'
  const POINTS = 110n * 10n ** 18n
  const INCENTIVES = '0xEBfA1dc7dDea032ac6242cB619d982e543A23c12'

  // ethers v6 把 JSON-RPC 錯誤轉成 Error 的方式：與線上 provider 相同的 getRpcError。
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 84532, { staticNetwork: true })
  const rpcError = (code: number, message: string, method = 'eth_getCode') =>
    provider.getRpcError(
      {
        method,
        params: method === 'eth_call' ? [{ to: INCENTIVES, data: '0xeaf542d4' }, 'latest'] : [INCENTIVES, 'latest'],
        id: 1,
        jsonrpc: '2.0',
      },
      { id: 1, error: { code, message } },
    )
  const RPC_ERRORS: Array<[number, string]> = [
    [-32005, 'limit exceeded'],
    [-32000, 'header not found'],
    [-32603, 'Internal JSON-RPC error.'],
    [429, 'Too Many Requests'],
  ]
  afterAll(() => provider.destroy())

  const deps = (code: () => Promise<string | null>, points: () => Promise<unknown> = () => Promise.resolve(POINTS)) =>
    ({ getCode: code, readPoints: points })

  it('selector 常數就是 achievementPoints(address)', () => {
    expect(id('achievementPoints(address)').slice(0, 10)).toBe(ACHIEVEMENT_POINTS_SELECTOR)
  })

  it('bytecode 含 achievementPoints → 點數版,並帶回點數', async () => {
    expect(await probeCheckInUnit(deps(() => Promise.resolve(NEW_CODE)), null))
      .toEqual({ unit: 'points', points: POINTS })
  })

  it('bytecode 不含 → PEPE 版,不讀點數', async () => {
    let read = 0
    const r = await probeCheckInUnit(deps(() => Promise.resolve(OLD_CODE), () => { read += 1; return Promise.resolve(0n) }), null)
    expect(r).toEqual({ unit: 'pepe', points: null })
    expect(read).toBe(0)
  })

  it('沒有合約(0x / null)→ 未知,不下結論', async () => {
    expect((await probeCheckInUnit(deps(() => Promise.resolve('0x')), null)).unit).toBeNull()
    expect((await probeCheckInUnit(deps(() => Promise.resolve(null)), null)).unit).toBeNull()
    expect((await probeCheckInUnit(deps(() => Promise.resolve('0x')), 'pepe')).unit).toBe('pepe')
  })

  it('這些 RPC 錯誤在 ethers 裡都長得像「沒有這個函式」—— 正是不能用試呼叫的原因', () => {
    for (const [code, msg] of RPC_ERRORS) {
      const e = rpcError(code, msg, 'eth_call') as Error & { code?: string }
      expect(e.code, String(code)).toBe('CALL_EXCEPTION')
    }
  })

  it.each(RPC_ERRORS)('getCode 失敗(%i %s)→ 未知;已確定的結論維持不變', async (code, msg) => {
    const failing = () => Promise.reject(rpcError(code, msg))
    expect((await probeCheckInUnit(deps(failing), null)).unit).toBeNull()
    expect((await probeCheckInUnit(deps(failing), 'pepe')).unit).toBe('pepe')
    const r = await probeCheckInUnit(deps(failing), 'points')
    expect(r.unit).toBe('points')
    expect(r.points).toBe(POINTS)
  })

  it.each(RPC_ERRORS)('點數讀取失敗(%i %s)→ 仍是點數版,點數未知(維持畫面上的值)', async (code, msg) => {
    const r = await probeCheckInUnit(deps(() => Promise.resolve(NEW_CODE), () => Promise.reject(rpcError(code, msg, 'eth_call'))), null)
    expect(r).toEqual({ unit: 'points', points: null })
  })

  it('確定是點數版之後不再降級', async () => {
    expect((await probeCheckInUnit(deps(() => Promise.resolve(OLD_CODE)), 'points')).unit).toBe('points')
  })

  it('同步丟錯、回傳非 bigint 都不會讓頁面壞掉', async () => {
    const contract = {} as { getDeployedCode?: () => Promise<string | null> }
    expect((await probeCheckInUnit(deps(() => contract.getDeployedCode!()), null)).unit).toBeNull()
    expect(await probeCheckInUnit(deps(() => Promise.resolve(NEW_CODE), () => Promise.resolve('0x')), null))
      .toEqual({ unit: 'points', points: null })
  })

  it('checkInUnitFromCode:PUSH 資料區裡的位元組不算', () => {
    expect(checkInUnitFromCode(NEW_CODE)).toBe('points')
    expect(checkInUnitFromCode(OLD_CODE)).toBe('pepe')
    // 0x7f = PUSH32,後面 32 bytes 是資料,裡面恰好有 63eaf542d4
    expect(checkInUnitFromCode('0x7f63eaf542d4' + '00'.repeat(27) + '63ef6fdb1c14')).toBe('pepe')
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
