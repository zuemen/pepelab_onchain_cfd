// 清算價估算的單一公式。
//
// 之前 /exchange 的估算含 5.1% 的 buffer（維持保證金 5% + 平倉手續費 0.1%），
// 終端機的下單面板卻只算 `entry ± entry/leverage`。同一個倉位在兩頁看到兩個
// 清算價，而且終端機那個比實際的更「寬鬆」——它會讓使用者以為自己還有空間。
//
// 鏈上的條件（PerpetualExchange.liquidatePosition）是：
//     margin + pnl − tradingFee ≤ notional × maintenanceBps / 10000
// 兩邊同除 notional，並用 margin/notional = 1/leverage：
//     long :  P ≤ P₀ × (1 − 1/L + buffer)
//     short:  P ≥ P₀ × (1 + 1/L − buffer)
// 其中 buffer = (maintenanceBps + tradingFeeBps) / 10000。

/** PerpetualExchange.DEFAULT_MAINTENANCE_MARGIN_BPS = 500（5% of notional）。 */
export const DEFAULT_MAINTENANCE_BPS = 500n

/** PerpetualExchange.TRADING_FEE_BPS = 10（0.1%，平倉時收）。 */
export const DEFAULT_TRADING_FEE_BPS = 10n

export interface LiqParams {
  /** 進場價，18 位小數。 */
  entryPrice: bigint
  isLong: boolean
  leverage: bigint | number
  /** 該資產的維持保證金 bps；不給就用全域預設。 */
  maintenanceBps?: bigint
  tradingFeeBps?: bigint
}

/**
 * 估算清算價（18 位小數）。
 * entryPrice 或 leverage 不合法時回 0n——呼叫端用 `> 0n` 決定要不要顯示，
 * 而不是印出一個看起來很權威的 $0.00。
 */
export function estimateLiquidationPrice(p: LiqParams): bigint {
  const lev = BigInt(p.leverage)
  if (p.entryPrice <= 0n || lev <= 0n) return 0n

  const buffer = (p.maintenanceBps ?? DEFAULT_MAINTENANCE_BPS) + (p.tradingFeeBps ?? DEFAULT_TRADING_FEE_BPS)
  const inverseLev = 10000n / lev

  if (p.isLong) {
    // 1x 多單且 buffer < 100% 時分子會變成負的（10000 − 10000 + 510 > 0，實際不會），
    // 但為了不讓未來改 buffer 時吐出負價，這裡夾在 0。
    const num = 10000n - inverseLev + buffer
    return num <= 0n ? 0n : (p.entryPrice * num) / 10000n
  }
  const num = 10000n + inverseLev - buffer
  return num <= 0n ? 0n : (p.entryPrice * num) / 10000n
}
