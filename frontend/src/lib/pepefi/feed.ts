// 鏈上動態牆（issue #335）——鏈上事件 → 人看得懂的動態項目。純函式，不含 ethers 或 React。
//
// 每一則都來自一筆（或同一天的幾筆）鏈上交易，所以不需要審核、也不會有假消息。說明句子不是 AI 寫的：
// 這裡只算出句子要填的參數（加了什麼、減了什麼、多少錢），句型放在 String Catalog（t.feed），兩語系。
//
// 「大額」沿用巨鯨追蹤的門檻（whale.ts 的 isWhaleTrade），不另訂一個。

import { isWhaleTrade, WHALE_THRESHOLD } from './whale'

// ── 輸入：掃描得到的事件 ──────────────────────────────────────────────────────

interface EventBase {
  blockNumber: number
  logIndex: number
  /** Unix 秒。 */
  timestamp: number
  txHash: string
}

export type FeedEvent =
  | (EventBase & {
      kind: 'open'
      owner: string
      positionId: string
      asset: string
      isLong: boolean
      leverage: bigint
      notional: bigint
    })
  | (EventBase & { kind: 'close' | 'liquidated'; owner: string; positionId: string; pnl: bigint })
  | (EventBase & { kind: 'publish'; trader: string; versionId: number })
  | (EventBase & { kind: 'follow'; trader: string; follower: string; totalMargin: bigint })
  | (EventBase & { kind: 'unfollow'; trader: string; follower: string })
  | (EventBase & { kind: 'slash'; trader: string; follower: string; amount: bigint })
  /** 碳權退役（#333）。amount 已換成 18 位小數；tonnes 是 1e18 = 1 噸。事件沒有發起人：這是平台的動作。 */
  | (EventBase & { kind: 'retire'; amount: bigint; tonnes: bigint })
  /** 跟單自動同步（ADR-024）：某筆跟單的部位被調成交易者的 toVersion。跟隨者與執行者不上動態。 */
  | (EventBase & { kind: 'resync'; trader: string; follower: string; fromVersion: number; toVersion: number })
  /** 跟隨者開啟或關閉某筆跟單的自動同步。trader 讀不到時這則不列。 */
  | (EventBase & { kind: 'autoSync'; trader: string; follower: string; enabled: boolean })

/** 一版策略裡的一檔，與 StrategyRegistry.getStrategyVersion 回傳的相同。 */
export interface FeedLeg {
  asset: string
  weightBps: number
  isLong: boolean
  leverage: number
}

export interface FeedContext {
  /** 小寫位址 → StrategyRegistry 上的名稱。沒註冊的位址不在裡面。 */
  names: ReadonlyMap<string, string>
  /** `${小寫位址}:${versionId}` → 那一版的持倉。讀不到的版本不在裡面。 */
  versions: ReadonlyMap<string, FeedLeg[]>
  /** 大額開平倉的門檻（名目，18 位小數）。預設與巨鯨追蹤相同。 */
  threshold?: bigint
}

// ── 輸出：動態項目 ────────────────────────────────────────────────────────────

export interface StrategyDiff {
  added: { asset: string; weightBps: number; isLong: boolean }[]
  removed: { asset: string }[]
  reweighted: { asset: string; fromBps: number; toBps: number }[]
  /** 方向翻轉：isLong 是新的方向。 */
  flipped: { asset: string; isLong: boolean }[]
}

export type FeedItem = {
  /** 穩定的 key：同一批事件永遠得到同一個 id。 */
  id: string
  blockNumber: number
  logIndex: number
  timestamp: number
  /** 回鏈上核對用的交易；聚合的項目是當天最後一筆。 */
  txHash: string
  /** 主角（交易者或開倉的人），小寫。平台自己的動作（碳權退役）是空字串。 */
  actor: string
  /** 只有在 StrategyRegistry 註冊過才有名稱。 */
  actorName: string | null
} & (
  | { type: 'strategy'; versionId: number; legs: FeedLeg[] | null; first: boolean; diff: StrategyDiff | null }
  | { type: 'bigOpen'; asset: string; isLong: boolean; leverage: bigint; notional: bigint }
  | { type: 'bigClose'; asset: string; isLong: boolean; notional: bigint; pnl: bigint }
  /** 清算一律列出，不看金額；開倉在掃描視窗之外時不知道資產與規模，那三個欄位是 null。 */
  | { type: 'liquidation'; asset: string | null; isLong: boolean | null; notional: bigint | null; pnl: bigint }
  /** 同一位交易者同一天（UTC）的跟隨合成一則；不列出跟隨者的位址。 */
  | { type: 'follow'; day: string; count: number; totalMargin: bigint }
  | { type: 'unfollow'; day: string; count: number }
  | { type: 'slash'; amount: bigint }
  | { type: 'retirement'; amount: bigint; tonnes: bigint }
  /** 同一位交易者、同一個目標版本的同步合成一則。 */
  | { type: 'resync'; toVersion: number; count: number }
  /** 同一位交易者同一天（UTC）開啟（或關閉）自動同步的合成一則。 */
  | { type: 'autoSync'; day: string; enabled: boolean; count: number }
)

