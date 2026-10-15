import datetime as dt
import json

import pandas as pd

from herolab.assets import ASSETS
from herolab.labdata import BASKETS, STRATEGIES, Lab, combos, param_key, result_name

START = dt.date(2024, 10, 1)
END = dt.date(2024, 12, 31)


def make_prices():
    index = [dt.date(2024, 4, 1) + dt.timedelta(days=i) for i in range((END - dt.date(2024, 4, 1)).days + 1)]
    return pd.DataFrame({a: [100 * (1 + 0.01 * ((t * (k + 3)) % 7 - 3)) ** (t % 5) for t in range(len(index))]
                         for k, a in enumerate(ASSETS)}, index=index)


LAB = Lab(make_prices(), START, END, paths=20)


def test_param_key_matches_javascript_string_of_each_value():
    assert param_key([7, 2]) == "7_2"
    assert param_key([1.5, 5, 10]) == "1.5_5_10"
    assert result_name("dca", "sBTC", [7, 1]) == "dca__sBTC__7_1.json"


def test_every_strategy_has_two_to_four_parameters_with_two_or_three_values():
    for spec in STRATEGIES:
        assert 2 <= len(spec.params) <= 4, spec.id
        for _, values in spec.params:
            assert 2 <= len(values) <= 3
            assert all(isinstance(v, int) or not float(v).is_integer() for v in values)  # 不寫 2.0


def test_every_combination_gets_its_own_file():
    names = [result_name(s.id, t, p.values()) for s, t, p in combos()]
    assert len(names) == len(set(names))
    singles = sum(1 for s, _, _ in combos() if s.kind == "single")
    assert singles % len(ASSETS) == 0 and (len(names) - singles) % len(BASKETS) == 0


def test_result_has_curves_trades_metrics_and_a_90_day_band():
    spec = next(s for s in STRATEGIES if s.id == "dca")
    r = LAB.result(spec, "sETH", {"every_days": 7, "leverage": 2})
    days = (END - START).days + 1
    assert len(r["equity"]) == len(r["benchmark"]) == days
    assert r["effectiveLeverage"] == 2
    assert all(len(t) == len(LAB.index()["tradeFields"]) for t in r["trades"])
    assert set(r["forecast"]["percentiles"]) == {"p5", "p25", "p50", "p75", "p95"}
    assert all(len(v) == 91 for v in r["forecast"]["percentiles"].values())
    assert r["forecast"]["from"] == END.isoformat()


def test_portfolio_results_and_capped_leverage():
    spec = next(s for s in STRATEGIES if s.id == "trend")
    r = LAB.result(spec, "macro", {"window": 50, "every_days": 14, "leverage": 2})
    assert {t[1] for t in r["trades"]} <= set(BASKETS["macro"])
    btc = LAB.result(next(s for s in STRATEGIES if s.id == "dca"), "sBTC", {"every_days": 7, "leverage": 2})
    assert btc["effectiveLeverage"] == 1  # 高碳級上限 1 倍


def test_same_prices_same_bytes():
    spec = next(s for s in STRATEGIES if s.id == "martingale")
    params = {"multiplier": 2, "drop_pct": 5, "take_profit_pct": 5}
    again = Lab(make_prices(), START, END, paths=20)
    assert json.dumps(LAB.result(spec, "sETH", params)) == json.dumps(again.result(spec, "sETH", params))


def test_index_lists_assets_with_their_fee_rules_and_strategies_with_their_rule():
    index = LAB.index()
    assert index["schemaVersion"] == 1 and index["range"] == {"from": "2024-10-01", "to": "2024-12-31"}
    eth = next(a for a in index["assets"] if a["id"] == "sETH")
    assert (eth["feeBps"], eth["borrowBpsPerHour"], eth["maxLeverage"]) == (10, 1, 5)
    rules = {s["id"]: s["rule"] for s in index["strategies"]}
    assert rules["momentum"] == "momentum" and rules["martingale"] is None
