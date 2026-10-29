"""策略規則：純函式 (prices, params, seed) -> 依日期排序的 Rebalance 清單。

prices 的 index 是 datetime.date，要包含 params["start"] 之前足夠的回看期。
"""
from __future__ import annotations

import datetime as dt
import random
from typing import Callable

import pandas as pd

from .assets import ASSETS, max_leverage
from .model import Leg, Rebalance
from .weights import to_bps

Rule = Callable[[pd.DataFrame, dict, int], list[Rebalance]]


def _dates(prices: pd.DataFrame, params: dict, seed: int) -> list[dt.date]:
    """start 當天一定調整一次；之後每 every_days 天一次，起點用種子錯開，
    讓同一條規則的幾位交易者不會全擠在同一天。"""
    start = dt.date.fromisoformat(params["start"])
    days = [d for d in prices.index if d >= start]
    if not days:
        return []
    every = int(params.get("every_days", 0))
    if every <= 0:
        return [days[0]]
    offset = random.Random(seed).randrange(every)
    return [days[0]] + days[1 + offset :: every]


def _legs(weights: dict[str, float], shorts: frozenset[str] = frozenset(), leverage: int = 1) -> tuple[Leg, ...]:
    bps = to_bps(weights)
    return tuple(Leg(a, bps[a], a not in shorts, min(leverage, max_leverage(a))) for a in sorted(bps))


def _history(prices: pd.DataFrame, day: dt.date, lookback: int, universe) -> pd.DataFrame:
    return prices.loc[:day, list(universe)].iloc[-(lookback + 1) :]


def _returns(prices: pd.DataFrame, day: dt.date, lookback: int, universe) -> pd.Series:
    window = _history(prices, day, lookback, universe)
    return window.iloc[-1] / window.iloc[0] - 1.0


def _ranked(scores: pd.Series, k: int, largest: bool) -> list[str]:
    # 同分用名稱排，兩次執行的順序才會一樣
    return sorted(scores.index, key=lambda a: (-scores[a] if largest else scores[a], a))[:k]


def _changed(rebalances: list[Rebalance]) -> list[Rebalance]:
    """訊號沒變就不重新發布：平倉再開一樣的部位只是白付手續費。"""
    kept: list[Rebalance] = []
    for r in rebalances:
        if not kept or kept[-1].legs != r.legs:
            kept.append(r)
    return kept


def buy_hold(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return [Rebalance(d, _legs(params["weights"])) for d in _dates(prices, {**params, "every_days": 0}, seed)]


def fixed_mix(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    # 刻意不去重：定期把漂掉的比例拉回目標，正是這條規則在做的事
    return [Rebalance(d, _legs(params["weights"])) for d in _dates(prices, params, seed)]


def trend(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params["universe"]
    window = int(params.get("window", 50))
    leverage = int(params.get("leverage", 1))
    out = []
    for d in _dates(prices, params, seed):
        h = _history(prices, d, window, universe)
        shorts = frozenset(a for a in universe if h[a].iloc[-1] < h[a].mean())
        out.append(Rebalance(d, _legs({a: 1.0 for a in universe}, shorts, leverage)))
    return _changed(out)


def _pick(prices: pd.DataFrame, params: dict, seed: int, largest: bool) -> list[Rebalance]:
    universe = params.get("universe", ASSETS)
    k = int(params.get("top_k", 3))
    lookback = int(params.get("lookback", 90))
    leverage = int(params.get("leverage", 1))
    out = []
    for d in _dates(prices, params, seed):
        picks = _ranked(_returns(prices, d, lookback, universe), k, largest)
        out.append(Rebalance(d, _legs({a: 1.0 for a in picks}, leverage=leverage)))
    return _changed(out)


def momentum(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return _pick(prices, params, seed, largest=True)


def mean_reversion(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return _pick(prices, params, seed, largest=False)


def risk_parity(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params["universe"]
    lookback = int(params.get("lookback", 60))
    out = []
    for d in _dates(prices, params, seed):
        volatility = _history(prices, d, lookback, universe).pct_change().dropna().std()
        out.append(Rebalance(d, _legs({a: 1.0 / max(float(volatility[a]), 1e-9) for a in universe})))
    return _changed(out)


def long_short(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params.get("universe", ASSETS)
    lookback = int(params.get("lookback", 60))
    long_k = int(params.get("long_k", 2))
    short_k = int(params.get("short_k", 1))
    out = []
    for d in _dates(prices, params, seed):
        scores = _returns(prices, d, lookback, universe)
        longs = _ranked(scores, long_k, largest=True)
        shorts = [a for a in _ranked(scores, short_k, largest=False) if a not in longs]
        out.append(Rebalance(d, _legs({a: 1.0 for a in longs + shorts}, frozenset(shorts))))
    return _changed(out)


RULES: dict[str, Rule] = {
    "buy_hold": buy_hold,
    "fixed_mix": fixed_mix,
    "trend": trend,
    "momentum": momentum,
    "mean_reversion": mean_reversion,
    "risk_parity": risk_parity,
    "long_short": long_short,
}
