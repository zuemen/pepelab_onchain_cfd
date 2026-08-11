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
  { id: 'ach_first_stake',  emoji: '🌱', title: '初次質押',    desc: '持有任何 PEPE',             check: c => c.pepeNum > 0 },
  { id: 'ach_streak3',      emoji: '🔥', title: '3 天連到',    desc: '連續簽到 3 天',              check: c => c.streak >= 3 },
  { id: 'ach_streak7',      emoji: '⚡', title: '週簽神人',    desc: '連續簽到 7 天',              check: c => c.streak >= 7 },
  { id: 'ach_first_trade',  emoji: '📈', title: '首筆交易',    desc: '開過至少一筆倉',              check: c => c.positions >= 1 },
  { id: 'ach_whale',        emoji: '🐋', title: 'Whale 降臨', desc: '持有 100,000 PEPE',           check: c => c.pepeNum >= 100_000 },
  { id: 'ach_collector',    emoji: '🎨', title: '收藏家',      desc: '收藏至少 3 件 Pepe 道具',    check: c => c.owned >= 3 },
  { id: 'ach_degen',        emoji: '🎰', title: 'Degen',       desc: '持有 1,000,000 PEPE',        check: c => c.pepeNum >= 1_000_000 },
  { id: 'ach_legend',       emoji: '👑', title: '傳說 Pepe',   desc: '所有成就解鎖',               check: c => c.streak >= 7 && c.pepeNum >= 100_000 && c.owned >= 3 },
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
    { id: 'q_checkin', emoji: '📅', title: '每日簽到',      reward: `+${dailyRewardFor(c.streak)} PEPE`, progress: c.checkedToday ? 100 : 0,            done: c.checkedToday },
    { id: 'q_trade',   emoji: '📈', title: '開一筆新倉',    reward: '+25 PEPE',                          progress: c.positions > 0 ? 100 : 0,           done: c.positions > 0 },
    { id: 'q_balance', emoji: '💰', title: '持有 100 PEPE', reward: '達成成就',                          progress: Math.min(100, c.pepeNum),            done: c.pepeNum >= 100 },
    { id: 'q_streak3', emoji: '🔥', title: '連簽 3 天',     reward: '解鎖成就',                          progress: Math.min(100, (c.streak / 3) * 100), done: c.streak >= 3 },
  ]
}
