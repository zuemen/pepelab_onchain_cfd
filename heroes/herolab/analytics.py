"""鏈上事件 → 每位交易者的績效資料。

一律從事件算，不從排程算：每個數字都要追溯得到一筆鏈上交易。
未平倉部位的估值與 PerpetualExchange.getPositionValue 相同：價差損益，扣掉平倉手續費與至今的借款費。
資金費率不估（鏈上的資金費率指數不在事件裡），平倉時才實現、併入取回金額。
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .assets import esg_composite
from .schedule import day_timestamp

E18 = 10**18
DAY = 86_400
SCHEMA_VERSION = 1


@dataclass
class Trade:
    position_id: int
    asset: str
    is_long: bool
    leverage: int
    margin: float
    entry_price: float
    open_ts: int
    open_tx: str
    open_fee: float
    fee_bps: int
    borrow_bps_per_hour: int
    close_ts: int | None = None
    close_tx: str | None = None
    close_amount: float | None = None
    gross_pnl: float | None = None
    liquidated: bool = False


def _usd(wei: str) -> float:
    return int(wei) / E18


def _date(ts: int) -> dt.date:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date()


def build_trades(events: list[dict], owner: str) -> list[Trade]:
    owner = owner.lower()
    trades: dict[str, Trade] = {}
    for e in events:
        a = e["args"]
        if e["name"] == "PositionOpened" and a["owner"].lower() == owner:
            margin, leverage, fee_bps = _usd(a["margin"]), int(a["leverage"]), int(a["tradingFeeBps"])
            trades[a["positionId"]] = Trade(
                position_id=int(a["positionId"]), asset=a["asset"], is_long=bool(a["isLong"]), leverage=leverage,
                margin=margin, entry_price=_usd(a["entryPrice"]), open_ts=e["timestamp"], open_tx=e["tx"],
                open_fee=margin * leverage * fee_bps / 10_000, fee_bps=fee_bps,
                borrow_bps_per_hour=int(a["borrowFeeBpsPerHour"]),
            )
        elif e["name"] == "PositionClosed" and a["positionId"] in trades:
            t = trades[a["positionId"]]
            t.close_ts, t.close_tx = e["timestamp"], e["tx"]
            t.close_amount, t.gross_pnl = _usd(a["closeAmount"]), _usd(a["pnl"])
        elif e["name"] == "PositionLiquidated" and a["positionId"] in trades:
            trades[a["positionId"]].liquidated = True
    return sorted(trades.values(), key=lambda t: t.position_id)


def net_pnl(t: Trade) -> float:
    """實際落袋：平倉取回 − 保證金 − 開倉手續費（平倉手續費、借款費、資金費率已含在取回金額裡）。"""
    return t.close_amount - t.margin - t.open_fee


def open_value(t: Trade, price: float, at_ts: int) -> float:
    """與 getPositionValue 相同：保證金 + 價差損益 − 平倉手續費 − 借款費（只對借來的部分、按整小時計），不低於 0。"""
    move = price / t.entry_price - 1.0
    pnl = t.margin * t.leverage * (move if t.is_long else -move)
    close_fee = t.margin * t.leverage * t.fee_bps / 10_000
    hours = max(at_ts - t.open_ts, 0) // 3600
    borrow_fee = t.margin * (t.leverage - 1) * t.borrow_bps_per_hour * hours / 10_000
    return max(t.margin + pnl - close_fee - borrow_fee, 0.0)


def equity_curve(capital: float, trades: list[Trade], prices: pd.DataFrame, days: list[dt.date]) -> pd.Series:
    """每天以回放當日的區塊時間（21:00 UTC）估值。"""
    values = []
    for day in days:
        cash, marks = capital, 0.0
        for t in trades:
            if _date(t.open_ts) > day:
                continue
            cash -= t.margin + t.open_fee
            if t.close_ts is not None and _date(t.close_ts) <= day:
                cash += t.close_amount
            else:
                marks += open_value(t, float(prices.at[day, t.asset]), day_timestamp(day))
        values.append(cash + marks)
    return pd.Series(values, index=days)


def max_drawdown_pct(equity: pd.Series) -> float:
    peak = equity.cummax()
    return float(((peak - equity) / peak).max() * 100)


def sharpe(equity: pd.Series) -> float:
    """日報酬的平均 / 標準差，以 365 天年化（淨值每個日曆日都有一筆）。"""
    returns = equity.pct_change().dropna()
    deviation = returns.std()
    if len(returns) < 2 or not deviation or math.isnan(deviation):
        return 0.0
    return float(returns.mean() / deviation * math.sqrt(365))


def monthly_returns(equity: pd.Series, capital: float) -> list[dict]:
    out, previous = [], capital
    month_end = equity.groupby([d.strftime("%Y-%m") for d in equity.index]).last()
    for month, value in month_end.items():
        out.append({"month": month, "returnPct": round((value / previous - 1) * 100, 2)})
        previous = value
    return out


def window_stats(trades: list[Trade], end_ts: int, days: int) -> dict:
    since = end_ts - days * DAY
    closed = [t for t in trades if t.close_ts is not None and since < t.close_ts <= end_ts]
    opened = [t for t in trades if since < t.open_ts <= end_ts]
    return {
        "pnlUsd": round(sum(net_pnl(t) for t in closed), 2),
        "marginUsd": round(sum(t.margin for t in opened), 2),
        "volumeUsd": round(sum(t.margin * t.leverage for t in opened), 2),
        "wins": sum(1 for t in closed if net_pnl(t) > 0),
        "trades": len(closed),
    }


# 單日 95% VaR（%）的分級門檻：超過幾道門檻，風險分數就是 1 + 幾。
# 參考 eToro 以 VaR 為基礎的 1–10 風險分數；門檻是我們自訂的，不是 eToro 的公式。
RISK_BANDS = (0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0)


def risk_score(equity: pd.Series) -> int | None:
    """1（很低）到 10（極高），看最近 365 天的日報酬。不到 30 個日報酬不打分。"""
    returns = equity.pct_change().dropna().iloc[-365:]
    if len(returns) < 30:
        return None
    var = max(0.0, -float(returns.quantile(0.05))) * 100
    return 1 + sum(1 for band in RISK_BANDS if var > band)


def worst_loss_pct(equity: pd.Series, days: int) -> float:
    """最差的連續 days 天報酬，以正數表示損失；從沒虧過就是 0。"""
    if len(equity) <= days:
        return 0.0
    change = equity / equity.shift(days) - 1.0
    return round(max(0.0, -float(change.min())) * 100, 2)


def profitable_weeks_pct(equity: pd.Series) -> float | None:
    """每隔 7 天取一點，上漲的週數占比。不到兩週時為 None。"""
    changes = equity.iloc[::7].pct_change().dropna()
    if changes.empty:
        return None
    return round(float((changes > 0).mean()) * 100, 1)


def top_assets(trades: list[Trade], k: int = 3) -> list[dict]:
    counts: dict[str, int] = {}
    for t in trades:
        counts[t.asset] = counts.get(t.asset, 0) + 1
    total = sum(counts.values())
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:k]
    return [{"asset": a, "trades": n, "sharePct": round(n / total * 100, 1)} for a, n in ranked]


def follower_history(events: list[dict], trader: str, months: list[str]) -> list[dict]:
    """每個月底的跟隨中人數：跟隨 +1、取消 −1。來自鏈上的 TraderFollowed／TraderUnfollowed。"""
    trader = trader.lower()
    delta: dict[str, int] = {}
    for e in events:
        if e["name"] in ("TraderFollowed", "TraderUnfollowed") and e["args"]["trader"].lower() == trader:
            month = _date(e["timestamp"]).strftime("%Y-%m")
            delta[month] = delta.get(month, 0) + (1 if e["name"] == "TraderFollowed" else -1)
    out, running = [], 0
    for month in months:
        running += delta.get(month, 0)
        out.append({"month": month, "followers": running})
    return out


def _esg_score(legs: list[dict]) -> int | None:
    total = sum(l["weightBps"] for l in legs)
    if total == 0:
        return None
    # 與前端 MarketplacePage.getEsgComposite 相同：Math.round(加權平均)
    return int(sum(esg_composite(l["asset"]) * l["weightBps"] for l in legs) / total + 0.5)


def _correlation(equity: pd.Series, benchmark: pd.Series) -> float | None:
    value = equity.pct_change().corr(benchmark.pct_change())
    return None if value is None or math.isnan(value) else round(float(value), 3)


def _sparkline(equity: pd.Series, points: int = 60) -> list[float]:
    picks = np.linspace(0, len(equity) - 1, min(points, len(equity))).round().astype(int)
    return [round(float(equity.iloc[i]), 2) for i in picks]


def build_outputs(doc: dict, prices: pd.DataFrame) -> tuple[dict, dict[str, dict]]:
    start, end = (dt.date.fromisoformat(doc["range"][k]) for k in ("from", "to"))
    days = [d for d in prices.index if start <= d <= end]
    months = sorted({d.strftime("%Y-%m") for d in days})
    end_ts = int(dt.datetime(end.year, end.month, end.day, tzinfo=dt.timezone.utc).timestamp()) + DAY
    summaries, details = [], {}
    for trader in doc["traders"]:
        address, capital = trader["address"], float(trader["capitalUsd"])
        trades = build_trades(doc["events"], address)
        closed = [t for t in trades if t.close_ts is not None]
        equity = equity_curve(capital, trades, prices, days)
        strategies = [
            {"date": _date(e["timestamp"]).isoformat(), "versionId": int(e["args"]["versionId"]),
             "tx": e["tx"], "legs": e["args"]["legs"]}
            for e in doc["events"]
            if e["name"] == "StrategyPublished" and e["args"]["trader"].lower() == address.lower()
        ]
        latest = strategies[-1]["legs"] if strategies else []
        summary = {
            "address": address, "name": trader["name"], "rule": trader["rule"],
            "totalReturnPct": round((float(equity.iloc[-1]) / capital - 1) * 100, 2),
            "maxDrawdownPct": round(max_drawdown_pct(equity), 2),
            "sharpe": round(sharpe(equity), 2),
            "winRatePct": round(sum(1 for t in closed if net_pnl(t) > 0) / len(closed) * 100, 1) if closed else None,
            "closedTrades": len(closed),
            "esgScore": _esg_score(latest),
            "window7d": window_stats(trades, end_ts, 7),
            "window30d": window_stats(trades, end_ts, 30),
            "sparkline": _sparkline(equity),
        }
        summaries.append(summary)
        details[address.lower()] = {
            **summary,
            "equityCurve": [{"date": d.isoformat(), "equity": round(float(v), 2)} for d, v in equity.items()],
            "monthlyReturns": monthly_returns(equity, capital),
            "exposure": [{"asset": l["asset"], "weightPct": l["weightBps"] / 100, "isLong": l["isLong"],
                          "leverage": l["leverage"]} for l in latest],
            "esgCorrelation": _correlation(equity, prices.loc[days, "sESGU"]),
            "avgHoldDays": round(sum(t.close_ts - t.open_ts for t in closed) / len(closed) / DAY, 1) if closed else None,
            "riskScore": risk_score(equity),
            "worstDayLossPct": worst_loss_pct(equity, 1),
            "worstWeekLossPct": worst_loss_pct(equity, 7),
            "maxDrawdown1yPct": round(max_drawdown_pct(equity.iloc[-365:]), 2),
            "profitableWeeksPct": profitable_weeks_pct(equity),
            "tradesPerWeek": round(len(trades) / max(len(days) / 7, 1), 2),
            "topAssets": top_assets(trades),
            "followerHistory": follower_history(doc["events"], address, months),
            "activeSince": strategies[0]["date"] if strategies else None,
            "strategies": strategies,
            "trades": [{
                "positionId": t.position_id, "asset": t.asset, "isLong": t.is_long, "leverage": t.leverage,
                "marginUsd": round(t.margin, 2),
                "openTx": t.open_tx, "openTime": t.open_ts, "openPrice": round(t.entry_price, 4),
                "closeTx": t.close_tx, "closeTime": t.close_ts,
                "closePrice": round(float(prices.at[_date(t.close_ts), t.asset]), 4) if t.close_ts else None,
                "pnlUsd": round(net_pnl(t), 2) if t.close_ts else None,
                "grossPnlUsd": round(t.gross_pnl, 2) if t.close_ts else None,
                "liquidated": t.liquidated,
            } for t in trades],
        }
    index = {"schemaVersion": SCHEMA_VERSION, "chainId": doc["chainId"], "range": doc["range"], "traders": summaries}
    return index, details
