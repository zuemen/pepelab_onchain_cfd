// 「鏈上有沒有這個函式」與「讀到了什麼」分開表示。
//
// 線上的 Base Sepolia 是舊版合約（docs/RELEASE_STATUS.md）：原始碼有、鏈上沒有的 view
// 很常見。對舊合約呼叫不存在的 selector 會得到空 revert，從 ethers 的錯誤上很難和「RPC 壞了」
// 分清楚——所以比照 assetModeProbe.ts，先讀 runtime bytecode 找 selector：
//   unsupported → 畫面寫「此部署沒有這個函式」，**不呼叫**；
//   supported／unknown → 呼叫；失敗就是「讀取失敗」，絕不退回 0 或預設值。
// UUPS proxy 的 selector 在實作合約裡，loadProbeCode 會先讀 EIP-1967 實作槽。

import { id } from 'ethers'

import { withTimeout } from './safeRead'
import { scanPush4Selectors } from './selectorScan'

export type FnSupport = 'supported' | 'unsupported' | 'unknown'

/** 一次讀值的結果。`failed` 與 `unsupported` 是兩件事，畫面的講法也不同。 */
export type Reading<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsupported' }
  | { status: 'failed' }

export const UNSUPPORTED = { status: 'unsupported' } as const
export const FAILED = { status: 'failed' } as const

export const ok = <T,>(value: T): Reading<T> => ({ status: 'ok', value })

export function selectorOf(signature: string): string {
  return id(signature).slice(0, 10)
}

/** bytecode 讀不到（null／'0x'）→ unknown；找得到 selector → supported；否則 unsupported。 */
export function supportFromCode(code: string | null | undefined, signature: string): FnSupport {
  if (!code || code === '0x') return 'unknown'
  return scanPush4Selectors(code).has(selectorOf(signature)) ? 'supported' : 'unsupported'
}

export function supportMap<S extends string>(
  code: string | null | undefined,
  signatures: readonly S[]
): Record<S, FnSupport> {
  if (!code || code === '0x') {
    return Object.fromEntries(signatures.map((s) => [s, 'unknown'])) as Record<S, FnSupport>
  }
  const set = scanPush4Selectors(code)
  return Object.fromEntries(
    signatures.map((s) => [s, set.has(selectorOf(s)) ? 'supported' : 'unsupported'])
  ) as Record<S, FnSupport>
}

/** EIP-1967 implementation slot。 */
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export interface CodeReader {
  getCode: (address: string) => Promise<string>
  getStorage?: (address: string, slot: string) => Promise<string>
}

/**
 * 要拿來掃 selector 的 bytecode：位址是 EIP-1967 proxy 時回實作合約的 bytecode。
 * 任何一步失敗回 null（＝unknown，照常呼叫、失敗就標讀取失敗）。永遠不 throw。
 */
export async function loadProbeCode(reader: CodeReader, address: string, ms = 8000): Promise<string | null> {
  try {
    const code = await withTimeout(reader.getCode(address), ms)
    if (!code || code === '0x') return null
    if (reader.getStorage) {
      const slot = await withTimeout(reader.getStorage(address, EIP1967_IMPL_SLOT), ms).catch(() => null)
      if (slot && /^0x[0-9a-f]+$/i.test(slot) && BigInt(slot) !== 0n) {
        const impl = `0x${slot.slice(-40)}`
        const implCode = await withTimeout(reader.getCode(impl), ms).catch(() => null)
        if (implCode && implCode !== '0x') return implCode
        return null
      }
    }
    return code
  } catch {
    return null
  }
}

/**
 * 依支援度呼叫一個 view。unsupported 不呼叫；其他情況呼叫，逾時或 revert 一律 failed。
 * 永遠不 throw，可以放進 Promise.all。
 */
export async function readGuarded<T>(
  support: FnSupport,
  call: () => Promise<T>,
  ms = 8000
): Promise<Reading<T>> {
  if (support === 'unsupported') return UNSUPPORTED
  try {
    return ok(await withTimeout(call(), ms))
  } catch {
    return FAILED
  }
}

/** 對 Reading 做轉換（ok 才套用）。 */
export function mapReading<T, U>(r: Reading<T>, fn: (v: T) => U): Reading<U> {
  return r.status === 'ok' ? ok(fn(r.value)) : r
}

export function valueOr<T, F>(r: Reading<T>, fallback: F): T | F {
  return r.status === 'ok' ? r.value : fallback
}
