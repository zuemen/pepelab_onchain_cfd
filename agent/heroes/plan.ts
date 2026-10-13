// 回放裡不碰鏈的決策：怎麼拆保證金、什麼時候清算。

export interface LegPlan {
  asset: string;
  weightBps: number;
  isLong: boolean;
  leverage: number;
}

export interface OpenOrder extends LegPlan {
  margin: bigint;
}

/** PerpetualExchange.MIN_MARGIN。 */
export const MIN_MARGIN = 10n * 10n ** 18n;

const BPS = 10_000n;

/**
 * 把可用保證金照權重拆給每一檔，並預留開倉手續費。
 *
 * 交易所開倉時扣 margin + margin × leverage × feeBps / 10000。設總保證金為 B，
 * 第 i 檔的保證金是 B × w_i / 10000，所以
 *   B × (1 + Σ w_i × lev_i × fee_i / 1e8) <= free
 * 再留千分之一，吸收逐檔整數除法的捨入。
 */
export function planOpens(free: bigint, legs: LegPlan[], feeBps: Record<string, bigint>): OpenOrder[] {
  if (free <= 0n) return [];
  const scale = BPS * BPS;
  let load = 0n;
  for (const leg of legs) load += BigInt(leg.weightBps) * BigInt(leg.leverage) * feeBps[leg.asset];
  const budget = (((free * scale) / (scale + load)) * 999n) / 1000n;
  return legs
    .map((leg) => ({ ...leg, margin: (budget * BigInt(leg.weightBps)) / BPS }))
    .filter((order) => order.margin >= MIN_MARGIN);
}

/** 與 liquidatePosition 的閘門相同：平倉能拿回的金額 <= 名目 × 維持保證金率。 */
export function shouldLiquidate(value: bigint, margin: bigint, leverage: bigint, maintenanceBps: bigint): boolean {
  return value <= (margin * leverage * maintenanceBps) / BPS;
}
