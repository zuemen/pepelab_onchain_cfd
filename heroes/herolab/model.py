"""策略的資料型別，以及與 StrategyRegistry.publishStrategy 相同的驗證。"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from .assets import ASSETS, max_leverage

MIN_ASSETS = 3
MAX_WEIGHT_BPS = 5_000
WHOLE_BPS = 10_000
ALLOWED_LEVERAGE = (1, 2, 5)


@dataclass(frozen=True)
class Leg:
    asset: str
    weight_bps: int
    is_long: bool
    leverage: int


@dataclass(frozen=True)
class Rebalance:
    """某一天發布的一版策略。交易者當天會平掉全部部位，再照這版開新部位。"""

    date: dt.date
    legs: tuple[Leg, ...]


class InvalidStrategy(ValueError):
    pass


def validate(r: Rebalance) -> None:
    if len(r.legs) < MIN_ASSETS:
        raise InvalidStrategy(f"{r.date}: needs at least 3 assets, got {len(r.legs)}")
    seen: set[str] = set()
    for leg in r.legs:
        if leg.asset not in ASSETS:
            raise InvalidStrategy(f"{r.date}: unknown asset {leg.asset}")
        if leg.asset in seen:
            raise InvalidStrategy(f"{r.date}: duplicate asset {leg.asset}")
        seen.add(leg.asset)
        if leg.weight_bps <= 0:
            raise InvalidStrategy(f"{r.date}: zero weight on {leg.asset}")
        if leg.weight_bps > MAX_WEIGHT_BPS:
            raise InvalidStrategy(f"{r.date}: {leg.asset} weight {leg.weight_bps} exceeds 5000")
        if leg.leverage not in ALLOWED_LEVERAGE:
            raise InvalidStrategy(f"{r.date}: {leg.asset} leverage {leg.leverage} not in (1, 2, 5)")
        if leg.leverage > max_leverage(leg.asset):
            raise InvalidStrategy(
                f"{r.date}: {leg.asset} leverage {leg.leverage} above its carbon ceiling {max_leverage(leg.asset)}"
            )
    total = sum(leg.weight_bps for leg in r.legs)
    if total != WHOLE_BPS:
        raise InvalidStrategy(f"{r.date}: weights must sum to 10000, got {total}")
