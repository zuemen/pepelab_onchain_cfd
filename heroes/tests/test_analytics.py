import datetime as dt
from fractions import Fraction

import pandas as pd
import pytest

from herolab.analytics import (
    build_outputs, build_trades, equity_curve, max_drawdown_pct, monthly_returns, net_pnl, sharpe, window_stats,
)
from herolab.assets import ASSETS

E18 = 10**18
OWNER = "0x00000000000000000000000000000000000000AA"
D0 = 1727816400  # 2024-10-01 21:00 UTC
DAYS = [dt.date(2024, 10, 1) + dt.timedelta(days=i) for i in range(3)]


def wei(x):
    # 用分數算，避免 604.5 × 1e18 在浮點數裡差幾萬 wei
    return str(int(Fraction(str(x)) * E18))


def opened(pid, ts, asset="sETH", is_long=True, margin=500.0, leverage=1, entry=100.0, fee_bps=10, borrow_bps=0,
           owner=OWNER):
    return {"name": "PositionOpened", "block": pid, "logIndex": 0, "timestamp": ts, "tx": f"0xopen{pid}",
            "args": {"positionId": str(pid), "owner": owner, "asset": asset, "isLong": is_long,
                     "entryPrice": wei(entry), "margin": wei(margin), "leverage": str(leverage),
                     "tradingFeeBps": str(fee_bps), "borrowFeeBpsPerHour": str(borrow_bps)}}


def closed(pid, ts, gross, close_amount, owner=OWNER):
    return {"name": "PositionClosed", "block": 1000 + pid, "logIndex": 0, "timestamp": ts, "tx": f"0xclose{pid}",
            "args": {"positionId": str(pid), "owner": owner, "pnl": wei(gross), "closeAmount": wei(close_amount)}}


def prices(eth):
    table = pd.DataFrame({a: [100.0] * len(DAYS) for a in ASSETS}, index=DAYS)
    table["sETH"] = eth
    return table


# 手算案例：本金 1000，第 0 天以 100 開 1 倍多單、保證金 500、手續費 10 bps（0.5）；
# 價格 100 → 110 → 121；第 2 天平倉，價差損益 105，再扣平倉手續費 0.5，取回 604.5。
EVENTS = [opened(1, D0), closed(1, D0 + 2 * 86400, gross=105.0, close_amount=604.5)]
PRICES = prices([100.0, 110.0, 121.0])


def test_trades_pair_an_open_with_its_close_and_ignore_other_owners():
    other = opened(2, D0, owner="0x00000000000000000000000000000000000000BB")
    trades = build_trades(EVENTS + [other], OWNER.lower())
    assert len(trades) == 1
    t = trades[0]
    assert (t.asset, t.margin, t.entry_price, t.open_fee) == ("sETH", 500.0, 100.0, 0.5)
    assert (t.close_amount, t.gross_pnl, t.liquidated) == (604.5, 105.0, False)
    assert net_pnl(t) == pytest.approx(104.0)


def test_equity_marks_open_positions_to_the_days_price_and_books_fees():
    equity = equity_curve(1000.0, build_trades(EVENTS, OWNER), PRICES, DAYS)
    assert list(equity.round(4)) == [999.0, 1049.0, 1104.0]


def test_an_open_position_is_valued_like_get_position_value():
    # 5 倍、價格不動：先扣平倉手續費 500 × 5 × 10 bps = 2.5，
    # 再扣借來的 2000 每小時 1 bps 的借款費：每天 4.8
    events = [opened(1, D0, leverage=5, fee_bps=10, borrow_bps=1)]
    equity = equity_curve(1000.0, build_trades(events, OWNER), prices([100.0] * 3), DAYS)
    assert list(equity.round(4)) == [995.0, 990.2, 985.4]


def test_a_short_gains_when_the_price_falls_and_leverage_multiplies_it():
    events = [opened(1, D0, is_long=False, leverage=2, fee_bps=0)]
    equity = equity_curve(1000.0, build_trades(events, OWNER), prices([100.0, 90.0, 80.0]), DAYS)
    # 第 1 天：500 × (1 + 2 × 0.10) = 600；第 2 天：500 × (1 + 2 × 0.20) = 700
    assert list(equity.round(4)) == [1000.0, 1100.0, 1200.0]


