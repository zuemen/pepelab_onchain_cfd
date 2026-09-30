// 即時報價的組裝邏輯（純函式，可測）。
//
// 2026-09 P0：這裡以前在讀不到價格時會產生「在基準價附近隨機抖動」的模擬價
// （wiggleMock），連第一次輪詢之前都會先閃一次假價。對一個會自動部署到正式站、
// 讓人下單的前端來說，一個看起來像真的假數字比「沒有數字」危險得多。
//
// 現在的規則只有一條：沒有真來源就沒有數字。usd 為 null，UI 顯示「—」，
// 下單／兌換按鈕依 freshness（unknown ⇒ 擋單）停用並說明原因。

import { t } from 'src/locales'

import { classifyFreshness, type Freshness } from './priceFreshness'

/** 價格從哪裡來。'none' = 兩個來源都讀不到，usd 必為 null。 */
export type PriceSource = 'coingecko' | 'oracle' | 'none'

export interface LivePrice {
  /** 最佳顯示價（優先 CoinGecko，其次鏈上 oracle）。讀不到就是 null，絕不補假值。 */
  usd: number | null
  fetchedAt: number
  source: PriceSource
  /** 鏈上 oracle 價 = 實際的結算／指數價（讀得到才有）。 */
  settlementUsd?: number
  /** 結算價的鏈上 updatedAt（秒）。 */
  settlementUpdatedAt?: number
  /** 以交易所自己的 maxPriceAge 為準的新鮮度分級。沒有鏈上價時為 unknown ⇒ 擋單。 */
  freshness: Freshness
}

/** 沒有鏈上年齡可言（沒有 oracle 價，或這個標的根本不走 oracle）。 */
export function noOracleFreshness(): Freshness {
  return { level: 'unknown', ageSec: null, label: t.freshness.unknownAge }
}

function noPrice(now: number): LivePrice {
  return { usd: null, fetchedAt: now, source: 'none', freshness: noOracleFreshness() }
}

/**
 * 第一次輪詢完成之前的狀態：每個標的都有一筆「無價格」。
 *
 * 刻意每個標的都給一筆而不是回空物件——呼叫端用 `prices[id]?.freshness` 判斷要不要
 * 擋單，缺 key 會得到 undefined，而 stalenessNotice(undefined) 是「不擋」。
 */
export function emptyLivePrices(assetIds: readonly string[], pepeAddr?: string | null, now = Date.now()): Record<string, LivePrice> {
  const out: Record<string, LivePrice> = {}
  for (const id of assetIds) out[id] = noPrice(now)
  if (pepeAddr) out[pepeAddr] = noPrice(now)
  return out
}

export interface BuildLivePricesInput {
  assetIds: readonly string[]
  /** CoinGecko 報價，key = assetId 或 pepeAddr。讀不到就是空物件。 */
  cg: Record<string, number>
  /** 與 assetIds 同序的 oracle.getPrice 結果；null = 讀取失敗／逾時。 */
  oracleRaw: ReadonlyArray<readonly [bigint, bigint] | null>
  maxPriceAgeSec: number
  nowSec: number
  pepeAddr?: string | null
  now?: number
}

export function buildLivePrices(a: BuildLivePricesInput): Record<string, LivePrice> {
  const now = a.now ?? Date.now()
  const out: Record<string, LivePrice> = {}

  for (const [i, id] of a.assetIds.entries()) {
    const raw = a.oracleRaw[i] ?? null
    // oracle 回 0（從未寫入）不是價格。
    const settlement = raw && raw[0] > 0n ? Number(raw[0]) / 1e8 : undefined
    const settlementAt = raw && raw[0] > 0n ? Number(raw[1]) : undefined
    const freshness = classifyFreshness({ updatedAtSec: settlementAt, nowSec: a.nowSec, maxPriceAgeSec: a.maxPriceAgeSec })

    const cgPrice = a.cg[id]
    if (cgPrice !== undefined && Number.isFinite(cgPrice) && cgPrice > 0) {
      out[id] = { usd: cgPrice, fetchedAt: now, source: 'coingecko', settlementUsd: settlement, settlementUpdatedAt: settlementAt, freshness }
    } else if (settlement !== undefined) {
      out[id] = { usd: settlement, fetchedAt: now, source: 'oracle', settlementUsd: settlement, settlementUpdatedAt: settlementAt, freshness }
    } else {
      out[id] = noPrice(now)
    }
  }

  if (a.pepeAddr) {
    const cgPepe = a.cg[a.pepeAddr]
    out[a.pepeAddr] = cgPepe !== undefined && Number.isFinite(cgPepe) && cgPepe > 0
      ? { usd: cgPepe, fetchedAt: now, source: 'coingecko', freshness: noOracleFreshness() }
      : noPrice(now)
  }

  return out
}
