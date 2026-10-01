import { t, interpolate } from 'src/locales'

// Achievements, daily quests, and the check-in reward curve.
//
// These lived inline in DashboardPage and (until it was deleted) in an
// identical copy in HomePage. RewardsPage kept its own third copy of the
// reward curve. The rules live in one place — a badge that unlocks on
// /portfolio has to unlock on /pepe too, and that is only free if there is a
// single definition.
//
// issue #101 — 成就輸入反轉. The inputs used to be `streak · pepeNum ·
// positions · owned`: three of the four rewarded "hold more PEPE, trade
// more", and level was effectively bought. They are now `holdingDays ·
// portfolioCarbon · diversification · untouchedDays` — the platform rewards
// what a long-term, low-carbon, diversified holder actually does. Same
// `Achievement` shape, same array export; only what feeds it changed.

/** Days since epoch. The check-in contract keys streaks by this index. */
export const TODAY_INDEX = () => Math.floor(Date.now() / 1000 / 86400)

/**
 * The daily check-in amount: 50, +10 per consecutive day, capped at a 7-day
 * streak (110).
 *
 * WHAT it is an amount of depends on the PepeIncentives build behind the
 * address (see `probeCheckInUnit`). Issue #101 decided it should be
 * non-transferable achievement points — anything transferable acquires a
 * price and anything with a price gets farmed — and issue #169 implements
 * that in the contract source. The build deployed today still transfers PEPE,
 * and a screen must say what the chain actually does.
 */
export const dailyRewardFor = (streak: number) => 50 + 10 * Math.min(streak, 6)

// ── What a check-in pays (capability probe) ──────────────────────────────────

/**
 * 'pepe'   — the PepeIncentives deployed today: `dailyCheckIn()` transfers PEPE.
 * 'points' — the #169 build: `dailyCheckIn()` credits non-transferable
 *            achievement points kept in the contract (`achievementPoints`).
 */
export type CheckInUnit = 'pepe' | 'points'

export interface CheckInProbe {
  unit: CheckInUnit
  /** The wallet's achievement points (18 decimals); null on a 'pepe' build. */
  points: bigint | null
}

/**
 * The one read the probe needs: `achievementPoints(address)` on the
 * PepeIncentives contract. Passed as a function so the probe does not depend
 * on the ethers Contract type (and so a missing method throws inside the
 * probe's own try block).
 */
export type ReadAchievementPoints = (address: string) => Promise<unknown>

/**
 * ethers v6 codes for "the contract answered, and it does not have this
 * function": the call reverted with no data (CALL_EXCEPTION), or returned
 * nothing to decode (BAD_DATA).
 */
const NO_SUCH_FUNCTION_CODES = new Set(['CALL_EXCEPTION', 'BAD_DATA'])

/**
 * Ask the contract which build it is, rather than assuming from the address.
 * `achievementPoints(address)` exists only on the #169 build.
 *
 * Returns null when the answer is unknown (RPC down, timeout): the caller
 * keeps whatever it showed before instead of flipping the wording on a
 * network hiccup.
 */
export async function probeCheckInUnit(
  readPoints: ReadAchievementPoints,
  address: string,
): Promise<CheckInProbe | null> {
  try {
    const points = await readPoints(address)
    return typeof points === 'bigint' ? { unit: 'points', points } : null
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    return typeof code === 'string' && NO_SUCH_FUNCTION_CODES.has(code)
      ? { unit: 'pepe', points: null }
      : null
  }
}

// ── Achievements ──────────────────────────────────────────────────────────────

export interface AchCtx {
  /** 這個錢包持有最久的部位已經開了幾天(Anchor Date 的天數)。 */
  holdingDays: number
  /** 投資組合的市值加權碳強度;沒有已評等持倉時為 null。 */
  portfolioCarbon: number | null
  /** 0–1,持倉在各資產之間攤得多均(lib/pepefi/diversification.ts)。 */
  diversification: number
  /** 距離上一次任何操作(開倉、平倉、贖回)已經幾天沒動。 */
  untouchedDays: number
}

export interface Achievement {
  id:    string
  emoji: string
  title: string
  desc:  string
  check: (ctx: AchCtx) => boolean
}

/** 低碳門檻對齊 carbon.ts 的 Low 級距上限。 */
const LOW_CARBON_MAX = 1
/** 「夠分散」的門檻——和 StrategyRegistry 的多元化約束同精神,但這裡只是呈現。 */
const DIVERSIFIED_MIN = 0.7

const lowCarbon = (c: AchCtx) => c.portfolioCarbon !== null && c.portfolioCarbon < LOW_CARBON_MAX
const diversified = (c: AchCtx) => c.diversification >= DIVERSIFIED_MIN

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'ach_hold_30',     emoji: '⏳', title: t.pepe.achievement.ach_hold_30.title,     desc: t.pepe.achievement.ach_hold_30.desc,     check: c => c.holdingDays >= 30 },
  { id: 'ach_hold_90',     emoji: '🗓️', title: t.pepe.achievement.ach_hold_90.title,     desc: t.pepe.achievement.ach_hold_90.desc,     check: c => c.holdingDays >= 90 },
  { id: 'ach_low_carbon',  emoji: '🌱', title: t.pepe.achievement.ach_low_carbon.title,  desc: t.pepe.achievement.ach_low_carbon.desc,  check: lowCarbon },
  { id: 'ach_diversified', emoji: '🧺', title: t.pepe.achievement.ach_diversified.title, desc: t.pepe.achievement.ach_diversified.desc, check: diversified },
  { id: 'ach_steady',      emoji: '🧘', title: t.pepe.achievement.ach_steady.title,      desc: t.pepe.achievement.ach_steady.desc,      check: c => c.untouchedDays >= 30 },
  { id: 'ach_steward',     emoji: '👑', title: t.pepe.achievement.ach_steward.title,     desc: t.pepe.achievement.ach_steward.desc,     check: c => c.holdingDays >= 90 && lowCarbon(c) && diversified(c) },
]

// ── Daily quests ──────────────────────────────────────────────────────────────

export interface Quest {
  id:       string
  emoji:    string
  title:    string
  reward:   string
  progress: number   // 0-100
  done:     boolean
}

export interface QuestCtx {
  streak:       number
  pepeNum:      number
  positions:    number
  checkedToday: boolean
}

/** Quests are derived from live state, so they are built rather than listed. */
export function buildQuests(c: QuestCtx): Quest[] {
  return [
    { id: 'q_checkin', emoji: '📅', title: t.pepe.quest.q_checkin.title, reward: interpolate(t.pepe.quest.q_checkin.reward, { amount: dailyRewardFor(c.streak) }), progress: c.checkedToday ? 100 : 0,            done: c.checkedToday },
    { id: 'q_trade', emoji: '📈', title: t.pepe.quest.q_trade.title, reward: t.pepe.quest.q_trade.reward, progress: c.positions > 0 ? 100 : 0,           done: c.positions > 0 },
    { id: 'q_balance', emoji: '💰', title: t.pepe.quest.q_balance.title, reward: t.pepe.quest.q_balance.reward, progress: Math.min(100, c.pepeNum),            done: c.pepeNum >= 100 },
    { id: 'q_streak3', emoji: '🔥', title: t.pepe.quest.q_streak3.title, reward: t.pepe.quest.q_streak3.reward, progress: Math.min(100, (c.streak / 3) * 100), done: c.streak >= 3 },
  ]
}
