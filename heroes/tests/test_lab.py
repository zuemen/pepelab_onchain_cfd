import datetime as dt

import pandas as pd
import pytest

from herolab.lab import (
    backtest_hold, backtest_portfolio, backtest_single, metrics, plan_opens, rebalancer, run,
)
from herolab.model import Leg, Rebalance

# sETH 是低碳級：手續費 10 bps、借款費每小時 1 bps、槓桿上限 5。
# sBTC 是高碳級：手續費 100 bps、借款費每小時 10 bps、槓桿上限 1。


def opens(bt):
    return [f for f in bt.fills if f.action == "open"]


def closes(bt):
    return [f for f in bt.fills if f.action == "close"]


# ── 定期定額 ──────────────────────────────────────────────────────────────────


def test_dca_buys_on_schedule_and_splits_the_capital_evenly():
    # 10 天、每 5 天一次 → 第 0、5 天各買一次，每次 500（保證金 + 手續費）
    bt = backtest_single("dca", "sETH", {"every_days": 5, "leverage": 1}, [100.0] * 10, 1000.0)
    assert [f.day for f in opens(bt)] == [0, 5]
    for f in opens(bt):
        assert f.margin * 1.001 == pytest.approx(500.0)
    # 價格不動：只剩兩筆各自的平倉手續費沒付，期末淨值 = 1000 − 兩次開倉費 − 兩次平倉費
    margin = 500 / 1.001
    assert bt.equity[-1] == pytest.approx(1000 - 4 * margin * 0.001)


def test_dca_with_leverage_pays_the_hourly_borrow_fee_on_the_borrowed_half():
    bt = backtest_single("dca", "sETH", {"every_days": 100, "leverage": 2}, [100.0] * 3, 1000.0)
    margin = 1000 / (1 + 2 * 0.001)
    # 借來的部分 = 保證金 × (2 − 1)，每小時 1 bps，一天 24 小時
    assert bt.equity[0] - bt.equity[1] == pytest.approx(margin * 24 / 10_000)
    assert bt.equity[1] - bt.equity[2] == pytest.approx(margin * 24 / 10_000)


def test_leverage_above_the_carbon_ceiling_is_capped():
    bt = backtest_single("dca", "sBTC", {"every_days": 100, "leverage": 2}, [100.0] * 3, 1000.0)
    assert opens(bt)[0].margin == pytest.approx(1000 / 1.01)  # 1 倍、手續費 1%
    assert bt.equity[1] == bt.equity[2]  # 沒有借款費


# ── 馬丁加倉 ──────────────────────────────────────────────────────────────────

MARTINGALE = {"multiplier": 2, "drop_pct": 10, "take_profit_pct": 5}


def test_martingale_adds_after_each_drop_with_the_multiplier_then_takes_profit_and_resets():
    # 第 0 天買 200（本金 2%）；89 比 100 跌超過 10% → 加 400；80 比 89 跌超過 10% → 加 800；
    # 92 時這一輪價值約 1514.6 ≥ 投入 1400 × 1.05 → 全部平倉；隔天重新以 200 開始。
    prices = [100.0, 95.0, 89.0, 80.0, 92.0, 92.0]
    bt = backtest_single("martingale", "sETH", MARTINGALE, prices, 10_000.0)
    assert [(f.day, round(f.margin * 1.001, 6)) for f in opens(bt)] == [(0, 200), (2, 400), (3, 800), (5, 200)]
    assert [f.day for f in closes(bt)] == [4, 4, 4]
    # 第一筆（100 買、92 賣）單獨看是虧的，整輪是賺的
    assert sum(f.pnl for f in closes(bt)) > 0


def test_martingale_does_not_take_profit_below_the_target():
    # 92 → 平均成本附近，94 也還不到 5%
    prices = [100.0, 89.0, 92.0, 94.0]
    bt = backtest_single("martingale", "sETH", MARTINGALE, prices, 10_000.0)
    assert closes(bt) == []


def test_martingale_stops_adding_when_the_next_order_does_not_fit():
    # 本金 1000：20、40、80、160、320 合計 620；下一筆 640 > 剩下的 380，不再加倉
    prices = [100.0 * 0.85**i for i in range(10)]
    bt = backtest_single("martingale", "sETH", MARTINGALE, prices, 1000.0)
    assert [round(f.margin * 1.001, 6) for f in opens(bt)] == [20, 40, 80, 160, 320]


# ── 網格 ─────────────────────────────────────────────────────────────────────

GRID = {"spacing_pct": 10, "levels": 2}


def test_grid_buys_a_level_when_touched_never_twice_and_sells_one_level_up():
    # 基準 100，兩格在 90、81；每格 500
    prices = [100.0, 89.0, 85.0, 80.0, 91.0, 99.0, 101.0]
    bt = backtest_single("grid", "sETH", GRID, prices, 1000.0)
    assert [(f.day, f.price) for f in opens(bt)] == [(1, 89.0), (3, 80.0)]  # 第 2 天 85 不重複買第一格
    assert [(f.day, f.price) for f in closes(bt)] == [(4, 91.0), (6, 101.0)]  # 第二格回到 90 賣、第一格回到 100 賣
    for f in opens(bt):
        assert f.margin * 1.001 == pytest.approx(500.0)


def test_grid_moves_its_anchor_up_when_empty_and_the_price_runs_away():
    # 111 ≥ 100 × 1.1 → 基準移到 111，第一格變 99.9；99 就會買
    bt = backtest_single("grid", "sETH", GRID, [100.0, 111.0, 105.0, 99.0], 1000.0)
    assert [(f.day, f.price) for f in opens(bt)] == [(3, 99.0)]


# ── 手續費、清算、可重現 ──────────────────────────────────────────────────────


