// 價格新鮮度分級。
//
// 在這之前 useLivePrices 讀了 oracle 的 updatedAt 卻只取 [0] 把它丟掉，於是
// 9.5 天前寫入的價格在 UI 上仍然是綠色的「live · on-chain oracle」，使用者按下
// 下單才會吃到合約的 StalePrice revert。分級的門檻直接對齊合約自己的
// maxPriceAge，讓 UI 說的「可交易」和鏈上真正接受的一致。

export type FreshnessLevel = 'live' | 'aging' | 'stale' | 'unknown'

export interface Freshness {
  level: FreshnessLevel
  ageSec: number | null
  label: string
}

function humanize(ageSec: number): string {
  if (ageSec < 90) return `${ageSec} 秒前`
  if (ageSec < 3600) return `${(ageSec / 60).toFixed(1)} 分鐘前`
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)} 小時前`
  return `${(ageSec / 86400).toFixed(1)} 天前`
}

export function classifyFreshness(a: {
  updatedAtSec?: number
  nowSec: number
  maxPriceAgeSec: number
}): Freshness {
  if (!a.updatedAtSec || a.updatedAtSec <= 0) {
    return { level: 'unknown', ageSec: null, label: '年齡未知' }
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
  const who = assetLabel ? `${assetLabel} 的` : ''
  if (f.level === 'unknown') {
    return `⛔ 無法確認${who}鏈上指數價的更新時間（${f.label}）。在確認之前不送單，避免鏈上以 StalePrice 拒絕後白付 gas。`
  }
  return `⛔ ${who}鏈上指數價已超過合約的 maxPriceAge（最後更新：${f.label}）。此時開倉／平倉都會被 StalePrice revert，請等 keeper 更新後再試。`
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
