import datetime as dt
from fractions import Fraction

import pandas as pd
import pytest

from herolab.analytics import (
    Clock,
    build_outputs, build_trades, equity_curve, follower_history, max_drawdown_pct, monthly_returns, net_pnl,
    profitable_weeks_pct, risk_score, sharpe, top_assets, window_stats, worst_loss_pct,
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
    assert (index["schemaVersion"], index["chainId"], index["range"]) == (3, 31337, doc["range"])
    assert index["timeCompressed"] is False and details[OWNER.lower()]["timeCompressed"] is False
    summary = index["traders"][0]
    assert summary["address"] == OWNER and summary["totalReturnPct"] == 10.4
    # 排行榜用它判斷「交易了多久」、夠不夠資格列入排名，所以放在索引裡，不只在詳細檔
    assert summary["activeSince"] == "2024-10-01"
    assert summary["winRatePct"] == 100.0 and summary["closedTrades"] == 1
    # ESG：(53 × 5000 + 80 × 3000 + 81 × 2000) / 10000 = 66.7 → 67
    assert summary["esgScore"] == 67
    assert summary["sparkline"] == [999.0, 1049.0, 1104.0]
    detail = details[OWNER.lower()]
    assert detail["trades"][0]["pnlUsd"] == 104.0 and detail["trades"][0]["closePrice"] == 121.0
    assert detail["strategies"][0]["tx"] == "0xpub"
    assert detail["exposure"][0] == {"asset": "sETH", "weightPct": 50.0, "isLong": True, "leverage": 1}
    assert [p["equity"] for p in detail["equityCurve"]] == [999.0, 1049.0, 1104.0]
    assert detail["activeSince"] == "2024-10-01"
    assert detail["riskScore"] is None  # 只有 3 天
    assert detail["tradesPerWeek"] == 1.0
    assert detail["topAssets"] == [{"asset": "sETH", "trades": 1, "sharePct": 100.0}]
    assert detail["followerHistory"] == [{"month": "2024-10", "followers": 0}]
    assert detail["worstDayLossPct"] == 0.0 and detail["maxDrawdown1yPct"] == 0.0
    assert detail["profitableWeeksPct"] is None


def series(values):
    return pd.Series(values, index=[dt.date(2024, 10, 1) + dt.timedelta(days=i) for i in range(len(values))])


def test_risk_score_grades_the_one_day_95_percent_var():
    assert risk_score(series([100.0] * 40)) == 1  # 從不波動
    swings = [100.0]
    for i in range(60):
        swings.append(swings[-1] * (1.025 if i % 2 else 0.975))
    # 單日 95% VaR ≈ 2.5%：超過 0.25／0.5／1／1.5／2 五道門檻 → 6
    assert risk_score(series(swings)) == 6
    assert risk_score(series([100.0] * 20)) is None  # 不到 30 個日報酬，不打分


def test_worst_loss_is_reported_as_a_positive_loss():
    assert worst_loss_pct(series([100.0, 90.0, 99.0, 80.0]), 1) == pytest.approx(19.19, abs=0.01)
    assert worst_loss_pct(series([100.0, 90.0, 99.0, 80.0]), 2) == pytest.approx(11.11, abs=0.01)
    assert worst_loss_pct(series([100.0, 101.0, 102.0]), 1) == 0.0
    assert worst_loss_pct(series([100.0, 90.0]), 7) == 0.0  # 期間比資料長


def test_profitable_weeks_compare_every_seventh_day():
    values = [100.0] * 15
    values[7], values[14] = 110.0, 105.0  # 第一週 +10%、第二週 -4.5%
    assert profitable_weeks_pct(series(values)) == 50.0
    assert profitable_weeks_pct(series([100.0] * 5)) is None


def test_top_assets_rank_by_number_of_positions():
    trades = build_trades(
        [opened(1, D0, asset="sETH"), opened(2, D0, asset="sBTC"), opened(3, D0, asset="sETH")], OWNER
    )
    assert top_assets(trades) == [
        {"asset": "sETH", "trades": 2, "sharePct": 66.7},
        {"asset": "sBTC", "trades": 1, "sharePct": 33.3},
    ]


def test_follower_history_is_a_running_count_per_month():
    def follow(kind, ts):
        return {"name": kind, "block": 0, "logIndex": 0, "timestamp": ts, "tx": "0x",
                "args": {"follower": "0x1", "trader": OWNER}}
    nov = D0 + 31 * 86400
    events = [follow("TraderFollowed", D0), follow("TraderFollowed", D0 + 86400), follow("TraderUnfollowed", nov)]
    assert follower_history(events, OWNER.lower(), ["2024-10", "2024-11", "2024-12"]) == [
        {"month": "2024-10", "followers": 2}, {"month": "2024-11", "followers": 1}, {"month": "2024-12", "followers": 1},
    ]


# ── 時間壓縮（#344）：公開鏈上兩年在幾小時內跑完，區塊時間是回放當天 ─────────────────────
# 回放當天 2026-11-05 10:00 起，每個模擬日約 10 分鐘、30 個區塊；分析靠 days 還原模擬日期。
REPLAY_T0 = 1793872800  # 2026-11-05 10:00 UTC
COMPRESSED_DAYS = [
    {"date": "2024-10-01", "fromBlock": 100, "toBlock": 129, "toTimestamp": REPLAY_T0 + 600},
    {"date": "2024-10-02", "fromBlock": 130, "toBlock": 159, "toTimestamp": REPLAY_T0 + 1200},
    {"date": "2024-10-03", "fromBlock": 160, "toBlock": 189, "toTimestamp": REPLAY_T0 + 1800},
]


def at_block(event, block, ts):
    return {**event, "block": block, "timestamp": ts}


def compressed_doc(events):
    return {
        "schemaVersion": 2, "chainId": 84532, "range": {"from": "2024-10-01", "to": "2024-10-03"},
        "timeCompressed": True, "days": COMPRESSED_DAYS,
        "traders": [{"index": 10, "name": "Solo", "rule": "buy_hold", "address": OWNER, "capitalUsd": 1000,
                     "finalEquity": wei(1104.0), "followerCount": 0}],
        "events": events,
    }


PUBLISHED = {"name": "StrategyPublished", "logIndex": 0, "tx": "0xpub",
             "args": {"trader": OWNER, "versionId": "0", "legs": [
                 {"asset": "sETH", "weightBps": 5000, "isLong": True, "leverage": 1},
                 {"asset": "sBOND", "weightBps": 3000, "isLong": True, "leverage": 1},
                 {"asset": "sICLN", "weightBps": 2000, "isLong": True, "leverage": 1}]}}


def test_compressed_trades_take_the_simulated_date_from_the_block_not_the_block_time():
    events = [at_block(EVENTS[0], 105, REPLAY_T0 + 10), at_block(EVENTS[1], 170, REPLAY_T0 + 1210),
              at_block(PUBLISHED, 104, REPLAY_T0 + 8)]
    index, details = build_outputs(compressed_doc(events), PRICES)
    assert index["schemaVersion"] == 3 and index["timeCompressed"] is True
    detail = details[OWNER.lower()]
    assert detail["timeCompressed"] is True
    trade = detail["trades"][0]
    # 模擬日期來自區塊範圍；上鏈時間原樣保留（BaseScan 上看到的就是它）
    assert (trade["openDate"], trade["closeDate"]) == ("2024-10-01", "2024-10-03")
    assert (trade["openTime"], trade["closeTime"]) == (REPLAY_T0 + 10, REPLAY_T0 + 1210)
    assert trade["closePrice"] == 121.0, "closed at the simulated day's price"
    assert detail["strategies"][0] == {"date": "2024-10-01", "time": REPLAY_T0 + 8, "versionId": 0,
                                       "tx": "0xpub", "legs": PUBLISHED["args"]["legs"]}
    assert detail["activeSince"] == "2024-10-01"
    # 與本機回放（區塊時間就是模擬時間）算出同樣的績效
    assert [p["equity"] for p in detail["equityCurve"]] == [999.0, 1049.0, 1104.0]
    assert detail["avgHoldDays"] == 2.0


def test_compressed_open_positions_pay_borrow_fees_for_chain_time_only():
    # 2 倍、借款費 1 bps／時、一直沒平倉。本機回放兩天 = 48 小時的借款費；
    # 壓縮回放鏈上只過了 20 分鐘（不到 1 小時），與 getPositionValue 一樣是 0。
    lev = opened(1, REPLAY_T0 + 10, leverage=2, borrow_bps=1)
    lev = at_block(lev, 105, REPLAY_T0 + 10)
    clock = Clock.of(compressed_doc([lev]))
    equity = equity_curve(1000.0, build_trades([lev], OWNER, clock), prices([100.0] * 3), DAYS, clock)
    # 1000 − 500 − 開倉費 1 + (500 − 平倉費 1) = 998，借款費 0
    assert list(equity) == [998.0, 998.0, 998.0]

    local = opened(1, D0, leverage=2, borrow_bps=1)
    local_equity = equity_curve(1000.0, build_trades([local], OWNER), prices([100.0] * 3), DAYS)
    assert local_equity.iloc[-1] == pytest.approx(998.0 - 500 * 1 * 48 / 10_000)


def test_compressed_follows_count_toward_the_simulated_month():
    def follow(kind, block):
        return {"name": kind, "block": block, "logIndex": 0, "timestamp": REPLAY_T0, "tx": "0x",
                "args": {"follower": "0x1", "trader": OWNER}}
    clock = Clock.of({"timeCompressed": True, "days": COMPRESSED_DAYS})
    # 區塊時間全是 2026-11：用它分月的話兩筆都落在 2026-11
    history = follower_history([follow("TraderFollowed", 110), follow("TraderFollowed", 140)], OWNER.lower(),
                               ["2024-10", "2024-11"], clock)
    assert history == [{"month": "2024-10", "followers": 2}, {"month": "2024-11", "followers": 2}]


def test_compressed_clock_maps_setup_blocks_to_the_first_day_and_needs_the_block_ranges():
    clock = Clock.of({"timeCompressed": True, "days": COMPRESSED_DAYS})
    assert clock.sim_date({"block": 50, "timestamp": 0}) == dt.date(2024, 10, 1)  # 初始化階段
    assert clock.sim_date({"block": 159, "timestamp": 0}) == dt.date(2024, 10, 2)
    assert clock.sim_date({"block": 160, "timestamp": 0}) == dt.date(2024, 10, 3)
    assert clock.valuation_ts(dt.date(2024, 10, 2)) == REPLAY_T0 + 1200
    with pytest.raises(ValueError, match="block ranges"):
        Clock.of({"timeCompressed": True, "days": []})
    # 本機回放（沒有 timeCompressed）：一切照區塊時間，與 schema 2 時相同
    assert Clock.of({}).sim_date({"block": 1, "timestamp": D0}) == dt.date(2024, 10, 1)


def test_local_outputs_only_gain_fields():
    # 本機資料重新產生後只多欄位：模擬日期就是上鏈時間的日期
    doc = compressed_doc([EVENTS[0], EVENTS[1], {**PUBLISHED, "block": 0, "timestamp": D0}])
    doc.pop("timeCompressed")
    doc.pop("days")
    _, details = build_outputs(doc, PRICES)
    trade = details[OWNER.lower()]["trades"][0]
    assert trade["openTime"] == D0 and trade["openDate"] == "2024-10-01"
    assert trade["closeTime"] == D0 + 2 * 86400 and trade["closeDate"] == "2024-10-03"
    assert details[OWNER.lower()]["strategies"][0]["time"] == D0