def test_a_round_trip_pays_the_tier_fee_twice():
    # 高碳級 1%：花 1000 → 保證金 990.10；平倉再付 1%。淨損益 = −2 × 9.90
    bt = backtest_single("grid", "sBTC", {"spacing_pct": 10, "levels": 1}, [100.0, 90.0, 100.0], 1000.0)
    (close,) = closes(bt)
    margin = 1000 / 1.01
    assert close.pnl == pytest.approx(margin * (100 / 90 - 1) - 2 * margin * 0.01)


def test_a_leveraged_position_is_liquidated_and_only_three_quarters_of_what_is_left_comes_back():
    # 5 倍做多，價格跌 18%：價值 = m × (1 − 0.9) − 平倉費 m × 0.005 − 一天的借款費，低於名目 × 5%
    bt = backtest_single("dca", "sETH", {"every_days": 100, "leverage": 5}, [100.0, 82.0, 82.0], 1000.0)
    (liquidated,) = [f for f in bt.fills if f.action == "liquidated"]
    margin = 1000 / 1.005
    value = margin * (1 - 5 * 0.18) - margin * 5 * 0.001 - margin * 4 * 24 / 10_000
    assert liquidated.day == 1
    assert bt.equity[1] == pytest.approx(value * 0.75)
    assert bt.equity[2] == bt.equity[1]


@pytest.mark.parametrize("strategy, params", [
    ("dca", {"every_days": 7, "leverage": 2}), ("martingale", MARTINGALE), ("grid", GRID),
])
def test_same_inputs_same_output(strategy, params):
    prices = [100.0, 97.0, 91.0, 85.0, 88.0, 95.0, 102.0, 99.0, 90.0, 110.0] * 3
    a = backtest_single(strategy, "sETH", params, prices, 10_000.0)
    b = backtest_single(strategy, "sETH", params, prices, 10_000.0)
    assert list(a.equity) == list(b.equity) and a.fills == b.fills


# ── 持倉組合 ──────────────────────────────────────────────────────────────────

DAYS = [dt.date(2024, 10, 1) + dt.timedelta(days=i) for i in range(3)]


def test_plan_opens_splits_by_weight_and_reserves_the_open_fee():
    orders = plan_opens(1001.0, [("sETH", 0.5, True, 1), ("sBOND", 0.5, False, 2)])
    # 1001 / (1 + 0.5 × 0.001 + 0.5 × 2 × 0.001) → 每檔保證金約 499.75，合計花費剛好 1001
    assert sum(spend for _, spend, _, _ in orders) == pytest.approx(1001.0)
    assert [(a, is_long, lev) for a, _, is_long, lev in orders] == [("sETH", True, 1), ("sBOND", False, 2)]


def test_a_rebalance_closes_everything_then_opens_the_new_version():
    legs_a = (Leg("sETH", 5000, True, 1), Leg("sBOND", 5000, True, 1))
    legs_b = (Leg("sBOND", 10_000, False, 1),)
    step = rebalancer([Rebalance(DAYS[0], legs_a), Rebalance(DAYS[2], legs_b)], DAYS)
    bt = run({"sETH": [100.0, 110.0, 120.0], "sBOND": [100.0, 100.0, 100.0]}, step, 1000.0)
    assert [(f.day, f.asset, f.action) for f in bt.fills] == [
        (0, "sETH", "open"), (0, "sBOND", "open"),
        (2, "sETH", "close"), (2, "sBOND", "close"),
        (2, "sBOND", "open"),
    ]
    assert not bt.fills[-1].is_long


def test_portfolio_backtest_follows_the_shared_rules():
    index = [dt.date(2024, 9, 1) + dt.timedelta(days=i) for i in range(60)]
    prices = pd.DataFrame({
        "sETH": [100 * 1.01**i for i in range(60)],
        "sBOND": [100.0] * 60,
        "sGOLD": [100 * 0.99**i for i in range(60)],
    }, index=index)
    params = {"universe": ["sETH", "sBOND", "sGOLD"], "window": 10, "every_days": 7}
    bt = backtest_portfolio("trend", params, prices, dt.date(2024, 10, 1), 10_000.0)
    first = [f for f in bt.fills if f.day == 0]
    # 均線趨勢：在均線之上做多、之下做空
    assert {(f.asset, f.is_long) for f in first} == {("sETH", True), ("sBOND", True), ("sGOLD", False)}
    assert len(bt.equity) == 30


def test_buy_and_hold_benchmark_buys_once_and_never_trades_again():
    bt = backtest_hold({"sETH": [100.0, 120.0, 90.0]}, 1000.0)
    assert [f.day for f in bt.fills] == [0]
    assert bt.equity[1] == pytest.approx(1000 / 1.001 * (1.2 - 0.001))  # 平倉費是名目的 0.1%


# ── 指標 ─────────────────────────────────────────────────────────────────────


def test_metrics_report_the_same_fields_as_the_leaderboard():
    prices = [100.0, 89.0, 85.0, 80.0, 91.0, 99.0, 101.0]
    m = metrics(backtest_single("grid", "sETH", GRID, prices, 1000.0), 1000.0)
    assert set(m) == {"totalReturnPct", "maxDrawdownPct", "sharpe", "winRatePct", "closedTrades", "trades",
                      "riskScore"}
    assert (m["trades"], m["closedTrades"], m["winRatePct"]) == (4, 2, 100.0)
    assert m["riskScore"] is None  # 不到 30 個日報酬不打分


def test_metrics_without_any_close_have_no_win_rate():
    m = metrics(backtest_single("dca", "sETH", {"every_days": 1, "leverage": 1}, [100.0] * 5, 1000.0), 1000.0)
    assert m["winRatePct"] is None and m["closedTrades"] == 0 and m["trades"] == 5
