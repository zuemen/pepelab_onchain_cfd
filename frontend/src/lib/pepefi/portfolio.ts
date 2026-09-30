// 淨值的單一算法。
//
// 在這個檔案之前，Dashboard 上有兩個都叫「總資產」的數字，各自用不同的公式
// 算在不同的地方：
//
//   「總資產估值」= wallet + staked + totalMargin + freeMargin + vault
//   「總資產現值」= Σ 持倉的 holdingsValue
//
// 兩者差一個字、永遠不相等，使用者無從分辨哪個才是自己的錢。而且第一條
// **漏了未實現損益**——倉位賺了 $500，那個標題數字動都不會動，因為它只加了
// 你投入的保證金（totalMargin），沒有加保證金現在值多少。一個不會隨著損益
// 變動的「總資產」不是保守估計，是錯的。
//
// 淨值 = 各處的現金 + 鎖在倉位裡的保證金 + 那些倉位目前的未實現損益。
// 抽成純函式是為了讓這條公式只有一份、而且能被測試釘住。
//
// 現貨代幣（/tokens 用 USDC 從 AssetVault 鑄出來的 sGOLD、sBOND…）以 oracle 價計入。
// 平台門面是代幣化 RWA 現貨之後，一個只買現貨、沒開永續的人，淨值原本會只剩錢包裡
// 找零的 USDC——少算的正是他主要的資產。

import type { HoldingRow } from './assetClass'

import { holdingValue } from './assetClass'

/**
 * 現貨持倉的市值（18-dec USD）。
 *
 * - `rows === null` 或有任何一檔餘額讀不到（`readFailures > 0`）→ value 為 null：
 *   不知道自己漏了多少，不能端出一個看似篤定的數字。
 * - 讀到餘額、但 oracle 價讀不到（price 0）的那幾檔 → 不計入 value、記在 unpriced，
 *   呼叫端據此標「此總額不完整」。其餘有價格的照常加總。
 */
export interface SpotValue {
  value: bigint | null
  unpriced: number
}

export function spotValueOf(rows: HoldingRow[] | null, readFailures = 0): SpotValue {
  if (rows === null || readFailures > 0) {
    return { value: null, unpriced: rows?.filter((r) => r.price <= 0n).length ?? 0 }
  }
  let value = 0n
  let unpriced = 0
  for (const row of rows) {
    if (row.price <= 0n) unpriced += 1
    else value += holdingValue(row)
  }
  return { value, unpriced }
}

export interface NetWorthParts {
  /** Web3 錢包裡的 USDC。 */
  walletCash:    bigint | null
  /** 合約帳戶裡尚未用掉的保證金。 */
  freeMargin:    bigint | null
  /** 已開倉位鎖住的保證金。 */
  lockedMargin:  bigint | null
  /** 那些倉位目前的未實現損益，可正可負。 */
  unrealisedPnl: bigint | null
  /** 質押在 TraderStake 的資本。 */
  staked:        bigint | null
  /** 投入 LP 保險資金池的資本。 */
  vault:         bigint | null
  /** 現貨代幣以 oracle 價計的市值（spotValueOf 的 value）。 */
  spotHoldings:  bigint | null
  /** 有餘額但讀不到價格的現貨檔數；> 0 時淨值標為不完整。 */
  spotUnpriced?: number
}

export interface NetWorth {
  total: bigint
  /**
   * 有任何一項讀不到（null）。呼叫端要據此把數字標成不完整，而不是把
   * 讀取失敗默默當成 0——那會端出一個看起來很有把握的錯數字。
   * TraderStake 在某些鏈上是 0x0，這是真的會發生的情況。
   */
  incomplete: boolean
  /** 讀不到的欄位名，給 UI 說清楚少了什麼。 */
  missing: (keyof NetWorthParts)[]
}

const PART_KEYS = [
  'walletCash', 'freeMargin', 'lockedMargin', 'unrealisedPnl', 'staked', 'vault', 'spotHoldings',
] as const

export function netWorthOf(parts: NetWorthParts): NetWorth {
  let total = 0n
  const missing: (keyof NetWorthParts)[] = []

  for (const key of PART_KEYS) {
    const value = parts[key]
    if (value === null) missing.push(key)
    else total += value
  }
  // 有價格的現貨已經加進去了；缺價的那幾檔讓總額不完整。
  if (parts.spotHoldings !== null && (parts.spotUnpriced ?? 0) > 0) missing.push('spotHoldings')

  return { total, incomplete: missing.length > 0, missing }
}

// 「投資組合是空的」判斷曾經把「沒讀到」跟「讀到、是 0」混為一談——
// null（未讀）被 `?? 0n` 攤平成 0，於是一個有錢但剛好某項還沒讀完的使用者
// 被判定成空,推去 /exchange。這個函式把六項讀取結果（含成功與否）攤在一起,
// 只有全部讀成功、而且全部真的是 0/空,才算「證實是空的」——任何一項 null
// 都讓答案是 false,不去猜它可能是 0。
export interface PortfolioEmptinessCheck {
  /** 現貨代幣的持有檔數；讀取中或有任何一檔讀不到時為 null。 */
  spotHoldingsCount: number | null
  copyRecordsCount: number | null
  positionsCount:   number | null
  freeMargin:       bigint | null
  walletCash:       bigint | null
  staked:           bigint | null
  vault:            bigint | null
}

export function isPortfolioProvablyEmpty(check: PortfolioEmptinessCheck): boolean {
  const { spotHoldingsCount, copyRecordsCount, positionsCount, freeMargin, walletCash, staked, vault } = check
  if (
    spotHoldingsCount === null ||
    copyRecordsCount === null || positionsCount === null || freeMargin === null ||
    walletCash === null || staked === null || vault === null
  ) {
    return false
  }
  return (
    spotHoldingsCount === 0 &&
    copyRecordsCount === 0 && positionsCount === 0 &&
    freeMargin === 0n && walletCash === 0n && staked === 0n && vault === 0n
  )
}
