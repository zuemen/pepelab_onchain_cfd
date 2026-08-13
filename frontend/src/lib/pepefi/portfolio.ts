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

const PART_KEYS: (keyof NetWorthParts)[] = [
  'walletCash', 'freeMargin', 'lockedMargin', 'unrealisedPnl', 'staked', 'vault',
]

export function netWorthOf(parts: NetWorthParts): NetWorth {
  let total = 0n
  const missing: (keyof NetWorthParts)[] = []

  for (const key of PART_KEYS) {
    const value = parts[key]
    if (value === null) missing.push(key)
    else total += value
  }

  return { total, incomplete: missing.length > 0, missing }
}

// 「投資組合是空的」判斷曾經把「沒讀到」跟「讀到、是 0」混為一談——
// null（未讀）被 `?? 0n` 攤平成 0，於是一個有錢但剛好某項還沒讀完的使用者
// 被判定成空,推去 /exchange。這個函式把六項讀取結果（含成功與否）攤在一起,
// 只有全部讀成功、而且全部真的是 0/空,才算「證實是空的」——任何一項 null
// 都讓答案是 false,不去猜它可能是 0。
export interface PortfolioEmptinessCheck {
  copyRecordsCount: number | null
  positionsCount:   number | null
  freeMargin:       bigint | null
  walletCash:       bigint | null
  staked:           bigint | null
  vault:            bigint | null
}

export function isPortfolioProvablyEmpty(check: PortfolioEmptinessCheck): boolean {
  const { copyRecordsCount, positionsCount, freeMargin, walletCash, staked, vault } = check
  if (
    copyRecordsCount === null || positionsCount === null || freeMargin === null ||
    walletCash === null || staked === null || vault === null
  ) {
    return false
  }
  return (
    copyRecordsCount === 0 && positionsCount === 0 &&
    freeMargin === 0n && walletCash === 0n && staked === 0n && vault === 0n
  )
}
