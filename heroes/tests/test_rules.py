import datetime as dt

import pandas as pd
import pytest

from herolab.assets import ASSETS
from herolab.model import validate
from herolab.rules import RULES

START = dt.date(2024, 10, 1)


def make_prices(days=240, first=dt.date(2024, 4, 1)):
    """每個資產一條固定漂移的價格：sBTC 跌最快，sBOND 持平，sESGU 漲最快。"""
    index = [first + dt.timedelta(days=i) for i in range(days)]
    drift = {a: 0.002 * (i - 5) for i, a in enumerate(ASSETS)}
    return pd.DataFrame({a: [100.0 * (1 + drift[a]) ** t for t in range(days)] for a in ASSETS}, index=index)


PRICES = make_prices()
BASE = {"start": START.isoformat(), "every_days": 14}
MIX = {"weights": {"sBTC": 0.5, "sETH": 0.3, "sGOLD": 0.2}}
CASES = [
    ("buy_hold", MIX),
    ("fixed_mix", MIX),
    ("trend", {"universe": ["sBTC", "sETH", "sGOLD", "sNVDA"], "window": 30}),
    ("momentum", {"top_k": 3, "lookback": 60}),
    ("mean_reversion", {"top_k": 3, "lookback": 60}),
    ("risk_parity", {"universe": ["sGOLD", "sBOND", "sBTC", "sESGU"], "lookback": 30}),
    ("long_short", {"lookback": 60, "long_k": 2, "short_k": 1}),
]


@pytest.mark.parametrize("name, extra", CASES)
def test_every_rule_starts_on_day_one_and_only_emits_publishable_strategies(name, extra):
    rebalances = RULES[name](PRICES, {**BASE, **extra}, 1)
    assert rebalances and rebalances[0].date == START
    assert [r.date for r in rebalances] == sorted({r.date for r in rebalances})
    for r in rebalances:
        validate(r)


@pytest.mark.parametrize("name, extra", CASES)
def test_same_inputs_same_output(name, extra):
    assert RULES[name](PRICES, {**BASE, **extra}, 7) == RULES[name](PRICES, {**BASE, **extra}, 7)


def test_buy_hold_never_rebalances():
    assert len(RULES["buy_hold"](PRICES, {**BASE, **MIX}, 1)) == 1


def test_fixed_mix_rebalances_on_schedule():
    assert len(RULES["fixed_mix"](PRICES, {**BASE, **MIX}, 1)) >= 4  # 57 天 / 14 天


def test_momentum_holds_the_strongest_assets():
    first = RULES["momentum"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)[0]
    assert {leg.asset for leg in first.legs} == {"sESGU", "sICLN", "sGOOGL"}
    assert all(leg.is_long for leg in first.legs)


def test_mean_reversion_holds_the_weakest_assets():
    first = RULES["mean_reversion"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)[0]
    assert {leg.asset for leg in first.legs} == {"sBTC", "sETH", "sAAPL"}


def test_trend_shorts_what_is_below_its_average():
    first = RULES["trend"](PRICES, {**BASE, "universe": ["sBTC", "sETH", "sNVDA", "sESGU"], "window": 30}, 1)[0]
    side = {leg.asset: leg.is_long for leg in first.legs}
    assert side == {"sBTC": False, "sETH": False, "sNVDA": True, "sESGU": True}


def test_long_short_shorts_the_weakest():
    first = RULES["long_short"](PRICES, {**BASE, "lookback": 60, "long_k": 2, "short_k": 1}, 1)[0]
    side = {leg.asset: leg.is_long for leg in first.legs}
    assert side == {"sESGU": True, "sICLN": True, "sBTC": False}


def test_requested_leverage_is_clipped_to_each_assets_carbon_ceiling():
    # 動量前三名是漂移最快的 sGOOGL、sMSFT、sNVDA：Low 的 sNVDA 保留 5 倍，High 的兩檔夾到 1 倍。
    # 名單上沒有 Mid 資產（docs/data/carbon-tier-etf-waci.md），所以不再有 2 倍的例子。
    universe = ["sAAPL", "sNVDA", "sMSFT", "sGOOGL"]
    first = RULES["momentum"](PRICES, {**BASE, "universe": universe, "top_k": 3, "lookback": 60, "leverage": 5}, 1)[0]
    assert {leg.asset: leg.leverage for leg in first.legs} == {"sGOOGL": 1, "sMSFT": 1, "sNVDA": 5}


def test_a_signal_rule_does_not_republish_an_unchanged_strategy():
    # 漂移固定，動量前三名永遠相同：只有第一天發布一次
    assert len(RULES["momentum"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)) == 1


def test_no_rule_picks_assets_by_a_platform_esg_score():
    # #383：平台不再自評 ESG。依平台分數選股的 esg_tilt 拿掉，用它的 ESG Master 也一起拿掉。
    from herolab.roster import TRADERS

    assert "esg_tilt" not in RULES
    assert all(spec.rule in RULES for spec in TRADERS)
    assert "ESG Master" not in {spec.name for spec in TRADERS}
