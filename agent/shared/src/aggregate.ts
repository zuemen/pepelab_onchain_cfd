// 核心唯讀聚合層：Signal API 與 MCP server 共用，確保兩邊邏輯一致。
import { ethers } from "ethers";
import type { Contracts } from "./provider.ts";
import { assetIdOf, symbolOfAssetId } from "./addresses.ts";
import { fmtUsdc18, fmtPrice8, bpsToPercent, fmtTime } from "./format.ts";

export interface OracleSnapshot {
  asset: string;
  assetId: string;
  price: number; // USD
  updatedAt: string | null;
  isStale: boolean;
  fundingRateBps: number; // 原始 bps（int）
  fundingRatePercent: number; // 每 interval %
  fundingDirection: "longs_pay" | "shorts_pay" | "balanced";
  longOpenInterest: number; // 18-dec notional
  shortOpenInterest: number;
  // ── 決策級欄位（Part A，皆由上面鏈上資料純函式導出，非捏造）──────────────
  /** (longOI − shortOI)/(longOI + shortOI)，−1~1；>0 偏多、<0 偏空。 */
  oiImbalance: number;
  /** OI 失衡推估的 mark/index 偏移 proxy（bps）。**非真實 mark 讀值**——本部署
   *  mark 溢價旗標預設關（mark==index），故以 OI skew 當代理並誠實標示。 */
  skewProxyBps: number;
  /** 維持保證金率（bps，平台 5%）。 */
  maintenanceMarginBps: number;
  /** 以 index price + 維持保證金率估算的清算價（long/short × 1x/3x/5x）。 */
  estLiquidation: EstLiquidation;
  /** 綜合 edge 分數 −100~100（透明規則式）。 */
  edgeScore: number;
  /** edge 拆解：funding 分量。 */
  fundingComponent: number;
  /** edge 拆解：OI 反向（contrarian）分量。 */
  oiComponent: number;
  /** edgeScore ≥ +ENTRY → long；≤ −ENTRY → short；否則 no_trade（stale 一律 no_trade）。 */
  recommendation: "long" | "short" | "no_trade";
  /** |edgeScore|。 */
  confidence: number;
  /** 建議理由（人類可讀）。 */
  reason: string;
}

export interface EstLiquidation {
  long: Record<"1x" | "3x" | "5x", number>;
  short: Record<"1x" | "3x" | "5x", number>;
}

