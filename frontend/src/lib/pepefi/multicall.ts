// 合併讀取：一頁要的幾十到幾百筆 view 呼叫，用 Multicall3 的 aggregate3 併成幾筆 eth_call。
//
// 讀鏈的瓶頸是 sepolia.base.org 每個 IP 每秒 25 筆（見 rpcThrottle.ts），而不是單筆有多慢。
// 2026-10-26 在 Base Sepolia 實測排行榜：49 位交易者、79 筆跟單紀錄、60 位跟單者，一筆一筆讀
// 是 386 個請求、26.4 秒；同樣的讀取併進 aggregate3 是 6 個請求、1.9 秒。
//
// 每一筆的結果分三種，呼叫端照這個區分顯示，不能混在一起：
//   ok        讀到了
//   reverted  合約拒絕（例如還沒有策略）——這是答案，不是讀取失敗
//   unread    節點沒回答（限流、逾時、重試用完）——不能說成「沒有資料」

import type { Interface } from 'ethers'

import { AbiCoder } from 'ethers'

import { mapLimit, withRetry, RPC_CONCURRENCY } from './rpcBatch'

/** Multicall3 在各鏈的標準部署位址（同一個 CREATE2 位址）。 */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * 確定有 Multicall3 的鏈。Base Sepolia：2026-10-26 以 eth_getCode 確認有程式碼。
 * 本機 anvil（31337）預設沒有，也沒有限速，一筆一筆讀即可。其他鏈確認過再加進來。
 */
const MULTICALL3_CHAINS = new Set<number>([84532])

/**
 * 一次 aggregate3 帶幾筆。150 是 2026-10-26 實測排行榜時用的值（getCopyRecords 回陣列，
 * 單筆比較重），在 Base Sepolia 公開節點上沒有被拒；往上調之前先重測 eth_call 的 gas 上限。
 */
const CALLS_PER_BATCH = 150

/** 每一次嘗試最久等多久。不回應的節點不會丟錯，只會讓 await 永遠不結束。 */
const ATTEMPT_TIMEOUT_MS = 20_000

const AGGREGATE3 = '0x82ad56cb'

export type ReadOutcome<T = unknown> =
  | { status: 'ok'; value: T }
  | { status: 'reverted' }
  | { status: 'unread' }

/** ethers Contract 用得到的那一小塊；測試可以給假的。 */
export interface ReadableContract {
  target: unknown
  interface: Pick<Interface, 'encodeFunctionData' | 'decodeFunctionResult'>
  getFunction(method: string): (...args: unknown[]) => Promise<unknown>
}

export interface ReadCall {
  contract: ReadableContract
  method: string
  args?: readonly unknown[]
}

/** 送 eth_call 的那一端（BrowserProvider 符合）。 */
export interface CallProvider {
  call(tx: { to: string; data: string }): Promise<string>
}

/** 讀到就給值，沒讀到（不論是 reverted 還是 unread）給 fallback。 */
export function valueOr<T>(outcome: ReadOutcome, fallback: T): T {
  return outcome.status === 'ok' ? (outcome.value as T) : fallback
}

/** 單一回傳值給那一個值，多個給整組——跟直接呼叫 ethers Contract 拿到的一樣。 */
function unwrap(result: ArrayLike<unknown>): unknown {
  return result.length === 1 ? result[0] : result
}

const isRevert = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === 'CALL_EXCEPTION'

// ── aggregate3 的編碼 ────────────────────────────────────────────────────────
// 只有一個函式、形狀固定，用 AbiCoder 手寫比載入一整份 Multicall3 ABI 省。

const CODER = AbiCoder.defaultAbiCoder()

function encodeAggregate3(calls: ReadonlyArray<{ target: string; data: string }>): string {
  const body = CODER.encode(
    ['(address,bool,bytes)[]'],
    [calls.map((c) => [c.target, true, c.data])],
  )
  return AGGREGATE3 + body.slice(2)
}

function decodeAggregate3(data: string): Array<{ success: boolean; returnData: string }> {
  const [results] = CODER.decode(['(bool,bytes)[]'], data)
  return (results as Array<[boolean, string]>).map(([success, returnData]) => ({ success, returnData }))
}

async function viaMulticall(provider: CallProvider, calls: readonly ReadCall[]): Promise<ReadOutcome[]> {
  const batches: ReadCall[][] = []
  for (let i = 0; i < calls.length; i += CALLS_PER_BATCH) batches.push(calls.slice(i, i + CALLS_PER_BATCH))

  const results = await mapLimit(batches, RPC_CONCURRENCY, async (batch): Promise<ReadOutcome[]> => {
    const encoded = batch.map((c) => ({
      target: String(c.contract.target),
      data: c.contract.interface.encodeFunctionData(c.method, c.args ?? []),
    }))
    let raw: Array<{ success: boolean; returnData: string }>
    try {
      raw = decodeAggregate3(
        await withRetry(() => provider.call({ to: MULTICALL3, data: encodeAggregate3(encoded) }), 3, 120, ATTEMPT_TIMEOUT_MS),
      )
    } catch {
      // 整批讀不到：這一批每一筆都是 unread，其他批照常
      return batch.map(() => ({ status: 'unread' }))
    }
    return batch.map((c, i): ReadOutcome => {
      const r = raw[i]
      if (!r?.success) return { status: 'reverted' }
      try {
        return { status: 'ok', value: unwrap(c.contract.interface.decodeFunctionResult(c.method, r.returnData)) }
      } catch {
        // 成功卻解不出來（例如這個位址上沒有合約，回傳是空的）：直接呼叫也會丟錯，當成合約拒絕
        return { status: 'reverted' }
      }
    })
  })
  return results.flat()
}

async function oneByOne(calls: readonly ReadCall[]): Promise<ReadOutcome[]> {
  return mapLimit(calls, RPC_CONCURRENCY, async (c): Promise<ReadOutcome> => {
    try {
      const value = await withRetry(
        async () => {
          try {
            return { value: await c.contract.getFunction(c.method)(...(c.args ?? [])) }
          } catch (err) {
            // 合約拒絕不重試：再問一次答案也一樣
            if (isRevert(err)) return { reverted: true as const }
            throw err
          }
        },
        3,
        120,
        ATTEMPT_TIMEOUT_MS,
      )
      return 'reverted' in value ? { status: 'reverted' } : { status: 'ok', value: value.value }
    } catch {
      return { status: 'unread' }
    }
  })
}

/**
 * 讀一批 view 呼叫，結果與 calls 一一對應。不會丟錯：讀不到的那幾筆是 unread。
 * 有 Multicall3 的鏈併成 aggregate3（每批 CALLS_PER_BATCH 筆，整批重試）；
 * 沒有的鏈，或沒有 provider 時，一筆一筆讀（限制併發並重試）。
 */
export async function readMany(
  provider: CallProvider | null,
  chainId: number | null,
  calls: readonly ReadCall[],
): Promise<ReadOutcome[]> {
  if (calls.length === 0) return []
  if (provider && chainId !== null && MULTICALL3_CHAINS.has(chainId)) return viaMulticall(provider, calls)
  return oneByOne(calls)
}
