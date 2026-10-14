import datetime as dt

import pytest

from herolab.assets import ASSETS
from herolab.prices import load_prices, parse_yahoo_chart


def test_parse_yahoo_chart_drops_null_closes():
    payload = {"chart": {"result": [{
        # 2024-10-01、10-02、10-03 的 13:30 UTC
        "timestamp": [1727789400, 1727875800, 1727962200],
        "indicators": {"quote": [{"close": [226.21, None, 225.67]}]},
    }]}}
    series = parse_yahoo_chart(payload)
    assert list(series.index) == [dt.date(2024, 10, 1), dt.date(2024, 10, 3)]
    assert series.iloc[0] == 226.21


def _write_all(tmp_path, rows):
    for asset in ASSETS:
        lines = ["date,close"] + [f"{d},{c}" for d, c in rows]
        (tmp_path / f"{asset}.csv").write_text("\n".join(lines) + "\n")


def test_load_prices_carries_last_close_over_gaps(tmp_path):
    # 10-04 是週五、10-07 是週一：週末沿用週五的收盤價
    _write_all(tmp_path, [("2024-10-03", 10.0), ("2024-10-04", 11.0), ("2024-10-07", 12.0)])
    table = load_prices(tmp_path, dt.date(2024, 10, 4), dt.date(2024, 10, 7))
    assert list(table.index) == [dt.date(2024, 10, d) for d in (4, 5, 6, 7)]
    assert list(table["sBTC"]) == [11.0, 11.0, 11.0, 12.0]
    assert list(table.columns) == list(ASSETS)


def test_load_prices_uses_a_close_from_before_the_start(tmp_path):
    _write_all(tmp_path, [("2024-10-03", 10.0), ("2024-10-07", 12.0)])
    table = load_prices(tmp_path, dt.date(2024, 10, 5), dt.date(2024, 10, 6))
    assert list(table["sETH"]) == [10.0, 10.0]


def test_load_prices_refuses_a_start_with_no_price(tmp_path):
    _write_all(tmp_path, [("2024-10-07", 12.0)])
    with pytest.raises(ValueError, match="no price on or before"):
        load_prices(tmp_path, dt.date(2024, 10, 1), dt.date(2024, 10, 7))