export type FeedType = FeedItem['type']

export const FEED_TYPES: readonly FeedType[] = [
  'strategy', 'bigOpen', 'bigClose', 'liquidation', 'follow', 'unfollow', 'slash', 'retirement', 'resync', 'autoSync',
]

/** 跟單功能的動態類型：跟單旗標關閉的建置不列（FeedPage 的 VISIBLE_TYPES）。 */
export const COPY_FEED_TYPES: readonly FeedType[] = ['follow', 'unfollow', 'resync', 'autoSync']

// ── 轉換 ─────────────────────────────────────────────────────────────────────

const versionKey = (trader: string, versionId: number) => `${trader.toLowerCase()}:${versionId}`

const utcDay = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(0, 10)

/** 前後兩版的差異。第一版（沒有前一版）不算差異。 */
export function diffStrategy(previous: FeedLeg[], next: FeedLeg[]): StrategyDiff {
  const before = new Map(previous.map((l) => [l.asset, l]))
  const after = new Map(next.map((l) => [l.asset, l]))
  const diff: StrategyDiff = { added: [], removed: [], reweighted: [], flipped: [] }
  for (const leg of next) {
    const old = before.get(leg.asset)
    if (!old) {
      diff.added.push({ asset: leg.asset, weightBps: leg.weightBps, isLong: leg.isLong })
      continue
    }
    if (old.isLong !== leg.isLong) diff.flipped.push({ asset: leg.asset, isLong: leg.isLong })
    if (old.weightBps !== leg.weightBps) diff.reweighted.push({ asset: leg.asset, fromBps: old.weightBps, toBps: leg.weightBps })
  }
  for (const leg of previous) if (!after.has(leg.asset)) diff.removed.push({ asset: leg.asset })
  return diff
}

const newestFirst = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) =>
  b.blockNumber - a.blockNumber || b.logIndex - a.logIndex

/**
 * 事件 → 動態，新到舊（先比區塊、同塊再比 log 序號）。
 *
 * - 開倉、平倉：只列名目達門檻的。平倉的名目來自同一個部位的開倉事件；開倉不在掃描視窗內就不知道規模，不列。
 * - 清算、罰沒：一律列出——風險事件不能被藏起來。
 * - 策略發布：和前一版比出新增、移除、權重變化與方向翻轉；讀不到前一版時 diff 為 null（畫面只說「發布了新版」）。
 * - 跟隨、取消：同一位交易者同一天各合成一則。
 * - 碳權退役：一律列出，主角是平台（actor 為空字串）。
 * - 自動同步（ADR-024）：同一位交易者同一版的同步合成一則；開關自動同步依交易者、日期、開或關合成。
 */
