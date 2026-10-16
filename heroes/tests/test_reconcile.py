from herolab.reconcile import carbon_mismatch, expected_follower_counts, retired_tonnes


def test_every_scheduled_follow_counts_even_after_an_unfollow():
    # CopyTracker.followTrader 每跟隨一次就 push 一次 followersByTrader，取消不會移除：
    # getFollowerCount 是「跟隨過幾次」，所以取消過、又重新跟隨的都要算進去
    schedule = {"followers": [
        {"index": 40, "actions": [
            {"date": "2024-10-09", "type": "follow", "traderIndex": 10, "amountUsd": 1000},
            {"date": "2024-10-14", "type": "unfollow", "traderIndex": 10},
            {"date": "2024-10-20", "type": "follow", "traderIndex": 10, "amountUsd": 500},
        ]},
        {"index": 41, "actions": [{"date": "2024-10-10", "type": "follow", "traderIndex": 10, "amountUsd": 500}]},
        {"index": 42, "actions": [{"date": "2024-10-11", "type": "follow", "traderIndex": 31, "amountUsd": 500}]},
    ]}
    assert expected_follower_counts(schedule, [10, 13, 31]) == {10: 3, 13: 0, 31: 1}


def _retired(tonnes: str, block: int) -> dict:
    return {"name": "CarbonRetired", "block": block, "args": {"amount": "1", "tonnesCO2e": tonnes, "timestamp": "0"}}


def test_retired_tonnes_add_up_every_retirement_and_nothing_else():
    events = [
        _retired("150000000000000000", 10),
        {"name": "PlatformFeesSplit", "block": 10, "args": {"total": "6", "toCarbon": "1", "toTreasury": "5"}},
        _retired("15000000000000000", 20),
        {"name": "PositionClosed", "block": 21, "args": {"positionId": "1", "pnl": "0"}},
    ]
    assert retired_tonnes(events) == 165000000000000000
    # 鏈上的累計退役噸數相同：對得上
    assert carbon_mismatch({"events": events, "carbon": {"totalRetiredTonnes": "165000000000000000"}}) is None


def test_a_retirement_missing_from_the_export_is_a_mismatch():
    doc = {"events": [_retired("150000000000000000", 10)], "carbon": {"totalRetiredTonnes": "165000000000000000"}}
    assert "0.165" in carbon_mismatch(doc) and "0.15" in carbon_mismatch(doc)


def test_an_export_without_the_carbon_readback_is_a_mismatch():
    # #333 之前的回放沒有讀回鏈上的累計退役量：不能把「沒讀」當成「對得上」
    assert carbon_mismatch({"events": []}) is not None
