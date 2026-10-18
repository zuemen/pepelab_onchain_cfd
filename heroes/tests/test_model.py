import datetime as dt

import pytest

from herolab.model import InvalidStrategy, Leg, Rebalance, validate

DAY = dt.date(2024, 10, 1)


def reb(*legs):
    return Rebalance(DAY, tuple(legs))


def test_a_diversified_strategy_passes():
    validate(reb(Leg("sETH", 5000, True, 5), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 2000, False, 2)))


@pytest.mark.parametrize(
    "legs, message",
    [
        ((Leg("sETH", 5000, True, 1), Leg("sBOND", 5000, True, 1)), "at least 3"),
        ((Leg("sETH", 6000, True, 1), Leg("sBOND", 2000, True, 1), Leg("sAAPL", 2000, True, 1)), "exceeds 5000"),
        ((Leg("sETH", 4000, True, 1), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 2000, True, 1)), "sum to 10000"),
        ((Leg("sETH", 4000, True, 1), Leg("sETH", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "duplicate"),
        ((Leg("sETH", 4000, True, 3), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "leverage"),
        # sBTC 是最高碳分級：槓桿上限 1
        ((Leg("sBTC", 4000, True, 2), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "carbon ceiling"),
        ((Leg("sXYZ", 4000, True, 1), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "unknown asset"),
        ((Leg("sETH", 0, True, 1), Leg("sBOND", 5000, True, 1), Leg("sAAPL", 5000, True, 1)), "zero weight"),
    ],
)
def test_what_the_registry_would_reject_is_rejected_here(legs, message):
    with pytest.raises(InvalidStrategy, match=message):
        validate(reb(*legs))
