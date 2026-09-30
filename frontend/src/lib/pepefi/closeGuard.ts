// 平倉前的前端檢查：價格新鮮度 + 標的的 AssetMode。
//
// 兩者在鏈上都會 revert（StalePrice / AssetHalted），前端先擋是為了把「為什麼」
// 講出來，而不是讓使用者簽完名才吃一個看不懂的 revert。
//
// AssetMode（Active / ReduceOnly / Halted）是新版 PerpetualExchange 才有的
// `assetMode(bytes32)`；線上的舊合約沒有這個函式（2026-09-29 以唯讀 eth_call
// 對 0x827eA0c6…124D 核對：missing revert data）。讀不到就是 null，略過這項檢查，
// 交給合約自己把關。ReduceOnly 只擋新曝險、平倉照常，只有 Halted 會擋平倉。

import type { Freshness } from './priceFreshness'

import { Contract, type ContractRunner } from 'ethers'

import { t, interpolate } from 'src/locales'

import { stalenessNotice, classifyFreshness, FALLBACK_MAX_PRICE_AGE_SEC } from './priceFreshness'

export const ASSET_MODE = { Active: 0, ReduceOnly: 1, Halted: 2 } as const

export function closeBlockReason(a: {
  freshness: Freshness | null | undefined
  assetLabel: string
  /** null = 合約沒有 assetMode() 或讀不到，略過。 */
  assetMode: number | null
  /**
   * 這個 asset 是否在 useLivePrices 的輪詢集合裡（ASSET_IDS + PEPE）。預設 true。
   *
   * - 在集合裡：價格還沒讀到（undefined / null）當成 unknown 擋下——輪詢遲早會讀到，
   *   不該讓使用者先簽一筆可能 revert StalePrice 的交易。
   * - 不在集合裡（前端資產表以外的舊部位）：freshness 由呼叫端直接讀 oracle 算；
   *   讀不到就放行，交給合約判斷並把 revert 原因顯示給使用者。否則這種部位會因為
   *   「前端永遠不會輪詢它的價格」而被永久擋下平倉。
   */
  tracked?: boolean
}): string | null {
  if (a.assetMode === ASSET_MODE.Halted) {
    return interpolate(t.portfolio.close.halted, { asset: a.assetLabel })
  }
  if (!a.freshness) {
    if (a.tracked === false) return null
    return stalenessNotice({ level: 'unknown', ageSec: null, label: t.freshness.unknownAge }, a.assetLabel)
  }
  return stalenessNotice(a.freshness, a.assetLabel)
}

/** 這個 asset 是否在 useLivePrices 的輪詢集合裡。 */
export function isPriceTracked(asset: string, tracked: readonly string[]): boolean {
  const a = asset.toLowerCase()
  return tracked.some((id) => id.toLowerCase() === a)
}

/**
 * 不在輪詢集合裡的 asset：直接讀 oracle.getPrice(asset) 的 updatedAt，依 exchange 的
 * maxPriceAge（讀不到用後備值）分級。讀不到價格回 null（= 放行，交給合約）。
 */
export async function readOracleFreshness(
  oracle: Contract | null | undefined,
  exchange: Contract | null | undefined,
  asset: string,
  nowSec: number
): Promise<Freshness | null> {
  if (!oracle) return null
  try {
    const res = (await oracle.getPrice(asset)) as [bigint, bigint]
    let maxAge = FALLBACK_MAX_PRICE_AGE_SEC
    try {
      if (exchange) maxAge = Number(await exchange.maxPriceAge())
    } catch {
      /* 舊合約沒有 maxPriceAge：用後備值 */
    }
    return classifyFreshness({ updatedAtSec: Number(res[1]), nowSec, maxPriceAgeSec: maxAge })
  } catch {
    return null
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

/**
 * 這一列部位要怎麼平倉。
 *
 * - `managed`：屬於一筆**仍 active** 的跟單紀錄——單筆平倉會讓 CopyTracker 的紀錄與
 *   實際部位對不上，要走「取消跟單」一次平掉。不顯示平倉按鈕，原因直接寫在列上。
 * - `leftover`：帶 copiedFrom、但不在任何 active 紀錄裡（紀錄已 inactive、跟單紀錄
 *   讀取失敗、或根本找不到對應紀錄）。這種部位沒有別的出口，一律給平倉按鈕，
 *   並說明「此為先前跟單留下的部位」——寧可多給一個按鈕，也不能讓錢卡住。
 * - `own`：自己開的部位。
 *
 * `activeCopyPositionIds === null` 代表跟單紀錄讀取失敗：不知道哪些是 managed，
 * 就不擋任何一筆。
 */
export type CloseAvailability = 'own' | 'managed' | 'leftover'

export function closeAvailability(
  row: { id: bigint; copiedFrom?: string | null },
  activeCopyPositionIds: ReadonlySet<string> | null
): CloseAvailability {
  const fromCopy = !!row.copiedFrom && row.copiedFrom.toLowerCase() !== ZERO_ADDR
  if (activeCopyPositionIds?.has(String(row.id))) return 'managed'
  return fromCopy ? 'leftover' : 'own'
}

const ASSET_MODE_ABI =['function assetMode(bytes32) view returns (uint8)']

/**
 * 讀 exchange 的 `assetMode(asset)`。舊合約沒有這個函式、或 RPC 失敗，一律回 null
 * （= 略過檢查）。不猜 Active：未知就是未知，交給鏈上判斷。
 */
export async function readAssetMode(
  exchangeAddress: string,
  runner: ContractRunner | null,
  asset: string
): Promise<number | null> {
  if (!runner) return null
  try {
    const mode = await new Contract(exchangeAddress, ASSET_MODE_ABI, runner).assetMode(asset)
    return Number(mode)
  } catch {
    return null
  }
}
