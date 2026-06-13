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
  return {
    asset: symbol,
    assetId,
    price: fmtPrice8(price),
    updatedAt: fmtTime(updatedAt),
    isStale,
    fundingRateBps: Number(fundingBps),
    fundingRatePercent: bpsToPercent(fundingBps),
    fundingDirection: direction,
    longOpenInterest: fmtUsdc18(longOI),
    shortOpenInterest: fmtUsdc18(shortOI),
  };
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