def test_a_position_cannot_be_worth_less_than_nothing():
    events = [opened(1, D0, leverage=5, fee_bps=0)]
    equity = equity_curve(1000.0, build_trades(events, OWNER), prices([100.0, 50.0, 50.0]), DAYS)
    assert equity.iloc[1] == 500.0  # 剩下沒投入的 500；部位歸零而不是 -750


def test_liquidation_is_flagged():
    events = EVENTS + [{"name": "PositionLiquidated", "block": 1001, "logIndex": 1, "timestamp": D0 + 2 * 86400,
                        "tx": "0xclose1", "args": {"positionId": "1", "owner": OWNER}}]
    assert build_trades(events, OWNER)[0].liquidated is True


def test_drawdown_sharpe_and_monthly_returns():
    equity = pd.Series([100.0, 120.0, 90.0, 108.0],
                       index=[dt.date(2024, 10, 30), dt.date(2024, 10, 31), dt.date(2024, 11, 1), dt.date(2024, 11, 2)])
    assert max_drawdown_pct(equity) == pytest.approx(25.0)  # 120 → 90
    assert sharpe(pd.Series([100.0, 100.0, 100.0], index=DAYS)) == 0.0
    assert sharpe(equity) != 0.0
    assert monthly_returns(equity, capital=100.0) == [
        {"month": "2024-10", "returnPct": 20.0}, {"month": "2024-11", "returnPct": -10.0},
    ]


def test_window_counts_only_what_happened_inside_it():
    trades = build_trades(EVENTS, OWNER)
    end = D0 + 3 * 86400
    assert window_stats(trades, end, days=7) == {"pnlUsd": 104.0, "marginUsd": 500.0, "volumeUsd": 500.0, "wins": 1, "trades": 1}
    assert window_stats(trades, end + 30 * 86400, days=7) == {"pnlUsd": 0.0, "marginUsd": 0.0, "volumeUsd": 0.0, "wins": 0, "trades": 0}


def test_outputs_follow_the_published_schema():
    doc = {
        "schemaVersion": 1, "chainId": 31337, "range": {"from": "2024-10-01", "to": "2024-10-03"},
        "traders": [{"index": 10, "name": "Solo", "rule": "buy_hold", "address": OWNER, "capitalUsd": 1000,
                     "finalEquity": wei(1104.0), "followerCount": 0}],
        "events": EVENTS + [{"name": "StrategyPublished", "block": 0, "logIndex": 0, "timestamp": D0, "tx": "0xpub",
                             "args": {"trader": OWNER, "versionId": "0", "legs": [
                                 {"asset": "sETH", "weightBps": 5000, "isLong": True, "leverage": 1},
                                 {"asset": "sBOND", "weightBps": 3000, "isLong": True, "leverage": 1},
                                 {"asset": "sICLN", "weightBps": 2000, "isLong": True, "leverage": 1}]}}],
    }
    index, details = build_outputs(doc, PRICES)
    assert (index["schemaVersion"], index["chainId"], index["range"]) == (1, 31337, doc["range"])
    summary = index["traders"][0]
    assert summary["address"] == OWNER and summary["totalReturnPct"] == 10.4
    assert summary["winRatePct"] == 100.0 and summary["closedTrades"] == 1
    # ESG：(53 × 5000 + 80 × 3000 + 81 × 2000) / 10000 = 66.7 → 67
    assert summary["esgScore"] == 67
    assert summary["sparkline"] == [999.0, 1049.0, 1104.0]
    detail = details[OWNER.lower()]
    assert detail["trades"][0]["pnlUsd"] == 104.0 and detail["trades"][0]["closePrice"] == 121.0
    assert detail["strategies"][0]["tx"] == "0xpub"
    assert detail["exposure"][0] == {"asset": "sETH", "weightPct": 50.0, "isLong": True, "leverage": 1}
    assert [p["equity"] for p in detail["equityCurve"]] == [999.0, 1049.0, 1104.0]
