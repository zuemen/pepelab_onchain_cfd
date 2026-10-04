// 讀鏈上 exchange 的 per-asset 模式（Active / ReduceOnly / Halted）給市場狀態徽章用。
//
// 線上的舊 exchange 沒有 assetMode（KNOWN_LIMITATIONS #31）。對舊合約呼叫一個不存在的
// selector 會得到空 revert，跟「RPC 壞了」從 ethers 的錯誤上很難分清楚；所以先讀 runtime
// bytecode，看裡面有沒有 assetMode(bytes32) 的 selector（與 /legacy、/exchange 同一個
// scanPush4Selectors）：
//   有   → supported，逐資產讀 assetMode；某一顆讀不到就是 mode = null（不猜 Active）。
//   沒有 → unsupported：休市不會停單，徽章要照實說。
//   bytecode 讀不到、或位址上沒有合約 → unknown：不對停單下任何結論。

import type { AssetModeProbe } from './marketStatus'

import { id } from 'ethers'

import { safeRead } from './safeRead'
import { scanPush4Selectors } from './selectorScan'

/** `assetMode(bytes32)` = 0x6ca3a705（不以 0x00 開頭，PUSH4 掃得到，測試釘住）。 */
export const ASSET_MODE_SELECTOR = id('assetMode(bytes32)').slice(0, 10)

export type ModeSupport = 'supported' | 'unsupported' | 'unknown'

export function modeSupportFromCode(code: string | null | undefined): ModeSupport {
  if (!code || code === '0x') return 'unknown'
  return scanPush4Selectors(code).has(ASSET_MODE_SELECTOR) ? 'supported' : 'unsupported'
}

export interface AssetModeDeps {
  /** exchange 的 runtime bytecode；沒有合約回 null。 */
  getCode: () => Promise<string | null>
  readMode: (assetId: string) => Promise<bigint | number>
  timeoutMs?: number
}

/** 讀不到任何東西時每個資產的狀態。 */
export function unknownModes(assetIds: readonly string[]): Record<string, AssetModeProbe> {
  return Object.fromEntries(assetIds.map((a) => [a, { kind: 'unknown' } as AssetModeProbe]))
}

/**
 * 探測支援度（呼叫端可傳入上一次的結果，bytecode 不會變，不必每輪重讀），再讀每個資產的模式。
 * 永遠不 throw。
 */
export async function loadAssetModes(
  deps: AssetModeDeps,
  assetIds: readonly string[],
  knownSupport?: ModeSupport
): Promise<{ support: ModeSupport; modes: Record<string, AssetModeProbe> }> {
  const ms = deps.timeoutMs ?? 6000
  const support =
    knownSupport && knownSupport !== 'unknown'
      ? knownSupport
      : modeSupportFromCode(await safeRead<string | null>(deps.getCode(), null, ms))

  if (support === 'unknown') return { support, modes: unknownModes(assetIds) }
  if (support === 'unsupported') {
    return {
      support,
      modes: Object.fromEntries(assetIds.map((a) => [a, { kind: 'unsupported' } as AssetModeProbe])),
    }
  }
  const raw = await Promise.all(
    assetIds.map((a) => safeRead<bigint | number | null>(deps.readMode(a), null, ms))
  )
  const modes: Record<string, AssetModeProbe> = {}
  assetIds.forEach((a, i) => {
    const v = raw[i]
    modes[a] = { kind: 'supported', mode: v === null ? null : Number(v) }
  })
  return { support, modes }
}
