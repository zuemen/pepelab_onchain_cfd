// 目前的跟隨者（issue #309）——純函式加一個讀鏈的函式，不含 React。
//
// CopyTracker.getFollowerCount 是 followersByTrader 的長度：每次 followTrader 都 push 一次、
// 取消不移除，同一個人跟兩次也算兩次。所以它是「被跟單過幾次」，不是「現在有幾個人在跟」
// （回放裡 Whale Alpha 被跟過 18 次、目前 9 人）。目前的跟隨者要看每位跟單者自己的跟單紀錄
// 還有沒有 active 的那一筆。不改合約。
//
// 定義跟 eToro 的 copiers 相同：目前至少有一筆 active 跟單的人數，同一個人只算一次。

import { readMany, type ReadCall, type CallProvider, type ReadableContract } from './multicall'

export interface CopyRecordView {
  trader: string
  active: boolean
}

/** 三個 view 各一次批次讀；結果與輸入一一對應，讀不到的那一格是 null。 */
export interface FollowerReader {
  /** CopyTracker.getFollowerCount：followersByTrader 的長度。 */
  followerCounts(traders: readonly string[]): Promise<Array<bigint | null>>
  /** CopyTracker.followersByTrader(trader, index)。 */
  followersAt(slots: ReadonlyArray<{ trader: string; index: number }>): Promise<Array<string | null>>
  /** CopyTracker.getCopyRecords(follower)。 */
  copyRecords(followers: readonly string[]): Promise<Array<CopyRecordView[] | null>>
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
 * 不論幾位交易者都是三步、每步一批：人數 → 每一格的跟單者 → 每位跟單者的紀錄。
 * 排行榜一次讀幾十位交易者，一筆一筆送會撞上公開 RPC 的每秒上限（sepolia.base.org 每秒 25 筆），
 * 所以每一批交給 readMany 併成 Multicall3（見 multicall.ts）。
 */
export async function readActiveFollowers(
  traders: string[],
  reader: FollowerReader,
): Promise<Map<string, string[] | null>> {
  const counts = await reader.followerCounts(traders)
  // 每位交易者的第 i 位跟單者攤平成一格，所有交易者一起讀。
  const slots = traders.flatMap((trader, t) =>
    Array.from({ length: Number(counts[t] ?? 0n) }, (_, index) => ({ t, trader, index })),
  )
  const addresses = await reader.followersAt(slots)
  const lists: Array<string[] | null> = counts.map((count) => (count === null ? null : []))
  slots.forEach(({ t }, k) => {
    const list = lists[t]
    if (list === null) return
    const address = addresses[k]
    if (address === null) lists[t] = null
    else list.push(address)
  })

  const followers = [...new Map(lists.flatMap((list) => list ?? []).map((f) => [lower(f), f])).values()]
  const records = await reader.copyRecords(followers)
  const recordsOf = new Map<string, CopyRecordView[]>()
  const failed = new Set<string>()
  followers.forEach((follower, i) => {
    const value = records[i]
    if (value === null) failed.add(lower(follower))
    else recordsOf.set(lower(follower), value)
  })

  return new Map(
    traders.map((trader, i) => {
      const list = lists[i]
      if (list === null || list.some((f) => failed.has(lower(f)))) return [lower(trader), null]
      return [lower(trader), activeFollowers(trader, list, recordsOf)]
    }),
  )
}

/** 一批讀取的結果；合約拒絕或節點沒回答都是 null（跟單者清單裡沒有「拒絕」這種答案）。 */
async function readEach<T>(
  provider: CallProvider | null,
  chainId: number | null,
  calls: ReadCall[],
  convert: (value: unknown) => T,
): Promise<Array<T | null>> {
  const outcomes = await readMany(provider, chainId, calls)
  return outcomes.map((o) => (o.status === 'ok' ? convert(o.value) : null))
}

/**
 * 把 useContracts 的 copyTracker 包成 FollowerReader，排行榜與個人頁共用。
 * provider 用來送 Multicall3（錢包的 BrowserProvider）；沒有 Multicall3 的鏈一筆一筆讀。
 */
export const followerReaderOf = (
  copyTracker: ReadableContract,
  provider: CallProvider | null,
  chainId: number | null,
): FollowerReader => ({
  followerCounts: (traders) =>
    readEach(provider, chainId, traders.map((t) => ({ contract: copyTracker, method: 'getFollowerCount', args: [t] })), (v) =>
      BigInt(v as bigint),
    ),
  followersAt: (slots) =>
    readEach(
      provider,
      chainId,
      slots.map((s) => ({ contract: copyTracker, method: 'followersByTrader', args: [s.trader, BigInt(s.index)] })),
      (v) => String(v),
    ),
  copyRecords: (followers) =>
    readEach(provider, chainId, followers.map((f) => ({ contract: copyTracker, method: 'getCopyRecords', args: [f] })), (v) =>
      (v as Array<{ trader: string; active: boolean }>).map((r) => ({ trader: String(r.trader), active: Boolean(r.active) })),
    ),
})
