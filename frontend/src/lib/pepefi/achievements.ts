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
 * The daily check-in reward, as non-transferable achievement points (issue
 * #101 — no longer PEPE, because anything transferable acquires a price and
 * anything with a price gets farmed). 50, +10 per consecutive day, capped at
 * a 7-day streak (110).
 */
export const dailyRewardFor = (streak: number) => 50 + 10 * Math.min(streak, 6)

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
