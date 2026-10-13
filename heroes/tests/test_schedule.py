import datetime as dt

import pandas as pd

from herolab.assets import ASSETS
from herolab.roster import TRADERS, follower_actions
from herolab.schedule import build_schedule, day_timestamp

FIRST = dt.date(2024, 4, 1)
START, END = dt.date(2024, 10, 1), dt.date(2024, 10, 30)


def make_prices(days=240):
    index = [FIRST + dt.timedelta(days=i) for i in range(days)]
    drift = {a: 0.002 * (i - 5) for i, a in enumerate(ASSETS)}
    return pd.DataFrame({a: [100.0 * (1 + drift[a]) ** t for t in range(days)] for a in ASSETS}, index=index)


PRICES = make_prices()


def test_roster_has_24_traders_on_distinct_wallet_indices():
    assert len(TRADERS) == 24
    assert sorted(t.index for t in TRADERS) == list(range(10, 34))
    assert len({t.name for t in TRADERS}) == 24


def test_day_timestamp_is_2100_utc():
    assert day_timestamp(dt.date(2024, 10, 1)) == 1727816400


def test_schedule_has_one_day_per_calendar_day_with_integer_prices():
    doc = build_schedule(PRICES, TRADERS[:3], START, END, n_followers=4)
    assert [d["date"] for d in doc["days"]][:2] == ["2024-10-01", "2024-10-02"]
    assert len(doc["days"]) == 30
    assert doc["days"][0]["timestamp"] == 1727816400
    price = doc["days"][0]["prices"]["sBOND"]
    assert isinstance(price, str) and int(price) == round(float(PRICES.at[START, "sBOND"]) * 1e8)


def test_every_trader_opens_on_the_first_day():
    doc = build_schedule(PRICES, TRADERS, START, END, n_followers=0)
    assert len(doc["traders"]) == 24
    for trader in doc["traders"]:
        assert trader["rebalances"][0]["date"] == "2024-10-01"
        assert all(START.isoformat() <= r["date"] <= END.isoformat() for r in trader["rebalances"])


def test_followers_follow_before_they_unfollow_and_only_once_per_trader():
    days = [START + dt.timedelta(days=i) for i in range(30)]
    actions = follower_actions(days, TRADERS, n_followers=20, seed=7)
    assert actions
    seen = {}
    for a in sorted(actions, key=lambda a: (a.date, a.kind != "follow")):
        key = (a.follower_index, a.trader_index)
        if a.kind == "follow":
            assert key not in seen and a.date > days[0] and a.amount_usd >= 500
            seen[key] = a.date
        else:
            assert key in seen and a.date > seen[key]


def test_same_inputs_same_schedule():
    assert build_schedule(PRICES, TRADERS[:3], START, END, 4) == build_schedule(PRICES, TRADERS[:3], START, END, 4)
