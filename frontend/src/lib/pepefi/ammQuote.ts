// PepeAMM 報價的前端輔助計算。
//
// 背景：PepeAMM 這一輪從「oracle × 數量」的零滑點兌換，改寫成真正的恆定乘積
// (x*y=k) 池。`quoteETHForUSDC` / `quoteUSDCForETH` 的 selector 沒變，但回傳的
// 意義變了——同樣輸入 1 ETH 和 100 ETH，單價不再一樣。
//
// 前端因此需要兩件舊版不需要的東西：
//  1. **價格衝擊**：告訴使用者這筆金額相對池內中價差多少，大額換匯時滑點可以
//     遠超過 UI 上寫的「0.5%」。
//  2. **minOut 必須以 quote 為基準**（而不是 oracle 價再打折）。quote 已經含了
//     滑點與手續費，slippage buffer 的用途只剩「送出到上鏈之間池子被別人動過」。
//
// 兩個函式都是純函式，方便單測。

/** 前端預設的滑點容忍度（bps）。只用來吸收送出→上鏈之間的池子變動。 */
export const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

/** 超過這個價格衝擊就把提示轉成警告色。 */
export const HIGH_IMPACT_BPS = 100 // 1%

/** 超過這個價格衝擊就是「你確定嗎」等級——大額吃掉整個池子的深度。 */
export const SEVERE_IMPACT_BPS = 500 // 5%

export interface ImpactParams {
  /** 輸入數量（18 dec）。 */
  amountIn: bigint
  /** 合約 quote 出來的輸出數量（18 dec）。 */
  amountOut: bigint
  /** 輸入側的池子儲備。 */
  reserveIn: bigint
  /** 輸出側的池子儲備。 */
  reserveOut: bigint
}

/**
 * 相對池內中價（reserveOut / reserveIn）的價格衝擊，單位 bps。
 *
 * 這個數字含手續費（quote 已扣），所以即使極小額也不會是 0——那是對的，
 * 使用者付的就是「手續費 + 滑點」的總和。
 *
 * 回傳 `null` 代表無法計算（缺儲備或缺報價），呼叫端應該不顯示，而不是顯示 0。
 */
export function priceImpactBps({ amountIn, amountOut, reserveIn, reserveOut }: ImpactParams): number | null {
  if (amountIn <= 0n || amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null

  // impact = 1 - (out/in) / (reserveOut/reserveIn) = 1 - out*reserveIn / (in*reserveOut)
  const numerator   = amountOut * reserveIn * 10_000n
  const denominator = amountIn * reserveOut
  const ratioBps    = numerator / denominator
  const impact      = 10_000n - ratioBps
  // 報價優於中價（理論上不會，除非四捨五入）→ 當成 0，不要顯示負滑點。
  if (impact <= 0n) return 0
  return Number(impact)
}

/**
 * 以 **quote** 為基準套用滑點容忍度，算出送進合約的 minOut。
 *
 * 舊版註解寫「0.5% slippage buffer off the oracle quote」——在恆定乘積池裡，
 * 拿 oracle 價打 0.5% 當 minOut 會讓任何稍大的單子必定 revert
 * InsufficientOutput（實際滑點遠超過 0.5%）。基準必須是 quote 本身。
 */
export function minOutWithSlippage(quoted: bigint, slippageBps: number = DEFAULT_SLIPPAGE_BPS): bigint {
  if (quoted <= 0n) return 0n
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(slippageBps))))
  return (quoted * (10_000n - bps)) / 10_000n
}

/**
 * oracle 報價是否已經過期到會讓 swap revert `StaleOraclePrice`。
 *
 * `maxOracleAge` 為 0 表示還沒讀到（不是「零容忍」），這時不要擋——擋了會在
 * RPC 抖動時把整個兌換卡片鎖死。
 */
export function isOracleStale(updatedAt: bigint, maxAge: bigint, nowSeconds: number): boolean {
  if (maxAge <= 0n || updatedAt <= 0n) return false
  return BigInt(Math.floor(nowSeconds)) - updatedAt > maxAge
}
