// 交易者的鏈上欄位（名稱、策略、聲譽、質押），排行榜與個人頁共用。
// 每一批交給 readMany 併成 Multicall3：排行榜幾十位交易者、個人頁幾十版策略，各只要一個請求。

import type { RawAlloc } from './leaderboardMetrics'

import { parseAllocs } from './leaderboardMetrics'
import { readMany, valueOr, type CallProvider, type ReadableContract } from './multicall'

export interface TraderBasics {
  /** 沒註冊或讀不到都是空字串（畫面退回顯示位址）。 */
  displayName: string
  /** 最新一版的配置；還沒有策略、或讀不到，都是空陣列。 */
  allocs: RawAlloc[]
  /** null = 讀不到（或 TraderStake 沒部署），不是 0。 */
  reputation: bigint | null
  stake: bigint | null
  totalSlashed: bigint | null
}

/** 每位交易者四筆：traders、getLatestStrategy、reputationScore、getStake，全部一起送。 */
export async function readTraderBasics(
  addresses: readonly string[],
  contracts: { registry: ReadableContract; traderStake: ReadableContract },
  provider: CallProvider | null,
  chainId: number | null,
): Promise<TraderBasics[]> {
  const { registry, traderStake } = contracts
  const outcomes = await readMany(
    provider,
    chainId,
    addresses.flatMap((a) => [
      { contract: registry, method: 'traders', args: [a] },
      { contract: registry, method: 'getLatestStrategy', args: [a] },
      { contract: traderStake, method: 'reputationScore', args: [a] },
      { contract: traderStake, method: 'getStake', args: [a] },
    ]),
  )
  return addresses.map((_, i) => {
    const [trader, strategy, reputation, stake] = outcomes.slice(i * 4, i * 4 + 4)
    const s = valueOr<{ amount: bigint; totalSlashed: bigint } | null>(stake, null)
    return {
      displayName: String(valueOr<unknown[]>(trader, [false, ''])[1]),
      allocs: parseAllocs(valueOr<unknown[]>(strategy, [[]])[0] as unknown[]),
      reputation: valueOr<bigint | null>(reputation, null),
      stake: s ? s.amount : null,
      totalSlashed: s ? s.totalSlashed : null,
    }
  })
}

export interface StrategyVersion {
  versionId: number
  createdAt: bigint
  allocs: RawAlloc[]
}

/**
 * 第 0 版到第 count − 1 版，舊的在前。任何一版讀不到就回 null：
 * 少一版的歷史會讓人以為策略只改過這幾次。
 */
export async function readStrategyVersions(
  registry: ReadableContract,
  trader: string,
  count: number,
  provider: CallProvider | null,
  chainId: number | null,
): Promise<StrategyVersion[] | null> {
  const outcomes = await readMany(
    provider,
    chainId,
    Array.from({ length: count }, (_, v) => ({ contract: registry, method: 'getStrategyVersion', args: [trader, BigInt(v)] })),
  )
  if (outcomes.some((o) => o.status !== 'ok')) return null
  return outcomes.map((o, versionId) => {
    const [allocs, createdAt] = valueOr<[unknown[], bigint]>(o, [[], 0n])
    return { versionId, createdAt, allocs: parseAllocs(allocs) }
  })
}