export function buildFeed(events: readonly FeedEvent[], ctx: FeedContext): FeedItem[] {
  const threshold = ctx.threshold ?? WHALE_THRESHOLD
  const nameOf = (address: string) => (address ? ctx.names.get(address.toLowerCase()) || null : null)
  const opens = new Map<string, Extract<FeedEvent, { kind: 'open' }>>()
  for (const e of events) if (e.kind === 'open') opens.set(e.positionId, e)

  const items: FeedItem[] = []
  const groups = new Map<string, Extract<FeedEvent, { kind: 'follow' | 'unfollow' }>[]>()
  const syncGroups = new Map<string, Extract<FeedEvent, { kind: 'resync' | 'autoSync' }>[]>()
  const base = (e: FeedEvent, actor: string) => ({
    id: `${e.kind}:${e.txHash}:${e.logIndex}`,
    blockNumber: e.blockNumber,
    logIndex: e.logIndex,
    timestamp: e.timestamp,
    txHash: e.txHash,
    actor: actor.toLowerCase(),
    actorName: nameOf(actor),
  })

  for (const e of events) {
    switch (e.kind) {
      case 'open':
        if (isWhaleTrade(e.notional, threshold)) {
          items.push({ ...base(e, e.owner), type: 'bigOpen', asset: e.asset, isLong: e.isLong, leverage: e.leverage, notional: e.notional })
        }
        break
      case 'close': {
        const open = opens.get(e.positionId)
        if (open && isWhaleTrade(open.notional, threshold)) {
          items.push({ ...base(e, e.owner), type: 'bigClose', asset: open.asset, isLong: open.isLong, notional: open.notional, pnl: e.pnl })
        }
        break
      }
      case 'liquidated': {
        const open = opens.get(e.positionId)
        items.push({
          ...base(e, e.owner),
          type: 'liquidation',
          asset: open?.asset ?? null,
          isLong: open?.isLong ?? null,
          notional: open?.notional ?? null,
          pnl: e.pnl,
        })
        break
      }
      case 'publish': {
        const legs = ctx.versions.get(versionKey(e.trader, e.versionId)) ?? null
        const first = e.versionId === 0
        const previous = first ? null : ctx.versions.get(versionKey(e.trader, e.versionId - 1)) ?? null
        items.push({
          ...base(e, e.trader),
          type: 'strategy',
          versionId: e.versionId,
          legs,
          first,
          diff: legs && previous ? diffStrategy(previous, legs) : null,
        })
        break
      }
      case 'follow':
      case 'unfollow': {
        const key = `${e.kind}:${e.trader.toLowerCase()}:${utcDay(e.timestamp)}`
        groups.set(key, [...(groups.get(key) ?? []), e])
        break
      }
      case 'slash':
        items.push({ ...base(e, e.trader), type: 'slash', amount: e.amount })
        break
      case 'retire':
        // 一律列出：退役是平台把跟單費的一部分拿去做的事，金額小也要看得到
        items.push({ ...base(e, ''), type: 'retirement', amount: e.amount, tonnes: e.tonnes })
        break
      case 'resync': {
        const key = `resync:${e.trader.toLowerCase()}:${e.toVersion}`
        syncGroups.set(key, [...(syncGroups.get(key) ?? []), e])
        break
      }
      case 'autoSync': {
        if (!e.trader) break
        const key = `autoSync:${e.trader.toLowerCase()}:${utcDay(e.timestamp)}:${e.enabled ? 'on' : 'off'}`
        syncGroups.set(key, [...(syncGroups.get(key) ?? []), e])
        break
      }
      default:
        break
    }
  }

  for (const [key, group] of groups) {
    const last = [...group].sort(newestFirst)[0]
    const common = { ...base(last, last.trader), id: key }
    const day = utcDay(last.timestamp)
    if (last.kind === 'follow') {
      const totalMargin = group.reduce((sum, e) => sum + (e.kind === 'follow' ? e.totalMargin : 0n), 0n)
      items.push({ ...common, type: 'follow', day, count: group.length, totalMargin })
    } else {
      items.push({ ...common, type: 'unfollow', day, count: group.length })
    }
  }

  for (const [key, group] of syncGroups) {
    const last = [...group].sort(newestFirst)[0]
    const common = { ...base(last, last.trader), id: key }
    if (last.kind === 'resync') {
      items.push({ ...common, type: 'resync', toVersion: last.toVersion, count: group.length })
    } else {
      items.push({ ...common, type: 'autoSync', day: utcDay(last.timestamp), enabled: last.enabled, count: group.length })
    }
  }

  return items.sort(newestFirst)
}

// ── 篩選與狀態 ────────────────────────────────────────────────────────────────

export interface FeedFilter {
  types?: readonly FeedType[]
  /** 小寫位址；有給就只留這位的動態。 */
  actor?: string | null
}

export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  const actor = filter.actor?.toLowerCase() ?? null
  return items.filter(
    (item) => (!filter.types || filter.types.includes(item.type)) && (actor === null || item.actor === actor)
  )
}

/**
 * 掃描有任何一段讀不到，動態就是不完整：畫面必須明講，不能把「讀不到」顯示成「沒有發生」。
 */
export const isFeedIncomplete = (failedChunks: readonly number[]): boolean => failedChunks.some((n) => n > 0)

// ── 多空比例 ──────────────────────────────────────────────────────────────────

export interface SideOfMarket {
  asset: string
  /** 0–1，多方占這個市場未平倉名目的比例；這個市場沒有未平倉時為 null。 */
  longShare: number | null
  /** 交易者在這一檔的方向是不是市場目前的多數方；畫面上會顯示成 50% / 50%（差不到半個百分點）或沒有未平倉時為 null。 */
  withMajority: boolean | null
}

/** 策略中每一檔：市場目前站在哪一邊、交易者和市場同邊還是反邊。多空數字沿用巨鯨追蹤的市場情緒讀取。 */
export function sidesOfMarket(
  legs: readonly { asset: string; isLong: boolean }[],
  sentiment: readonly { asset: string; longShare: number; total: bigint }[]
): SideOfMarket[] {
  const byAsset = new Map(sentiment.map((s) => [s.asset, s]))
  return legs.map((leg) => {
    const s = byAsset.get(leg.asset)
    if (!s || s.total === 0n) return { asset: leg.asset, longShare: null, withMajority: null }
    // 和畫面的整數百分比一致：顯示成 50% / 50% 卻標「反邊」會自相矛盾
    const even = Math.round(s.longShare * 100) === 50
    const withMajority = even ? null : (s.longShare > 0.5) === leg.isLong
    return { asset: leg.asset, longShare: s.longShare, withMajority }
  })
}
