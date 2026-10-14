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

export interface Notional {
  long: bigint;
  short: bigint;
}

export interface HedgeOrder {
  /** 先平掉造市帳號在這個資產上的全部部位。 */
  closeExisting: boolean;
  /** 再開一筆 1 倍的反向部位（名目 = 保證金）；null = 不開。 */
  open: { isLong: boolean; margin: bigint } | null;
}

/** 多空名目的失衡在這個比例以內就不調整：每 8 小時的資金費率最多 0.75% × 1% ≈ 0.0075%。 */
export const HEDGE_TOLERANCE_BPS = 100n;

/**
 * 造市帳號怎麼把一個資產的多空名目拉平。
 *
 * 模擬交易者與跟隨者幾乎都做多，沒有對手方時合約的資金費率（失衡越大越高，最高每 8 小時 0.75%）
 * 會吃掉多單、餵飽少數空單，績效就不再反映價格。造市帳號站在淨部位的另一邊，讓資金費率趨近 0。
 *
 * total 是交易所的 globalLong/ShortNotional（含造市帳號），maker 是造市帳號自己的名目。
 */
export function planHedge(total: Notional, maker: Notional): HedgeOrder | null {
  const all = total.long + total.short;
  if (all === 0n) return null;
  const residual = total.long > total.short ? total.long - total.short : total.short - total.long;
  if (residual * BPS <= HEDGE_TOLERANCE_BPS * all) return null;
  const tradersNet = total.long - maker.long - (total.short - maker.short);
  const size = tradersNet > 0n ? tradersNet : -tradersNet;
  return {
    closeExisting: true,
    open: size >= MIN_MARGIN ? { isLong: tradersNet < 0n, margin: size } : null,
  };
}
