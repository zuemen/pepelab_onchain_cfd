import { t, interpolate } from 'src/locales'

// Achievements, daily quests, and the check-in reward curve.
//
// These lived inline in DashboardPage and (until it was deleted) in an
// identical copy in HomePage. RewardsPage kept its own third copy of the
// reward curve. Three pages now render the same progression, so the rules
// live in one place — a badge that unlocks on /dashboard has to unlock on
// /pepe too, and that is only free if there is a single definition.

/** Days since epoch. The check-in contract keys streaks by this index. */
export const TODAY_INDEX = () => Math.floor(Date.now() / 1000 / 86400)

/** 50 PEPE, +10 per consecutive day, capped at 7 days (110 PEPE). */
export const dailyRewardFor = (streak: number) => 50 + 10 * Math.min(streak, 6)

// ── Achievements ──────────────────────────────────────────────────────────────

export interface AchCtx {
  streak:    number
  pepeNum:   number
  positions: number
  owned:     number
}

export interface Achievement {
  id:    string
  emoji: string
  title: string
  desc:  string
  check: (ctx: AchCtx) => boolean
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'ach_first_stake', emoji: '🌱', title: t.pepe.achievement.ach_first_stake.title, desc: t.pepe.achievement.ach_first_stake.desc, check: c => c.pepeNum > 0 },
  { id: 'ach_streak3', emoji: '🔥', title: t.pepe.achievement.ach_streak3.title, desc: t.pepe.achievement.ach_streak3.desc, check: c => c.streak >= 3 },
  { id: 'ach_streak7', emoji: '⚡', title: t.pepe.achievement.ach_streak7.title, desc: t.pepe.achievement.ach_streak7.desc, check: c => c.streak >= 7 },
  { id: 'ach_first_trade', emoji: '📈', title: t.pepe.achievement.ach_first_trade.title, desc: t.pepe.achievement.ach_first_trade.desc, check: c => c.positions >= 1 },
  { id: 'ach_whale', emoji: '🐋', title: t.pepe.achievement.ach_whale.title, desc: t.pepe.achievement.ach_whale.desc, check: c => c.pepeNum >= 100_000 },
  { id: 'ach_collector', emoji: '🎨', title: t.pepe.achievement.ach_collector.title, desc: t.pepe.achievement.ach_collector.desc, check: c => c.owned >= 3 },
  { id: 'ach_degen', emoji: '🎰', title: t.pepe.achievement.ach_degen.title, desc: t.pepe.achievement.ach_degen.desc, check: c => c.pepeNum >= 1_000_000 },
  { id: 'ach_legend', emoji: '👑', title: t.pepe.achievement.ach_legend.title, desc: t.pepe.achievement.ach_legend.desc, check: c => c.streak >= 7 && c.pepeNum >= 100_000 && c.owned >= 3 },
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
