// 跟單的三個畫面防護（issue #309，參考 eToro CopyTrader）：最低金額、策略已更新、停損提醒。
// 純函式，不含 ethers 或 React。合約不做自動停損；持續跟隨只有跟隨者在鏈上開了自動同步才有
// （ADR-024，見 autoSync.ts），這裡做的都只是
// 「送出前擋下」與「提醒」，畫面上不能把它說成自動執行。

const E18 = 10n ** 18n

/**
 * 跟單金額照比例拆給每一檔，每一檔都要達到交易所的最低保證金，否則整筆 revert。
 * 拆分（含跟單費與手續費）對金額是線性的，所以用試算出來的最小一檔反推：
 * 最低金額 = 試算金額 × 最低保證金 ÷ 最小一檔，再往上取到整數 USDC。
 */
export function minimumCopyAmount(previewAmount: bigint, portions: bigint[], minMargin: bigint): bigint | null {
  if (previewAmount <= 0n || portions.length === 0) return null
  const smallest = portions.reduce((a, b) => (b < a ? b : a))
  if (smallest <= 0n) return null
  const raw = (previewAmount * minMargin + smallest - 1n) / smallest
  return ((raw + E18 - 1n) / E18) * E18
}

export const belowMinimum = (portions: bigint[], minMargin: bigint): boolean =>
  portions.some((portion) => portion < minMargin)

/** 跟單紀錄綁定的版本，比交易者最新發布的那一版舊。strategyCount 是 getStrategyCount 的值。 */
export const isOutdated = (recordVersion: bigint, strategyCount: bigint): boolean =>
  strategyCount > 0n && recordVersion < strategyCount - 1n

/**
 * 「更新到最新版」取消舊跟單、提回取到的錢之後，回到跟單頁的路徑。金額取整數 USDC
 * （往下取，不會超過剛提回錢包的數字）；取整後是 0 就不帶，讓跟單頁用自己的預設值。
 */
export function refreshCopyPath(trader: string, returned: bigint): string {
  const whole = returned / E18
  return whole > 0n ? `/copy/${trader}?amount=${whole}` : `/copy/${trader}`
}

/** 目前價值 ≤ 投入 ×（100 − 停損比例）／100。沒有設定（null）永遠不觸發。 */
export function stopLossReached(initial: bigint, current: bigint, thresholdPct: number | null): boolean {
  if (thresholdPct === null || initial <= 0n) return false
  return current * 100n <= initial * BigInt(100 - Math.round(thresholdPct))
}

export const STOP_LOSS_CHOICES = [20, 30, 40, 50] as const

type StopLossStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): StopLossStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const storageKey = (account: string, index: number) => `pepefi.copyStopLoss.${account.toLowerCase()}.${index}`

/** 只存在這台瀏覽器——這是個人提醒，不是鏈上狀態。讀不到、格式不對都當作沒有設定。 */
export function readStopLoss(account: string, index: number, storage: StopLossStorage | null = browserStorage()): number | null {
  try {
    const raw = storage?.getItem(storageKey(account, index))
    if (!raw) return null
    const value = Number(raw)
    return Number.isInteger(value) && value >= 1 && value <= 95 ? value : null
  } catch {
    return null
  }
}

export function writeStopLoss(
  account: string,
  index: number,
  thresholdPct: number | null,
  storage: StopLossStorage | null = browserStorage(),
): void {
  try {
    if (thresholdPct === null) storage?.removeItem(storageKey(account, index))
    else storage?.setItem(storageKey(account, index), String(thresholdPct))
  } catch {
    // 寫不進去（私密視窗、被封鎖）就只是記不住，不影響跟單本身
  }
}
