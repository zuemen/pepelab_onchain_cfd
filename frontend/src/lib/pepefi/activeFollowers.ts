// 目前的跟隨者（issue #309）——純函式加一個讀鏈的函式，不含 ethers 或 React。
//
// CopyTracker.getFollowerCount 是 followersByTrader 的長度：每次 followTrader 都 push 一次、
// 取消不移除，同一個人跟兩次也算兩次。所以它是「被跟單過幾次」，不是「現在有幾個人在跟」
// （回放裡 Whale Alpha 被跟過 18 次、目前 9 人）。目前的跟隨者要看每位跟單者自己的跟單紀錄
// 還有沒有 active 的那一筆。不改合約。
//
// 定義跟 eToro 的 copiers 相同：目前至少有一筆 active 跟單的人數，同一個人只算一次。

import { mapLimit, withRetry, RPC_CONCURRENCY } from './rpcBatch'

export interface CopyRecordView {
  trader: string
  active: boolean
}

export interface FollowerReader {
  /** CopyTracker.getFollowerCount：followersByTrader 的長度。 */
  followerCount(trader: string): Promise<bigint>
  /** CopyTracker.followersByTrader(trader, index)。 */
  followerAt(trader: string, index: number): Promise<string>
  /** CopyTracker.getCopyRecords(follower)。 */
  copyRecords(follower: string): Promise<CopyRecordView[]>
}

const lower = (address: string) => address.toLowerCase()

/** everFollowed 是 followersByTrader 的內容（可重複、含已取消的）；回傳目前還在跟的人，依第一次跟單的順序。 */
export function activeFollowers(
  trader: string,
  everFollowed: string[],
  recordsOf: Map<string, CopyRecordView[]>,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const follower of everFollowed) {
    const key = lower(follower)
    if (seen.has(key)) continue
    seen.add(key)
    const records = recordsOf.get(key) ?? []
    if (records.some((r) => r.active && lower(r.trader) === lower(trader))) result.push(follower)
  }
  return result
}

/**
 * 讀出每位交易者目前的跟隨者，key 是小寫地址。跟同一個人只讀一次跟單紀錄。
 * 某位交易者的清單、或其中任何一位跟單者的紀錄讀不到時，他的值是 null——讀不到不能說成 0 人。
 *
 * 每一筆都限制併發並重試：排行榜一次讀幾十位交易者，全部同時送出會撞上公開 RPC 的每秒上限
 * （sepolia.base.org 每秒 25 筆，超過回 429），被擋掉的那一筆就讓整位交易者變成「—」。見 rpcBatch.ts。
 */
export async function readActiveFollowers(
  traders: string[],
  reader: FollowerReader,
): Promise<Map<string, string[] | null>> {
  const counts = await mapLimit(traders, RPC_CONCURRENCY, async (trader) => {
    try {
      return Number(await withRetry(() => reader.followerCount(trader)))
    } catch {
      return null
    }
  })
  // 每位交易者的第 i 位跟單者攤平成一格，所有交易者共用同一個併發上限。
  const slots = traders.flatMap((trader, t) => Array.from({ length: counts[t] ?? 0 }, (_, i) => ({ t, trader, i })))
  const addresses = await mapLimit(slots, RPC_CONCURRENCY, async ({ trader, i }) => {
    try {
      return await withRetry(() => reader.followerAt(trader, i))
    } catch {
      return null
    }
  })
  const lists: Array<string[] | null> = counts.map((count) => (count === null ? null : []))
  slots.forEach(({ t }, k) => {
    const list = lists[t]
    if (list === null) return
    const address = addresses[k]
    if (address === null) lists[t] = null
    else list.push(address)
  })

  const followers = [...new Map(lists.flatMap((list) => list ?? []).map((f) => [lower(f), f])).values()]
  const recordsOf = new Map<string, CopyRecordView[]>()
  const failed = new Set<string>()
  await mapLimit(followers, RPC_CONCURRENCY, async (follower) => {
    try {
      recordsOf.set(lower(follower), await withRetry(() => reader.copyRecords(follower)))
    } catch {
      failed.add(lower(follower))
    }
  })

  return new Map(
    traders.map((trader, i) => {
      const list = lists[i]
      if (list === null || list.some((f) => failed.has(lower(f)))) return [lower(trader), null]
      return [lower(trader), activeFollowers(trader, list, recordsOf)]
    }),
  )
}

export interface FollowersAcross {
  /** 現行 tracker 的跟隨者，加上只在舊 tracker 上還在跟的人；同一個人只算一次。 */
  all: string[]
  /** 其中只在舊 tracker 上還在跟的人數（不會自動同步、不再計分；見 contracts/legacyCopyTrackers.ts）。 */
  legacyOnly: number
}

/**
 * 合併現行與舊 tracker 的跟隨者。現行讀不到 → null（讀不到不能說成 0 人）；某一顆舊 tracker
 * 讀不到 → 只少算那一顆，不讓整格變「—」：現行的人數仍然是對的。
 */
export function combineFollowers(
  current: string[] | null,
  legacy: ReadonlyArray<string[] | null>,
): FollowersAcross | null {
  if (current === null) return null
  const seen = new Set(current.map(lower))
  const all = [...current]
  let legacyOnly = 0
  for (const list of legacy) {
    for (const follower of list ?? []) {
      const key = lower(follower)
      if (seen.has(key)) continue
      seen.add(key)
      all.push(follower)
      legacyOnly += 1
    }
  }
  return { all, legacyOnly }
}

/**
 * readActiveFollowers 的多 tracker 版：先讀現行，再一顆一顆讀舊的（依序，不同時送，免得公開 RPC 的
 * 每秒上限被加倍），最後用 combineFollowers 合併。
 */
export async function readFollowersAcross(
  traders: string[],
  current: FollowerReader,
  legacy: readonly FollowerReader[],
): Promise<Map<string, FollowersAcross | null>> {
  const now = await readActiveFollowers(traders, current)
  const old: Array<Map<string, string[] | null>> = []
  for (const reader of legacy) {
    try {
      old.push(await readActiveFollowers(traders, reader))
    } catch {
      old.push(new Map())
    }
  }
  return new Map(
    traders.map((trader) => {
      const key = lower(trader)
      return [key, combineFollowers(now.get(key) ?? null, old.map((m) => m.get(key) ?? null))]
    }),
  )
}

/** CopyTracker 合約上這三個 view 的形狀。 */
interface CopyTrackerViews {
  getFollowerCount(trader: string): Promise<unknown>
  followersByTrader(trader: string, index: bigint): Promise<unknown>
  getCopyRecords(follower: string): Promise<unknown>
}

/**
 * 把 useContracts 的 copyTracker 包成 FollowerReader，排行榜與個人頁共用。
 * 收 object 再轉型：ethers 的 Contract 用索引簽章提供方法，型別上看不出有這三個 view。
 */
export const followerReaderOf = (contract: object): FollowerReader => {
  const copyTracker = contract as CopyTrackerViews
  return {
    followerCount: async (trader) => BigInt(await copyTracker.getFollowerCount(trader) as bigint),
    followerAt: async (trader, index) => String(await copyTracker.followersByTrader(trader, BigInt(index))),
    copyRecords: async (follower) =>
      (await copyTracker.getCopyRecords(follower) as Array<{ trader: string; active: boolean }>)
        .map((r) => ({ trader: String(r.trader), active: Boolean(r.active) })),
  }
}
