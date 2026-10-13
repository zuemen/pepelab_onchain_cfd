"""鏈上事件 → 每位交易者的績效資料。

一律從事件算，不從排程算：每個數字都要追溯得到一筆鏈上交易。
淨值在部位未平倉期間只反映價格變動；借款費與資金費率在平倉時才實現（併入取回金額）。
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .assets import esg_composite

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
            margin, leverage = _usd(a["margin"]), int(a["leverage"])
            trades[a["positionId"]] = Trade(
                position_id=int(a["positionId"]), asset=a["asset"], is_long=bool(a["isLong"]), leverage=leverage,
                margin=margin, entry_price=_usd(a["entryPrice"]), open_ts=e["timestamp"], open_tx=e["tx"],
                open_fee=margin * leverage * int(a["tradingFeeBps"]) / 10_000,
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


def equity_curve(capital: float, trades: list[Trade], prices: pd.DataFrame, days: list[dt.date]) -> pd.Series:
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
                move = float(prices.at[day, t.asset]) / t.entry_price - 1.0
                marks += max(t.margin * (1.0 + t.leverage * (move if t.is_long else -move)), 0.0)
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
