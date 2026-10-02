// 價格新鮮度分級。
//
// 在這之前 useLivePrices 讀了 oracle 的 updatedAt 卻只取 [0] 把它丟掉，於是
// 9.5 天前寫入的價格在 UI 上仍然是綠色的「live · on-chain oracle」，使用者按下
// 下單才會吃到合約的 StalePrice revert。分級的門檻直接對齊合約自己的
// maxPriceAge，讓 UI 說的「可交易」和鏈上真正接受的一致。

import { t, interpolate } from 'src/locales'

/** 讀不到 exchange.maxPriceAge() 時的後備值 = Base Sepolia 上實際部署的 6 小時。 */
export const FALLBACK_MAX_PRICE_AGE_SEC = 21600

export type FreshnessLevel = 'live' | 'aging' | 'stale' | 'unknown'

export interface Freshness {
  level: FreshnessLevel
  ageSec: number | null
  label: string
}

function humanize(ageSec: number): string {
  if (ageSec < 90) return interpolate(t.freshness.age.seconds, { n: ageSec })
  if (ageSec < 3600) return interpolate(t.freshness.age.minutes, { n: (ageSec / 60).toFixed(1) })
  if (ageSec < 86400) return interpolate(t.freshness.age.hours, { n: (ageSec / 3600).toFixed(1) })
  return interpolate(t.freshness.age.days, { n: (ageSec / 86400).toFixed(1) })
}

export function classifyFreshness(a: {
  updatedAtSec?: number
  nowSec: number
  maxPriceAgeSec: number
}): Freshness {
  if (!a.updatedAtSec || a.updatedAtSec <= 0) {
    return { level: 'unknown', ageSec: null, label: t.freshness.unknownAge }
  }
  // 節點時間與瀏覽器時間可能有幾秒差距，不讓它變成負數年齡。
  const ageSec = Math.max(0, a.nowSec - a.updatedAtSec)
  const label = humanize(ageSec)

  if (ageSec > a.maxPriceAgeSec) return { level: 'stale', ageSec, label }
  if (ageSec > a.maxPriceAgeSec / 2) return { level: 'aging', ageSec, label }
  return { level: 'live', ageSec, label }
}

/** 合約會拒絕的價格，UI 也不該讓使用者送出交易。 */
export function blocksTrading(f: Freshness): boolean {
  return f.level === 'stale' || f.level === 'unknown'
}

/**
 * 擋單時要對使用者說的那句話。
 *
 * 只把按鈕變灰是最糟的做法——使用者看不出是自己填錯、錢包沒連、還是鏈上價過期，
 * 只會一直重按。這裡把「為什麼」寫出來，並附上價齡。
 * 不需要擋單時回 null，呼叫端就用它決定要不要渲染提示。
 */
export function stalenessNotice(f: Freshness | undefined | null, assetLabel?: string): string | null {
  if (!f || !blocksTrading(f)) return null

  // 帶標的名稱與不帶是四個完整句子，而不是一句話中間插一個「的」——助詞單獨進
  // catalog 沒辦法翻譯，英文得寫成 "of sBTC"，位置也和中文不同。
  const { notice } = t.freshness
  const template = f.level === 'unknown'
    ? (assetLabel ? notice.unknownWithAsset : notice.unknownNoAsset)
    : (assetLabel ? notice.staleWithAsset : notice.staleNoAsset)

  return interpolate(template, { asset: assetLabel ?? '', age: f.label })
}

/**
 * 一次要動到多個標的時（跟單、批次平倉），只要有一個過期整筆就會 revert。
 * 回傳第一個擋單的標的，讓 UI 能指名道姓而不是含糊地說「有東西過期了」。
 */
export function firstBlocking<T extends { label: string; freshness?: Freshness | null }>(
  entries: readonly T[],
): T | null {
  for (const e of entries) {
    if (e.freshness && blocksTrading(e.freshness)) return e
  }
  return null
}

/**
 * 監控頁（AgentMonitorPage）每個資產的「oracle 價格是否過期」。
 *
 * - 平台部署（default 與示範租戶）：照舊問 oracle 的 `isStale()`，讀取失敗當成不過期——
 *   與改版前逐字相同（priceFreshness.test.ts 釘住）。
 * - 專屬租戶：租戶的 GuardedOracle 刻意關掉自己的過期檢查（`maxPriceAge = 0`，理由見
 *   ADR-008），它的 `isStale()` 因此永遠回 false，30 天沒更新的價格也會顯示成新鮮（審查 F6）。
 *   這裡不問它，改用價格的時間戳對照讀取方（租戶 exchange 與金庫）的 6 小時上限；從未寫入
 *   （updatedAt 為 0）也算過期。
 */
export async function oracleRowStale(a: {
  platform: boolean
  updatedAtSec: number
  nowSec: number
  readIsStale: () => Promise<boolean>
  maxPriceAgeSec?: number
}): Promise<boolean> {
  if (a.platform) {
    try {
      return await a.readIsStale()
    } catch {
      return false
    }
  }
  return blocksTrading(
    classifyFreshness({
      updatedAtSec: a.updatedAtSec,
      nowSec: a.nowSec,
      maxPriceAgeSec: a.maxPriceAgeSec ?? FALLBACK_MAX_PRICE_AGE_SEC,
    }),
  )
}
