// 採用一個配置（Adopt an Allocation）——issue #149 / ADR-007。
//
// 純邏輯，不含 ethers 或 React。已發布的配置來自 StrategyRegistry（版本化、公開、
// 合約層強制分散：≥3 檔、單檔 ≤50%、權重和 = 100%）；這裡回答的是「這個配置能
// 不能用現貨表達」。

import type { AssetSymbol } from 'src/contracts/addresses'

import { ASSET_META } from './assetMeta'
import type { RawAlloc } from './leaderboardMetrics'

const WHOLE_BPS = 10_000

export interface SpotLeg {
  assetId: string
  symbol: AssetSymbol
  weightBps: number
}

/**
 * 不能用現貨表達的理由。`notSpot` = 有做空的成分（做空買不成代幣）；
 * `notTokenized` = 某檔資產在這條鏈上沒有現貨代幣。
 */
export type NotAdoptableReason = 'empty' | 'notSpot' | 'notTokenized' | 'badWeights'

export type SpotAllocation =
  | { ok: true; legs: SpotLeg[] }
  | { ok: false; reason: NotAdoptableReason }

/**
 * 已發布的配置 → 可以用現貨買進的成分。`leverage` 刻意不讀：現貨是用錢買下代幣，
 * 本來就沒有放大倍數這回事——採用者拿到的永遠是 1:1 的持有。
 */
export function toSpotAllocation(
  allocs: RawAlloc[],
  tokens: Partial<Record<AssetSymbol, string>>,
): SpotAllocation {
  if (allocs.length === 0) return { ok: false, reason: 'empty' }
  if (allocs.some((a) => !a.isLong)) return { ok: false, reason: 'notSpot' }

  const legs: SpotLeg[] = []
  for (const a of allocs) {
    const symbol = ASSET_META[a.asset]?.symbol as AssetSymbol | undefined
    if (!symbol || !tokens[symbol]) return { ok: false, reason: 'notTokenized' }
    legs.push({ assetId: a.asset, symbol, weightBps: Number(a.weight) })
  }

  const total = legs.reduce((s, l) => s + l.weightBps, 0)
  if (total !== WHOLE_BPS) return { ok: false, reason: 'badWeights' }

  return { ok: true, legs }
}

export interface PlannedLeg extends SpotLeg {
  /** 這一檔要花的 USDC（18 位小數，跟 MockUSDC 一致）。 */
  usdc: bigint
}

export type AdoptionPlan =
  | { ok: true; legs: PlannedLeg[] }
  | { ok: false; reason: 'tooSmall' }

/**
 * 輸入的總金額照權重拆給每一檔。各檔無條件捨去，捨去的零頭全部給權重最大的那檔
 * （平手取第一個），所以各檔加總永遠等於使用者輸入的金額——一次 approve 的額度
 * 剛好花完，不多不少。任何一檔分到 0 就整筆拒絕：金庫對 0 元的買進會 revert
 * ZeroAmount，與其送出去才失敗，不如在送出前就講清楚金額太小。
 */
export function planAdoption(totalUsdc: bigint, legs: SpotLeg[]): AdoptionPlan {
  if (totalUsdc <= 0n || legs.length === 0) return { ok: false, reason: 'tooSmall' }

  const planned: PlannedLeg[] = legs.map((l) => ({
    ...l,
    usdc: (totalUsdc * BigInt(l.weightBps)) / BigInt(WHOLE_BPS),
  }))
  const spent = planned.reduce((s, l) => s + l.usdc, 0n)
  const heaviest = planned.reduce((best, l, i) => (l.weightBps > planned[best].weightBps ? i : best), 0)
  planned[heaviest] = { ...planned[heaviest], usdc: planned[heaviest].usdc + (totalUsdc - spent) }

  if (planned.some((l) => l.usdc === 0n)) return { ok: false, reason: 'tooSmall' }
  return { ok: true, legs: planned }
}

/**
 * 每一檔在採用流程裡的狀態。`unavailable` = 送出前的檢查就沒過（例如暫停鑄造、
 * 價格過期），`notStarted` = 因為前面某一步失敗而沒有送出。
 */
export type LegStatus = 'waiting' | 'buying' | 'bought' | 'failed' | 'unavailable' | 'notStarted'

export interface LegOutcome extends PlannedLeg {
  status: LegStatus
  txHash?: string
  error?: unknown
}

/**
 * `blocked` = 檢查沒過，一筆交易都沒送；`failed` = 有送但一檔都沒買到；
 * `partial` = 買到了一部分——畫面必須逐檔講清楚，這正是驗收標準要防的情況。
 */
export type AdoptionOutcome = 'complete' | 'partial' | 'failed' | 'blocked'

export interface AdoptionResult {
  outcome: AdoptionOutcome
  legs: LegOutcome[]
  /** 不屬於任何一檔的失敗（目前只有 approve）。 */
  error?: unknown
}

export interface AdoptionDeps {
  /** 送出前檢查這一檔現在買不買得到（previewMint）；throw 代表買不到。 */
  check: (leg: PlannedLeg) => Promise<void>
  /** 一次核准全部金額給金庫，等到上鏈才 resolve。 */
  approve: (totalUsdc: bigint) => Promise<void>
  /** 買進一檔，等到上鏈才 resolve，回傳 tx hash。 */
  mint: (leg: PlannedLeg) => Promise<string>
}

/**
 * 依序執行採用。所有檢查先跑完才送第一筆交易：能在送出前發現的失敗，就不要讓它
 * 變成買了一半。某一檔買進失敗時**停下來**，不繼續買後面的——繼續買只會離發布者的
 * 比例更遠，而且使用者得面對一個更難理解的結果。
 */
export async function runAdoption(
  plan: PlannedLeg[],
  deps: AdoptionDeps,
  onProgress?: (legs: LegOutcome[]) => void,
): Promise<AdoptionResult> {
  const legs: LegOutcome[] = plan.map((l) => ({ ...l, status: 'waiting' }))
  const update = (i: number, patch: Partial<LegOutcome>) => {
    legs[i] = { ...legs[i], ...patch }
    onProgress?.(legs.map((l) => ({ ...l })))
  }
  const finish = (outcome: AdoptionOutcome, error?: unknown): AdoptionResult => {
    legs.forEach((l, i) => {
      if (l.status === 'waiting') legs[i] = { ...l, status: 'notStarted' }
    })
    onProgress?.(legs.map((l) => ({ ...l })))
    return { outcome, legs, ...(error === undefined ? {} : { error }) }
  }

  const checks = await Promise.allSettled(plan.map((l) => deps.check(l)))
  checks.forEach((c, i) => {
    if (c.status === 'rejected') legs[i] = { ...legs[i], status: 'unavailable', error: c.reason }
  })
  if (checks.some((c) => c.status === 'rejected')) return finish('blocked')

  try {
    await deps.approve(plan.reduce((s, l) => s + l.usdc, 0n))
  } catch (e) {
    return finish('failed', e)
  }

  for (let i = 0; i < plan.length; i += 1) {
    update(i, { status: 'buying' })
    try {
      const txHash = await deps.mint(plan[i])
      update(i, { status: 'bought', txHash })
    } catch (e) {
      update(i, { status: 'failed', error: e })
      return finish(i === 0 ? 'failed' : 'partial')
    }
  }
  return finish('complete')
}
