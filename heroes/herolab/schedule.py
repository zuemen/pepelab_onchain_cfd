from __future__ import annotations

import datetime as dt

import pandas as pd

from .assets import ASSETS
from .model import validate
from .roster import follower_actions
from .rules import RULES

SCHEMA_VERSION = 1


def day_timestamp(day: dt.date) -> int:
    """當日 21:00 UTC：美股收盤之後。"""
    return int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=dt.timezone.utc).timestamp())


def _price(prices: pd.DataFrame, day: dt.date, asset: str) -> str:
    return str(round(float(prices.at[day, asset]) * 1e8))  # 預言機用 8 位小數


def build_schedule(prices: pd.DataFrame, traders, start: dt.date, end: dt.date,
                   n_followers: int = 60, follower_seed: int = 7) -> dict:
    days = [d for d in prices.index if start <= d <= end]
    visible = prices.loc[:end]  # 規則看不到 end 之後的價格
    trader_docs = []
    for spec in traders:
        rebalances = RULES[spec.rule](visible, {**spec.params, "start": start.isoformat()}, spec.seed)
        for r in rebalances:
            validate(r)
        trader_docs.append({
            "index": spec.index, "name": spec.name, "rule": spec.rule,
            "capitalUsd": spec.capital_usd, "stakeUsd": spec.stake_usd,
            "rebalances": [{
                "date": r.date.isoformat(),
                "legs": [{"asset": l.asset, "weightBps": l.weight_bps, "isLong": l.is_long, "leverage": l.leverage}
                         for l in r.legs],
            } for r in rebalances],
        })
    by_follower: dict[int, list[dict]] = {}
    for a in sorted(follower_actions(days, list(traders), n_followers, follower_seed), key=lambda a: a.date):
        action = {"date": a.date.isoformat(), "type": a.kind, "traderIndex": a.trader_index}
        if a.kind == "follow":
            action["amountUsd"] = a.amount_usd
        by_follower.setdefault(a.follower_index, []).append(action)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "start": start.isoformat(), "end": end.isoformat(),
        "assets": list(ASSETS),
        "days": [{"date": d.isoformat(), "timestamp": day_timestamp(d),
                  "prices": {a: _price(prices, d, a) for a in ASSETS}} for d in days],
        "traders": trader_docs,
        "followers": [{"index": i, "actions": acts} for i, acts in sorted(by_follower.items())],
    }