/** edge 政策參數（透明可調；非投資建議）。 */
export const EDGE_DEFAULTS = {
  /** funding bps → 分數的係數（−fundingRateBps×Kf，clamp ±60）。 */
  Kf: 0.8,
  /** 進場門檻：|edgeScore| ≥ ENTRY 才給方向。 */
  entryThreshold: 25,
  /** 維持保證金率 bps（平台 5%）。 */
  maintenanceMarginBps: 500,
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** OI 失衡 (l−s)/(l+s)，−1~1；總額 0 → 0。純函式。 */
export function computeOiImbalance(longOI: number, shortOI: number): number {
  const tot = longOI + shortOI;
  if (tot <= 0) return 0;
  return clamp((longOI - shortOI) / tot, -1, 1);
}

/** 由 index price + 維持保證金率估清算價（long/short × 1x/3x/5x）。純函式。
 *  多單 liq = entry×(1 − 1/lev + mm)；空單 liq = entry×(1 + 1/lev − mm)。 */
export function estLiquidationPrices(price: number, maintenanceMarginBps: number = EDGE_DEFAULTS.maintenanceMarginBps): EstLiquidation {
  const mm = maintenanceMarginBps / 10000;
  const lvls: Array<"1x" | "3x" | "5x"> = ["1x", "3x", "5x"];
  const long = {} as Record<"1x" | "3x" | "5x", number>;
  const short = {} as Record<"1x" | "3x" | "5x", number>;
  for (const k of lvls) {
    const lev = Number(k.replace("x", ""));
    long[k] = round2(price * (1 - 1 / lev + mm));
    short[k] = round2(price * (1 + 1 / lev - mm));
  }
  return { long, short };
}

/** 綜合 edge：funding（負=shorts_pay=偏多→正分）+ OI 反向（人多做反向）。純函式。 */
export function computeEdge(input: {
  fundingRateBps: number;
  oiImbalance: number;
  isStale: boolean;
  Kf?: number;
  entryThreshold?: number;
}): {
  edgeScore: number;
  fundingComponent: number;
  oiComponent: number;
  recommendation: "long" | "short" | "no_trade";
  confidence: number;
  reason: string;
} {
  const Kf = input.Kf ?? EDGE_DEFAULTS.Kf;
  const entry = input.entryThreshold ?? EDGE_DEFAULTS.entryThreshold;
  const fundingComponent = clamp(-input.fundingRateBps * Kf, -60, 60);
  const oiComponent = clamp(-input.oiImbalance * 40, -40, 40);
  const edgeScore = Math.round(clamp(fundingComponent + oiComponent, -100, 100));
  if (input.isStale) {
    return { edgeScore, fundingComponent: round2(fundingComponent), oiComponent: round2(oiComponent),
      recommendation: "no_trade", confidence: Math.abs(edgeScore), reason: "oracle 資料過期（stale），本輪不建議進場" };
  }
  let recommendation: "long" | "short" | "no_trade";
  let reason: string;
  if (edgeScore >= entry) { recommendation = "long"; reason = `edge ${edgeScore} ≥ +${entry}（funding/OI 偏多）→ 做多`; }
  else if (edgeScore <= -entry) { recommendation = "short"; reason = `edge ${edgeScore} ≤ −${entry}（funding/OI 偏空）→ 做空`; }
  else { recommendation = "no_trade"; reason = `|edge| ${Math.abs(edgeScore)} < 門檻 ${entry}，訊號不夠強 → 不進場`; }
  return { edgeScore, fundingComponent: round2(fundingComponent), oiComponent: round2(oiComponent),
    recommendation, confidence: Math.abs(edgeScore), reason };
}

/** 把基礎 oracle 快照（價格/funding/OI/stale）enrich 成決策級資料。純函式、可測。 */
export function enrichOracle(
  base: Pick<OracleSnapshot, "price" | "fundingRateBps" | "longOpenInterest" | "shortOpenInterest" | "isStale">,
  opts: { Kf?: number; entryThreshold?: number; maintenanceMarginBps?: number } = {},
): Omit<OracleSnapshot, keyof OracleSnapshot> & {
  oiImbalance: number; skewProxyBps: number; maintenanceMarginBps: number;
  estLiquidation: EstLiquidation; edgeScore: number; fundingComponent: number;
  oiComponent: number; recommendation: "long" | "short" | "no_trade"; confidence: number; reason: string;
} {
  const mmBps = opts.maintenanceMarginBps ?? EDGE_DEFAULTS.maintenanceMarginBps;
  const oiImbalance = round2(computeOiImbalance(base.longOpenInterest, base.shortOpenInterest));
  // OI skew → mark/index 偏移 proxy：滿失衡(±1) 約 ±50 bps（誠實的粗估，非真 mark）。
  const skewProxyBps = Math.round(oiImbalance * 50);
  const edge = computeEdge({ fundingRateBps: base.fundingRateBps, oiImbalance, isStale: base.isStale, Kf: opts.Kf, entryThreshold: opts.entryThreshold });
  return {
    oiImbalance, skewProxyBps, maintenanceMarginBps: mmBps,
    estLiquidation: estLiquidationPrices(base.price, mmBps),
    ...edge,
  };
}

export interface StrategyLeg {
  asset: string;
  weightPercent: number;
  direction: "long" | "short";
  leverage: number;
}

export interface TraderPerformance {
  trader: string;
  isRegistered: boolean;
  displayName: string;
  registeredAt: string | null;
  isEligible: boolean;
  strategyVersion: number | null;
  strategy: StrategyLeg[];
  positions: {
    total: number;
    open: number;
    closed: number;
    realizedPnL: number; // 已實現（18-dec USDC）
    unrealizedPnL: number; // 未實現
    netPnL: number;
  };
  /** 由策略 + 當前 funding 推導的開倉建議（Phase 1 不真下單，只給訊號）。 */
  suggestion: TradeSuggestion[];
}

export interface TradeSuggestion {
  asset: string;
  direction: "long" | "short";
  leverage: number;
  weightPercent: number;
  fundingRatePercent: number;
  fundingHeadwind: boolean; // true = 與倉位同向需付 funding（逆風）
  note: string;
}

export interface PositionDetail {
  id: number;
  owner: string;
  asset: string;
  isLong: boolean;
  entryPrice: number;
  margin: number;
  leverage: number;
  openedAt: string | null;
  closedAt: string | null;
  isOpen: boolean;
  copiedFrom: string | null;
  realizedPnL: number;
  unrealizedPnL: number;
  pendingFunding: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Oracle 價格 + funding + OI 快照。 */
export async function getOracleSnapshot(
  c: Contracts,
  symbol: string,
): Promise<OracleSnapshot> {
  const assetId = assetIdOf(symbol);
  const [priceRes, isStale, fundingBps, longOI, shortOI] = await Promise.all([
    c.oracle.getPrice(assetId) as Promise<[bigint, bigint]>,
    c.oracle.isStale(assetId) as Promise<boolean>,
    c.perp.getFundingRate(assetId) as Promise<bigint>,
    c.perp.globalLongNotional(assetId) as Promise<bigint>,
    c.perp.globalShortNotional(assetId) as Promise<bigint>,
  ]);
  const [price, updatedAt] = priceRes;
  const direction =
    fundingBps > 0n ? "longs_pay" : fundingBps < 0n ? "shorts_pay" : "balanced";
  const base = {
    asset: symbol,
    assetId,
    price: fmtPrice8(price),
    updatedAt: fmtTime(updatedAt),
    isStale,
    fundingRateBps: Number(fundingBps),
    fundingRatePercent: bpsToPercent(fundingBps),
    fundingDirection: direction as OracleSnapshot["fundingDirection"],
    longOpenInterest: fmtUsdc18(longOI),
    shortOpenInterest: fmtUsdc18(shortOI),
  };
  // 決策級欄位（edge 政策參數可由 env 覆寫）。
  const enriched = enrichOracle(base, {
    Kf: numEnv("X402_EDGE_KF"),
    entryThreshold: numEnv("X402_EDGE_ENTRY"),
  });
  return { ...base, ...enriched };
}

function numEnv(k: string): number | undefined {
  const v = process.env[k]?.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 當前每-interval funding rate（單一資產）。 */
export async function getFundingRate(c: Contracts, symbol: string) {
  const assetId = assetIdOf(symbol);
  const bps = (await c.perp.getFundingRate(assetId)) as bigint;
  return {
    asset: symbol,
    assetId,
    fundingRateBps: Number(bps),
    fundingRatePercent: bpsToPercent(bps),
    direction:
      bps > 0n ? "longs_pay" : bps < 0n ? "shorts_pay" : "balanced",
  };
}

/** 單一倉位詳情（含未實現 PnL 與待結算 funding）。 */
export async function getPositionDetail(
  c: Contracts,
  positionId: number | bigint,
): Promise<PositionDetail> {
  const [pos, unrealized, pending] = await Promise.all([
    c.perp.getPosition(positionId) as Promise<any>,
    c.perp.getUnrealizedPnL(positionId) as Promise<bigint>,
    c.perp.pendingFunding(positionId) as Promise<bigint>,
  ]);
  const copied = String(pos.copiedFrom);
  return {
    id: Number(pos.id),
    owner: String(pos.owner),
    asset: symbolOfAssetId(String(pos.asset)) ?? String(pos.asset),
    isLong: Boolean(pos.isLong),
    entryPrice: fmtUsdc18(pos.entryPrice as bigint),
    margin: fmtUsdc18(pos.margin as bigint),
    leverage: Number(pos.leverage),
    openedAt: fmtTime(pos.openedAt as bigint),
    closedAt: fmtTime(pos.closedAt as bigint),
    isOpen: Boolean(pos.isOpen),
    copiedFrom: copied === ZERO ? null : copied,
    realizedPnL: fmtUsdc18(pos.realizedPnL as bigint),
    unrealizedPnL: fmtUsdc18(unrealized),
    pendingFunding: fmtUsdc18(pending),
  };
}

/** Trader 績效摘要 + 鏈上 PnL 聚合 + 開倉建議。 */
export async function getTraderPerformance(
  c: Contracts,
  trader: string,
): Promise<TraderPerformance> {
  if (!ethers.isAddress(trader)) {
    throw new Error(`不是合法地址：${trader}`);
  }

  const [profile, isEligible, count] = await Promise.all([
    c.registry.traders(trader) as Promise<any>,
    c.registry.isEligibleTrader(trader) as Promise<boolean>,
    c.registry.getStrategyCount(trader) as Promise<bigint>,
  ]);

  const isRegistered = Boolean(profile.isRegistered);

  // 策略（最新版本）
  let strategy: StrategyLeg[] = [];
  let strategyVersion: number | null = null;
  if (Number(count) > 0) {
    const [allocs, versionId] = (await c.registry.getLatestStrategy(
      trader,
    )) as [any[], bigint];
    strategyVersion = Number(versionId);
    strategy = allocs.map((a) => ({
      asset: symbolOfAssetId(String(a.asset)) ?? String(a.asset),
      weightPercent: Number(a.weight) / 100, // weight 是 bps（總和 10000）
      direction: a.isLong ? "long" : "short",
      leverage: Number(a.leverage),
    }));
  }

  // 鏈上 PnL 聚合
  const ids = (await c.perp.getUserPositions(trader)) as bigint[];
  let realized = 0,
    unrealized = 0,
    open = 0,
    closed = 0;
  const details = await Promise.all(
    ids.map((id) => getPositionDetail(c, id)),
  );
  for (const d of details) {
    if (d.isOpen) {
      open++;
      unrealized += d.unrealizedPnL;
    } else {
      closed++;
      realized += d.realizedPnL;
    }
  }

  // 開倉建議：對每個策略腿，讀當前 funding 判斷逆風與否
  const suggestion: TradeSuggestion[] = [];
  for (const leg of strategy) {
    let fundingPct = 0;
    let headwind = false;
    try {
      const fr = await getFundingRate(c, leg.asset);
      fundingPct = fr.fundingRatePercent;
      // longs_pay 且做多 → 逆風；shorts_pay 且做空 → 逆風
      headwind =
        (fr.direction === "longs_pay" && leg.direction === "long") ||
        (fr.direction === "shorts_pay" && leg.direction === "short");
    } catch {
      // 非永續資產或讀取失敗時，funding 視為 0
    }
    suggestion.push({
      asset: leg.asset,
      direction: leg.direction,
      leverage: leg.leverage,
      weightPercent: leg.weightPercent,
      fundingRatePercent: fundingPct,
      fundingHeadwind: headwind,
      note: headwind
        ? `做${leg.direction === "long" ? "多" : "空"}需付 funding（${fundingPct}%/interval），逆風`
        : `funding 順風或中性（${fundingPct}%/interval）`,
    });
  }

  return {
    trader,
    isRegistered,
    displayName: String(profile.displayName ?? ""),
    registeredAt: fmtTime(profile.createdAt as bigint),
    isEligible: Boolean(isEligible),
    strategyVersion,
    strategy,
    positions: {
      total: details.length,
      open,
      closed,
      realizedPnL: realized,
      unrealizedPnL: unrealized,
      netPnL: realized + unrealized,
    },
    suggestion,
  };
}
