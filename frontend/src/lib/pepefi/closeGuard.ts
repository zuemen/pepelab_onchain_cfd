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

import { stalenessNotice } from './priceFreshness'

export const ASSET_MODE = { Active: 0, ReduceOnly: 1, Halted: 2 } as const

export function closeBlockReason(a: {
  freshness: Freshness | null | undefined
  assetLabel: string
  /** null = 合約沒有 assetMode() 或讀不到，略過。 */
  assetMode: number | null
}): string | null {
  if (a.assetMode === ASSET_MODE.Halted) {
    return interpolate(t.portfolio.close.halted, { asset: a.assetLabel })
  }
  return stalenessNotice(a.freshness, a.assetLabel)
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
